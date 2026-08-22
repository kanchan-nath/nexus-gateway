# Nexus — `src/tls.js` Explanation

## 1. Purpose

`src/tls.js` is the **TLS/HTTPS layer of the Nexus reverse proxy**.

Its main responsibility is to:

- Create and configure an HTTPS server.
- Generate a self-signed certificate and private key if they do not already exist.
- Load the certificate and key into memory.
- Pass HTTPS requests into the **same Nexus request-processing pipeline** used by the normal HTTP server.
- Reuse the existing routing, load balancing, authentication, rate limiting, WAL, and metrics infrastructure instead of duplicating that logic.

In short:

> **`tls.js` provides HTTPS/TLS support for Nexus; it is a transport-layer wrapper around the existing reverse-proxy pipeline, not a second reverse-proxy implementation.**

---

## 2. Where It Fits in Nexus

A simplified Nexus flow is:

```text
                    CLIENT
                      |
             +--------+--------+
             |                 |
          HTTP :8080       HTTPS :8443
             |                 |
             |            +----v----+
             |            | tls.js  |
             |            | TLS     |
             |            +----+----+
             |                 |
             +--------+--------+
                      |
                      v
              Nexus Request Handler
                      |
        +-------------+-------------+
        |             |             |
       Auth       Rate Limit    Routing/LB
        |             |             |
        +-------------+-------------+
                      |
                      v
                   Backend
```

The important idea is that HTTP and HTTPS eventually use the **same request pipeline**.

---

## 3. Why TLS Is Needed

HTTPS adds encryption between the client and Nexus.

Instead of:

```text
Client ---- HTTP ----> Nexus
```

the client can use:

```text
Client ---- HTTPS ----> Nexus
```

For HTTPS, Nexus needs:

- A certificate
- A private key

This file manages both.

---

## 4. Certificate Generation

If the certificate and key are missing, `tls.js` generates a **self-signed RSA-2048 certificate** using the system's `openssl` command.

The certificate is configured for:

- **RSA:** 2048-bit
- **Validity:** 365 days
- **Subject:** `CN=localhost`

The constants are:

```js
const CERT_VALID_DAYS = 365;
const CERT_SUBJECT = '/CN=localhost';
```

### Why OpenSSL instead of implementing certificates in JavaScript?

Node's built-in `crypto` module can generate cryptographic key pairs, but creating a valid X.509 certificate manually requires complicated DER/ASN.1 handling.

Therefore, the project deliberately uses a **one-time system `openssl` command** for certificate generation.

Important:

> OpenSSL is a system tool, not an npm dependency, so it does not need to be added to `package.json`.

Once generated, Nexus only loads and serves the certificate at runtime.

---

## 5. `isOpensslAvailable()`

This function checks whether OpenSSL is available on the machine.

Conceptually:

```text
Is OpenSSL available?
       |
   +---+---+
   |       |
  YES      NO
   |       |
Continue   Clear error
```

It runs:

```js
execFileSync('openssl', ['version'])
```

If the command succeeds, it returns `true`.

If it fails, it returns `false`.

This gives Nexus a clear setup error instead of an unclear process-spawning error.

---

## 6. `generateSelfSignedCert()`

This function performs the actual certificate generation.

It first checks whether OpenSSL exists.

If OpenSSL is missing, it throws an error containing the exact command that can be run manually.

The generated files are:

```text
Private Key  -> key file
Certificate  -> certificate file
```

The OpenSSL operation uses:

```text
RSA 2048
Self-signed certificate
365 days validity
localhost subject
No passphrase
```

The `-nodes` option means the private key does not have a passphrase.

That is intentional because Nexus needs to be able to read the private key automatically during server startup without asking a human for a password.

---

## 7. `ensureCertExists()`

This function makes sure the configured certificate and private key exist.

It reads the paths from:

```js
config.tls.cert
config.tls.key
```

The logic is:

```text
Certificate exists?
        |
        +---- YES ----+
        |             |
Key exists?           |
        |             |
        +---- YES ----+
              |
            Return

If either is missing:
              |
              v
       Generate certificate
```

### Important safety check

If only one of the two files exists:

```text
certificate exists
key missing
```

or:

```text
key exists
certificate missing
```

the function **does not silently overwrite anything**.

Instead, it throws an error and asks for the incomplete setup to be fixed.

This prevents accidental loss of an existing certificate/key.

---

## 8. `loadTlsOptions()`

Once the certificate and key exist, `loadTlsOptions()` reads them from disk.

It returns:

```js
{
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
}
```

This object is then supplied to Node's HTTPS server.

Conceptually:

```text
certificate file ----+
                     |
                     +----> tlsOptions
                     |
private key file ----+
```

---

## 9. `createTLSServer()`

This is the main function of the file.

Its job is to create the Nexus HTTPS server.

The overall sequence is:

```text
createTLSServer()
       |
       +--> ensureCertExists()
       |
       +--> loadTlsOptions()
       |
       +--> obtain request context
       |
       +--> https.createServer()
       |
       +--> return HTTPS server
```

The actual HTTPS server is created using:

```js
https.createServer(tlsOptions, ctx.requestHandler)
```

The second argument is extremely important.

It is the **existing Nexus request handler**.

Therefore, `tls.js` does not implement separate routing logic for HTTPS.

---

## 10. Same Request Pipeline

The design intentionally makes HTTPS use the same processing pipeline as HTTP.

Conceptually:

```text
                 HTTP
                  |
                  v
            Request Handler
                  ^
                  |
                HTTPS
                  |
               tls.js
```

The shared request pipeline can contain:

- Routing
- Load balancing
- Authentication
- Rate limiting
- WAL
- Metrics
- Backend handling

So the project avoids having:

