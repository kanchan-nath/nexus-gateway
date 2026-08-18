/**
 * test/auth.test.js
 * -----------------------------------------------------------------------
 * PLACEHOLDER — src/auth.js has not been implemented yet.
 *
 * Owner of auth.js: Ashish
 * Owner of this test file: Biyas, with Ashish helping if stuck (per file
 * table) — Saikat scaffolded it as a starting point so `node --test`
 * still passes cleanly today instead of failing on an import of a file
 * that doesn't exist yet.
 *
 * TODO(Biyas/Ashish): once src/auth.js exports its API-key check and
 * HMAC signed-token check (per the Phase 3 plan — this is the "Package
 * Killer" bonus, replacing jsonwebtoken with crypto.createHmac), do the
 * following:
 *   1. Uncomment the import below.
 *   2. Replace each test.skip(...) with test(...) and fill in real
 *      assertions against your actual auth.js signature.
 *   3. Remove this placeholder header once real tests are in place.
 *
 * Suggested cases to cover, per nexus.config.json's auth shape
 * ({ "required": true, "apiKeys": ["demo-key-123"] }):
 *   - valid x-api-key header against config.auth.apiKeys -> allowed
 *   - missing x-api-key header when auth.required is true -> 401
 *   - wrong/unknown x-api-key -> 401
 *   - auth.required: false -> requests pass through with no key at all
 *   - valid HMAC-signed token -> allowed
 *   - tampered/invalid HMAC signature -> rejected
 * -----------------------------------------------------------------------
 */

import { test, describe } from 'node:test';

// import { checkAuth } from '../src/auth.js';

describe('auth.js - API key check (PLACEHOLDER, not yet implemented)', () => {
    test.skip('TODO(Ashish): valid x-api-key in config.auth.apiKeys is allowed', () => {
        // const config = { auth: { required: true, apiKeys: ['demo-key-123'] } };
        // const req = { headers: { 'x-api-key': 'demo-key-123' } };
        // assert.equal(checkAuth(req, config), true);
    });

    test.skip('TODO(Ashish): missing x-api-key when auth.required is true is rejected', () => {
        // const config = { auth: { required: true, apiKeys: ['demo-key-123'] } };
        // const req = { headers: {} };
        // assert.equal(checkAuth(req, config), false);
    });

    test.skip('TODO(Ashish): unknown x-api-key is rejected', () => {
        // const req = { headers: { 'x-api-key': 'not-a-real-key' } };
    });

    test.skip('TODO(Ashish): auth.required: false allows requests through with no key', () => {
        // const config = { auth: { required: false, apiKeys: [] } };
        // const req = { headers: {} };
        // assert.equal(checkAuth(req, config), true);
    });
});

describe('auth.js - HMAC signed token check (PLACEHOLDER, not yet implemented)', () => {
    test.skip('TODO(Ashish): a validly-signed token is accepted', () => {
        // Confirm the exact header/token format Ashish settles on
        // (e.g. "Authorization: Bearer <token>.<hmac-signature>") before
        // writing this.
    });

    test.skip('TODO(Ashish): a tampered or invalid signature is rejected', () => {
        // e.g. flip one character of a valid token/signature and confirm
        // checkAuth() rejects it.
    });
});
