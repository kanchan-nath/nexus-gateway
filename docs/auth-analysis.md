# `src/auth.js` — Authentication Module Analysis

## 1. File Overview

`src/auth.js` is the authentication module of the Nexus gateway.

Its job is to determine whether an incoming HTTP request has valid credentials. It supports two authentication mechanisms:

1. **API Key authentication** — reads `X-API-Key` and compares it against configured API keys.
2. **HMAC Bearer Token authentication** — reads `Authorization: Bearer <token>`, verifies a custom HMAC-SHA256 token, and checks its expiry.

The module intentionally does **not** handle HTTP responses, status codes, or routing. This keeps authentication logic independent and unit-testable.

---

## 2. Architectural Role

Expected request flow:

```text
Incoming Request
       |
       v
Rate Limiter
       |
       v
authenticate(req, config)
       |
       +---- API Key valid ----> Authenticated
       |
       +---- HMAC token valid -> Authenticated
       |
       +---- Invalid/missing --> Not Authenticated
       |
       v
     server.js
       |
       +---- 401 if authentication failed
       |
       +---- Route matching / backend forwarding
```

Authentication should run **after rate limiting but before route matching or backend forwarding**. Rate limiting is cheaper than cryptographic work, so abusive traffic can be rejected first.

---

## 3. Dependency

The file imports only Node's built-in crypto module:

```js
import crypto from 'node:crypto';
```

It provides SHA-256 hashing, HMAC-SHA256 signatures, and constant-time comparison. This avoids external packages such as `jsonwebtoken` and supports Nexus's zero-dependency / **Package Killer** approach.

---

# 4. Authentication Methods

## 4.1 API Key

The client sends:

```http
X-API-Key: <secret-key>
```

The server compares the value against:

```js
config.auth.apiKeys
```

## 4.2 HMAC Bearer Token

The client sends:

```http
Authorization: Bearer <token>
```

This is **not a real JWT**. Nexus uses a deliberately simpler two-part format:

```text
base64url(JSON payload).base64url(HMAC-SHA256 signature)
```

A normal JWT has three sections:

```text
header.payload.signature
```

Nexus does not need a separate algorithm header because it only uses HMAC-SHA256.

---

# 5. `HMAC_ALGORITHM`

```js
const HMAC_ALGORITHM = 'sha256';
```

This constant makes SHA-256 the algorithm used consistently throughout the module.

It is used by:

- `safeStringCompare()`
- `createToken()`
- `verifyToken()`

---

# 6. `safeStringCompare(a, b)`

```js
function safeStringCompare(a, b) {
    const bufA = crypto.createHash(HMAC_ALGORITHM).update(String(a)).digest();
    const bufB = crypto.createHash(HMAC_ALGORITHM).update(String(b)).digest();
    return crypto.timingSafeEqual(bufA, bufB);
}
```

### Purpose

Safely compares two strings without directly using:

```js
a === b
```

Both strings are first SHA-256 hashed. SHA-256 always produces a 32-byte digest, so `timingSafeEqual()` can compare fixed-length buffers.

Conceptually:

```text
String A -> SHA-256 -> 32-byte digest --+
                                        |
                                 timingSafeEqual
                                        |
String B -> SHA-256 -> 32-byte digest --+
```

### Security note

`timingSafeEqual()` reduces timing side-channel leakage during the comparison. However, the complete lookup is not perfectly constant-time because `Array.prototype.some()` stops when a matching key is found. The source correctly acknowledges this limitation.

---

# 7. `checkApiKey(req, config)`

```js
export function checkApiKey(req, config)
```

Checks whether the request contains a configured API key.

### Step 1 — Read the header

```js
const providedKey = req.headers['x-api-key'];
```

Node normalizes incoming header names to lowercase.

### Step 2 — Reject missing/non-string values

```js
if (!providedKey || typeof providedKey !== 'string') return false;
```

### Step 3 — Read configured keys

```js
const validKeys = config.auth.apiKeys || [];
```

### Step 4 — Compare

```js
return validKeys.some((validKey) => safeStringCompare(providedKey, validKey));
```

It returns `true` when any configured key matches and `false` otherwise.

---

# 8. `createToken(payload, config, expiresInSeconds)`

```js
export function createToken(payload, config, expiresInSeconds = 3600)
```

Creates a custom HMAC-signed token. The default lifetime is **3600 seconds (1 hour)**.

## 8.1 Read HMAC secret

```js
const secret = config.auth?.hmac?.secret;
```

If the secret is missing, the function throws. This is fail-closed behavior.

## 8.2 Create timestamps

```js
const nowSeconds = Math.floor(Date.now() / 1000);
```

The payload receives:

- `iat` — issued-at timestamp
- `exp` — expiration timestamp

## 8.3 Build payload

```js
const fullPayload = {
    ...payload,
    iat: nowSeconds,
    exp: nowSeconds + expiresInSeconds,
};
```

For example, `{ sub: 'demo' }` becomes conceptually:

```json
{
  "sub": "demo",
  "iat": 1720000000,
  "exp": 1720003600
}
```