```text
HTTP logic
+
separate HTTPS logic
```

Instead, it has:

```text
HTTP
     ---> Same Nexus pipeline
  /
HTTPS
```

This is cleaner and avoids duplicated gateway logic.

---

## 11. Connection With `server.js`

`tls.js` imports:

```js
import { createRequestContext } from './server.js';
```

This allows the HTTPS server to use the same type of request context used by the normal Nexus server.

The important architectural relationship is:

```text
tls.js
   |
   +----> server.js
```

The design notes explicitly indicate that this is **not circular**, because `server.js` does not import `tls.js`.

---

## 12. What Is `sharedContext`?

`createTLSServer()` accepts an optional third argument:

```js
createTLSServer(config, logger, sharedContext)
```

The `sharedContext` can contain:

```text
requestHandler
logger
metrics
loadBalancer
healthChecker
wal
rateLimiter
```

This allows an existing HTTP server and the HTTPS server to share the same Nexus infrastructure.

### Without shared context

If HTTP and HTTPS both create their own contexts:

```text
HTTP
 |
 +-- healthChecker #1
 +-- WAL #1
 +-- rateLimiter #1

HTTPS
 |
 +-- healthChecker #2
 +-- WAL #2
 +-- rateLimiter #2
```

This can cause unnecessary duplicate background workers.

In particular, there could be:

- Two health-check pollers hitting the same backends.
- Two WAL writers potentially accessing the same `wal.log`.

### With shared context

The preferred architecture is:

```text
                 +--> HTTP :8080
                 |
Shared Context --+
                 |
                 +--> HTTPS :8443
```

Both listeners use the same:

- Health checker
- WAL
- Rate limiter
- Load balancer
- Metrics
- Request handler

This is more efficient and consistent.

---

## 13. What Happens If HTTPS Is the Only Listener?

If Nexus is running only HTTPS and there is no HTTP server to share context with, `createTLSServer()` can create its own request context.

That is valid because there is no second listener creating duplicate workers.

So:

```text
HTTPS only
   |
   v
createTLSServer()
   |
   v
createRequestContext()
   |
   v
HTTPS server
```

is perfectly acceptable.

---

## 14. Why Server Properties Are Copied

After creating the HTTPS server, the code attaches the same important properties that the normal Nexus server exposes:

```js
server.logger = ctx.logger;
server.metrics = ctx.metrics;
server.loadBalancer = ctx.loadBalancer;
server.healthChecker = ctx.healthChecker;
server.wal = ctx.wal;
server.rateLimiter = ctx.rateLimiter;
server.requestHandler = ctx.requestHandler;
```

The reason is consistency.

Code such as `cli.js` can interact with either server using the same property names.

Conceptually:

```text
HTTP Server
    |
    +-- logger
    +-- metrics
    +-- loadBalancer
    +-- healthChecker
    +-- wal
    +-- rateLimiter
    +-- requestHandler


HTTPS Server
    |
    +-- logger
    +-- metrics
    +-- loadBalancer
    +-- healthChecker
    +-- wal
    +-- rateLimiter
    +-- requestHandler
```

---

## 15. Important Functions Summary

| Function | Main Responsibility |
|---|---|
| `isOpensslAvailable()` | Checks whether OpenSSL is installed |
| `generateSelfSignedCert()` | Generates the self-signed certificate and private key |
| `ensureCertExists()` | Makes sure certificate + key exist |
| `loadTlsOptions()` | Loads certificate and key into memory |
| `createTLSServer()` | Creates the Nexus HTTPS server |

---

## 16. Important Dependencies

This file intentionally uses Node's built-in modules:

```js
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
```

It also imports Nexus's own request-context function:

```js
import { createRequestContext } from './server.js';
```

So TLS support does not require an additional npm TLS middleware package.

---

## 17. Integration With Other Project Files

The file itself mentions several future integration points.

### `cli.js`

`cli.js` should preferably pass the existing HTTP server as the `sharedContext` when creating the HTTPS server.

The intended idea is:

```js
const httpServer = servers[0];

const httpsServer = createTLSServer(
    config,
    httpServer?.logger,
    httpServer
);
```

This allows HTTP and HTTPS to share the same infrastructure.

---

### `build.sh`

The build/startup process should ensure that the certificate gets generated when needed.

It can either:

1. Generate the certificate before startup, or
2. Allow the normal Nexus startup path to generate it lazily.

---

### `README.md`

The README should mention that:

```text
OpenSSL must be available on PATH
```

for automatic self-signed certificate generation.

It should also clarify that OpenSSL is a **system dependency/tool**, not an npm dependency.

---

### `STDLIB.md`

The project can document the design as:

```text
Normally:
selfsigned / mkcert npm packages

Nexus:
one-time system openssl call
+
node:tls / node:https at runtime
```

---

### `.gitignore`

The generated certificate/private-key directory, normally:

```text
./certs/
```

should be ignored by Git.

Especially the private key should **never be committed to the repository**.

---

## 18. Complete Mental Model

The easiest way to remember this file is:

```text
                 CLIENT
                    |
            HTTP or HTTPS
                    |
          +---------+---------+
          |                   |
       HTTP Server        tls.js
          |                   |
          |             TLS termination
          |                   |
          +---------+---------+
                    |
                    v
           Nexus Request Handler
                    |
          +---------+---------+
          |         |         |
        Auth      Rate      Routing
                  Limit     + Load Balancing
                              |
                    +---------+---------+
                    |                   |
                   WAL              Metrics
                    |
                    v
                 BACKEND
```

### One-line explanation

> **`src/tls.js` handles TLS termination and HTTPS server creation for Nexus, automatically manages a development self-signed certificate, and feeds decrypted HTTPS requests into the same reverse-proxy pipeline used by HTTP.**
