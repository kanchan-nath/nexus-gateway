/**
 * src/auth.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Authentication for Nexus. Supports two methods, both togglable via
 *   config.auth:
 *
 *     1. API key  — a static secret sent in the `X-API-Key` header,
 *                   checked against config.auth.apiKeys.
 *     2. HMAC token — a "JWT-style" signed token (NOT actual JWT format,
 *                   deliberately simpler) sent as `Authorization: Bearer
 *                   <token>`, verified with crypto.createHmac.
 *
 *   Owner: Ashish
 *   Zero-dep substitution: `crypto.createHmac` (HMAC-SHA256) + Buffer's
 *   built-in base64url encoding replace `jsonwebtoken` / `bcrypt`. This
 *   is the "Package Killer" bonus target from the judging criteria.
 *
 * CURRENT SCOPE (Phase 3 — Hours 30-50, "Advanced Features")
 *   This file only implements the authentication logic itself — token
 *   creation, token verification, and API key checking. It does NOT
 *   touch HTTP directly (no req/res status codes here), same separation
 *   of concerns as ratelimiter.js: keeps this unit-testable in isolation
 *   (see test/auth.test.js) and keeps HTTP wiring inside server.js.
 *
 * TOKEN FORMAT (custom, not real JWT — that's the point of "zero-dep")
 *   `<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`
 *   Real JWT has a 3-part header.payload.signature structure supporting
 *   multiple algorithms; we only ever use HMAC-SHA256, so the algorithm
 *   is implicit and there's no separate header segment — 2 parts instead
 *   of 3. Payload always carries `iat` (issued-at) and `exp` (expiry)
 *   unix-second timestamps so tokens can't be replayed forever.
 *
 * SECURITY NOTES
 *   - Signature verification uses crypto.timingSafeEqual (not `===`) to
 *     avoid timing side-channel attacks on the signature comparison.
 *   - API key comparison hashes both sides with SHA-256 first, then uses
 *     timingSafeEqual on the fixed-length digests. This avoids leaking
 *     key length/content through comparison timing, and sidesteps the
 *     fact that timingSafeEqual throws on mismatched-length buffers.
 *   - Neither of these is bulletproof (e.g. `.some()` still short-circuits
 *     across *which* key matched) — good enough for hackathon scope, but
 *     flagged here honestly rather than oversold as bulletproof crypto.
 *
 * -----------------------------------------------------------------------
 * FUTURE INTEGRATION — what still needs to change elsewhere
 * -----------------------------------------------------------------------
 *   1. server.js (Phase 3 — do this right after this file):
 *        - Import `authenticate` from this file.
 *        - In createRequestHandler(), AFTER the rate limiter check but
 *          BEFORE matchRoute()/forwardRequest(), call
 *          authenticate(req, config). If `!result.authenticated`, respond
 *          401 with a `WWW-Authenticate: ApiKey, Bearer` header and stop.
 *          This matches the TODO already left in server.js:
 *              // TODO (Phase 3): auth check here -> 401/403 if invalid/missing
 *        - Rate limiting should still run FIRST (cheap check before any
 *          crypto work) — see the note already left in ratelimiter.js.
 *
 *   2. cli.js (Phase 3/4, owner: Kanchan/Ashish):
 *        - There is currently NO way to mint an HMAC token except by
 *          calling createToken() directly from code/tests. Add a CLI
 *          utility subcommand, e.g. `node cli.js token create --sub demo
 *          --ttl 3600`, that loads config, calls createToken() from this
 *          file, and prints the token — needed for the demo video to
 *          show a working Bearer-token request.
 *
 *   3. metrics.js (Phase 3, owner: Saikat):
 *        - Should track an authFailures counter, incremented by server.js
 *          whenever authenticate() returns { authenticated: false }.
 *          This file stays dependency-free and does not call into
 *          metrics.js directly — server.js glues them together.
 *
 *   4. dashboard.js (Phase 3, owner: Biyas):
 *        - Live dashboard should surface auth failure rate alongside
 *          rate-limit stats, reading from metrics.js once that exists.
 *
 *   5. wal.js (Phase 3, owner: Kanchan):
 *        - Consider logging rejected auth attempts (IP + reason, NEVER
 *          the submitted key/token itself) to the WAL for an audit
 *          trail. Not required for MVP — note left for if time allows.
 *
 *   6. config.js (already implemented):
 *        - Already validates and defaults config.auth (required, apiKeys,
 *          hmac.enabled, hmac.secret) and supports NEXUS_API_KEYS /
 *          NEXUS_HMAC_SECRET env var overrides. No changes needed there.
 *          Just make sure whoever runs the demo actually sets
 *          NEXUS_HMAC_SECRET (or config.auth.hmac.secret) to something
 *          non-empty, or HMAC token auth will always fail closed (by
 *          design — see createToken()/verifyToken() guard clauses below).
 *
 *   7. test/auth.test.js (owner: Biyas, Ashish helps if stuck):
 *        - Exercise: valid API key, invalid API key, valid HMAC token,
 *          expired HMAC token, tampered signature, missing credentials
 *          with config.auth.required = true/false.
 * -----------------------------------------------------------------------
 */