## 8.4 Encode payload

```js
const payloadB64 = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
```

Flow:

```text
Object -> JSON -> UTF-8 -> Base64URL
```

## 8.5 Generate signature

```js
const signature = crypto.createHmac(HMAC_ALGORITHM, secret).update(payloadB64).digest();
```

The server secret signs the encoded payload using HMAC-SHA256.

The signature is then Base64URL encoded and combined with the payload:

```js
return `${payloadB64}.${signatureB64}`;
```

Final structure:

```text
payload.signature
```

---

# 9. `verifyToken(token, config)`

```js
export function verifyToken(token, config)
```

Validates an HMAC token. It returns the decoded payload if valid, otherwise `null`.

It performs three important checks:

1. Token structure
2. Cryptographic signature
3. Expiration

## 9.1 Validate secret and input

```js
if (!secret || typeof token !== 'string') return null;
```

## 9.2 Validate token structure

```js
const parts = token.split('.');
if (parts.length !== 2) return null;
```

Only `payload.signature` is accepted.

## 9.3 Recalculate expected signature

```js
const expectedSignature = crypto
    .createHmac(HMAC_ALGORITHM, secret)
    .update(payloadB64)
    .digest();
```

The server independently calculates the signature using its secret.

## 9.4 Decode provided signature

```js
providedSignature = Buffer.from(signatureB64, 'base64url');
```

Malformed Base64URL input is rejected.

## 9.5 Compare signatures safely

```js
if (providedSignature.length !== expectedSignature.length) return null;
if (!crypto.timingSafeEqual(providedSignature, expectedSignature)) return null;
```

This prevents a normal string comparison from being used for cryptographic verification.

## 9.6 Parse payload only after signature verification

```js
payload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8')
);
```

This ordering is important: the code verifies authenticity before trusting/parsing the payload.

## 9.7 Check expiry

```js
const nowSeconds = Math.floor(Date.now() / 1000);
if (typeof payload.exp === 'number' && nowSeconds > payload.exp) {
    return null;
}
```

Expired tokens are rejected.

---

# 10. `authenticate(req, config)`

```js
export function authenticate(req, config)
```

This is the **main entry point** that `server.js` should call.

## Step 1 — Authentication disabled

```js
if (!config.auth?.required) {
    return { authenticated: true, method: 'none' };
}
```

If authentication is optional/disabled, every request is treated as authenticated.

## Step 2 — Check API key first

```js
if (checkApiKey(req, config)) {
    return { authenticated: true, method: 'apiKey' };
}
```

API key authentication is attempted first.

## Step 3 — Try HMAC Bearer token

Only when HMAC is enabled:

```js
if (config.auth.hmac?.enabled)
```

The code reads:

```js
req.headers['authorization']
```

and requires:

```text
Bearer <token>
```

Then it extracts and verifies the token. If valid, it returns:

```js
{
    authenticated: true,
    method: 'hmac',
    payload
}
```

The payload is exposed so downstream code can use claims such as `sub`.

## Step 4 — Reject

If neither method succeeds:

```js
{
    authenticated: false,
    method: null,
    reason: 'missing or invalid credentials ...'
}
```

The function does **not** send a 401 response. `server.js` is responsible for that.

---

# 11. Return Values

| Situation | `authenticated` | `method` | Extra data |
|---|---:|---|---|
| Auth disabled | `true` | `none` | — |
| Valid API key | `true` | `apiKey` | — |
| Valid HMAC token | `true` | `hmac` | `payload` |
| Invalid/missing credentials | `false` | `null` | `reason` |

This predictable structure makes integration with `server.js` simple.

---

# 12. Complete Authentication Flow

```text
                 Incoming Request
                        |
                        v
              Is auth.required false?
                    /          \\
                  YES           NO
                   |             |
                   v             v
              Authenticated   Check API Key
              method=none          |
                              Valid? ---- YES ---> Authenticated
                                |
                                NO
                                |
                                v
                         Is HMAC enabled?
                           /          \\
                         NO            YES
                         |              |
                         |              v
                         |       Authorization header?
                         |              |
                         |              v
                         |        Bearer token?
                         |              |
                         |              v
                         |        verifyToken()
                         |              |
                         |        Valid? ---- YES ---> Authenticated
                         |              |
                         +--------------+
                                        |
                                        v
                               Authentication Failed
```

---

# 13. Security Design

### Timing-safe API key comparison

Instead of direct equality, both keys are hashed and compared using `timingSafeEqual()`.

### Timing-safe HMAC comparison

The HMAC signature is also compared using `timingSafeEqual()`.

### Token expiration

Tokens contain `iat` and `exp`, preventing a token from remaining valid forever.

### Secret protection

The HMAC secret is used to calculate signatures but is never placed inside the token payload.

### Fail-closed secret handling

Missing HMAC configuration causes token creation to throw and token verification to fail rather than silently accepting insecure values.

---

# 14. Why a Custom Token Instead of JWT?

Normal JWT:

```text
header.payload.signature
```

Nexus custom token:

```text
payload.signature
```

The project only needs a JSON payload, an HMAC-SHA256 signature, and expiry. The custom format removes the extra JWT header and external JWT dependency.

This is a deliberate engineering trade-off and part of the project's zero-dependency design.

---

# 15. Separation of Concerns

`auth.js` deliberately avoids code such as:

```js
res.writeHead(401);
res.end();
```

Instead, it only determines whether authentication succeeded.

```text
auth.js
   |
   | authentication decision
   v
server.js
   |
   | HTTP response / status code
   v
401 Unauthorized
```

This makes the authentication functions easier to unit-test independently.

---

# 16. Integration With Other Files

## `server.js`

Should call:

```js
authenticate(req, config)
```

after rate limiting and before route matching/forwarding. If authentication fails, it should return HTTP `401` and stop processing.

## `config.js`

Supplies values such as:

```text
config.auth.required
config.auth.apiKeys
config.auth.hmac.enabled
config.auth.hmac.secret
```

The configuration also supports environment-variable overrides such as `NEXUS_API_KEYS` and `NEXUS_HMAC_SECRET`.

## `cli.js`

A future CLI command can call `createToken()` so a developer can generate a Bearer token for demos/tests without directly writing JavaScript.

Example planned interface:

```bash
node cli.js token create --sub demo --ttl 3600
```

## `metrics.js`

Should track authentication failures, for example with an `authFailures` counter. `auth.js` remains independent from the metrics layer.

## `dashboard.js`

Can expose authentication failure statistics through the metrics layer.

## `wal.js`

Could optionally log rejected authentication attempts for auditing. Logs should contain useful metadata such as IP and reason, but **never the submitted API key or token**.

## `test/auth.test.js`

Should test authentication independently, including valid credentials, invalid credentials, expiry, tampering, and configuration behavior.

---

# 17. Recommended Test Cases

## API Key

- Valid API key
- Invalid API key
- Missing API key
- Empty API key
- Multiple configured API keys
- Authentication disabled

## HMAC Token

- Valid token
- Expired token
- Tampered payload
- Tampered signature
- Malformed token
- Missing token
- Wrong secret
- HMAC disabled
- Missing HMAC secret

## Combined Authentication

- Valid API key when HMAC is disabled
- Valid HMAC token when API key is invalid
- API key takes priority when both credentials are supplied
- Both credentials invalid
- Authentication required vs optional

---

# 18. Potential Improvements / Things to Watch

## 18.1 Expiration boundary

The current check is:

```js
nowSeconds > payload.exp
```

If the exact `exp` second should be considered invalid, a stricter check would be:

```js
nowSeconds >= payload.exp
```

The difference is only one second, but it matters when writing precise tests.

## 18.2 `exp` is optional during verification

`verifyToken()` only checks expiry when `payload.exp` is numeric. Therefore, a correctly signed token without `exp` can still be accepted.

If every authentication token must expire, the verifier could require a numeric `exp` before accepting the token.

## 18.3 Bearer prefix is case-sensitive

The code checks:

```js
authHeader.startsWith('Bearer ')
```

So `Bearer` must have that exact capitalization. `bearer <token>` will not be accepted.

## 18.4 Multiple API-key timing behavior

Individual comparisons are timing-safe, but `some()` stops after a match. Therefore, the complete multi-key lookup is not perfectly constant-time.

For the project's hackathon scope, the existing implementation is reasonable and the limitation is already documented honestly in the source.

---

# 19. Code Structure

The module is layered cleanly:

```text
safeStringCompare()
        |
        v
checkApiKey()

createToken() <---- token creation
verifyToken() <---- token verification
        |
        v
authenticate() <---- combined authentication entry point
```

The lower-level functions can be tested independently, while `authenticate()` provides the simple interface needed by `server.js`.

---

# 20. Quick Reference

| Function | Purpose | Return value |
|---|---|---|
| `safeStringCompare()` | Securely compare strings | `boolean` |
| `checkApiKey()` | Validate `X-API-Key` | `boolean` |
| `createToken()` | Create HMAC token | `string` |
| `verifyToken()` | Validate HMAC token | `object` / `null` |
| `authenticate()` | Main authentication decision | Authentication result object |

---

# 21. Final Summary

`src/auth.js` is Nexus's standalone authentication engine.

It provides:

```text
X-API-Key
     +
Authorization: Bearer <custom HMAC token>
```

The API-key mechanism hashes values with SHA-256 and uses `crypto.timingSafeEqual()` for comparison. The HMAC mechanism creates and verifies:

```text
base64url(payload).base64url(HMAC-SHA256 signature)
```

and includes `iat` and `exp` for token lifetime management.

The most important architectural decision is that this module **does not handle HTTP directly**. It answers:

> **Is this request authenticated, and if so, by which method?**

`server.js` is responsible for converting that decision into an HTTP response and continuing the request-processing pipeline.

Overall, `src/auth.js` is a **dependency-free, testable authentication layer** with API-key and HMAC-token support, while keeping cryptographic authentication logic separate from HTTP/server responsibilities.