import crypto from 'node:crypto';

const HMAC_ALGORITHM = 'sha256';

// -------------------------------------------------------------------------
// API key authentication
// -------------------------------------------------------------------------

/**
 * Constant-time-ish string comparison: hash both values first so we're
 * always comparing two fixed-length (32-byte) buffers with
 * crypto.timingSafeEqual, regardless of the original strings' lengths.
 */
function safeStringCompare(a, b) {
    const bufA = crypto.createHash(HMAC_ALGORITHM).update(String(a)).digest();
    const bufB = crypto.createHash(HMAC_ALGORITHM).update(String(b)).digest();
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check the `X-API-Key` header against config.auth.apiKeys.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} config - full Nexus config (uses config.auth.apiKeys)
 * @returns {boolean}
 */
export function checkApiKey(req, config) {
    const providedKey = req.headers['x-api-key'];
    if (!providedKey || typeof providedKey !== 'string') return false;

    const validKeys = config.auth.apiKeys || [];
    return validKeys.some((validKey) => safeStringCompare(providedKey, validKey));
}

// -------------------------------------------------------------------------
// HMAC signed-token authentication ("Package Killer" — replaces jsonwebtoken)
// -------------------------------------------------------------------------

/**
 * Create a signed HMAC token carrying `payload`, expiring in
 * `expiresInSeconds` from now. Intended for demo/testing use (e.g. via a
 * future cli.js `token create` command — see FUTURE INTEGRATION above).
 *
 * @param {object} payload - arbitrary claims to embed (e.g. { sub: 'demo' })
 * @param {object} config - full Nexus config (uses config.auth.hmac.secret)
 * @param {number} [expiresInSeconds=3600]
 * @returns {string} token in `<payload>.<signature>` base64url form
 */
export function createToken(payload, config, expiresInSeconds = 3600) {
    const secret = config.auth?.hmac?.secret;
    if (!secret) {
        throw new Error('createToken: config.auth.hmac.secret is not set (see NEXUS_HMAC_SECRET)');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const fullPayload = {
        ...payload,
        iat: nowSeconds,
        exp: nowSeconds + expiresInSeconds,
    };

    const payloadB64 = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
    const signature = crypto.createHmac(HMAC_ALGORITHM, secret).update(payloadB64).digest();
    const signatureB64 = signature.toString('base64url');

    return `${payloadB64}.${signatureB64}`;
}

/**
 * Verify a token's signature and expiry.
 *
 * @param {string} token
 * @param {object} config - full Nexus config (uses config.auth.hmac.secret)
 * @returns {object|null} the decoded payload if valid, otherwise null
 */
export function verifyToken(token, config) {
    const secret = config.auth?.hmac?.secret;
    if (!secret || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null; // malformed — not our token format
    const [payloadB64, signatureB64] = parts;

    // Recompute the expected signature and compare in constant time.
    const expectedSignature = crypto.createHmac(HMAC_ALGORITHM, secret).update(payloadB64).digest();
    let providedSignature;
    try {
        providedSignature = Buffer.from(signatureB64, 'base64url');
    } catch {
        return null; // not valid base64url
    }

    if (providedSignature.length !== expectedSignature.length) return null;
    if (!crypto.timingSafeEqual(providedSignature, expectedSignature)) return null;

    // Signature checks out — safe to trust and parse the payload now.
    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return null; // corrupted payload despite valid signature (shouldn't happen)
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && nowSeconds > payload.exp) {
        return null; // expired
    }

    return payload;
}

// -------------------------------------------------------------------------
// Combined entry point — this is what server.js should call
// -------------------------------------------------------------------------

/**
 * Decide whether a request is authenticated, trying API key first (cheap
 * string comparison) and falling back to HMAC bearer token if enabled.
 *
 * If config.auth.required is false, every request is treated as
 * authenticated — auth is opt-in per the config, matching config.js's
 * validation (auth.required can only be true if at least one method is
 * actually configured).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object} config - full Nexus config
 * @returns {{ authenticated: boolean, method: ('none'|'apiKey'|'hmac'|null), payload?: object, reason?: string }}
 */
export function authenticate(req, config) {
    if (!config.auth?.required) {
        return { authenticated: true, method: 'none' };
    }

    if (checkApiKey(req, config)) {
        return { authenticated: true, method: 'apiKey' };
    }

    if (config.auth.hmac?.enabled) {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.slice('Bearer '.length);
            const payload = verifyToken(token, config);
            if (payload) {
                return { authenticated: true, method: 'hmac', payload };
            }
        }
    }

    return {
        authenticated: false,
        method: null,
        reason: 'missing or invalid credentials (expected X-API-Key or Authorization: Bearer <token>)',
    };
}