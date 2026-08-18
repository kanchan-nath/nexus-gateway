/**
 * test/ratelimiter.test.js
 * -----------------------------------------------------------------------
 * PLACEHOLDER — src/ratelimiter.js has not been implemented yet.
 *
 * Owner of ratelimiter.js: Ashish
 * Owner of this test file: Saikat (per file table) — kept as a skipped
 * placeholder for now (team decision) rather than building a throwaway
 * ratelimiter.js implementation just to make this file real. Once
 * Ashish's actual ratelimiter.js lands, replace the skips below.
 *
 * TODO(Saikat, once ratelimiter.js exists): src/ratelimiter.js should
 * export a token-bucket limiter keyed by client IP
 * (Map<ip, {tokens, lastRefill}>), refilled via Date.now() math per
 * config.rateLimit ({ "windowMs": 1000, "max": 20 }). Do the following:
 *   1. Uncomment the import below.
 *   2. Replace each test.skip(...) with test(...) and fill in real
 *      assertions against the actual exported function signature.
 *   3. Remove this placeholder header once real tests are in place.
 *
 * Suggested cases to cover:
 *   - first request from a fresh IP is always allowed
 *   - requests are allowed up to config.rateLimit.max within windowMs
 *   - the (max + 1)th request within the window is rejected (429)
 *   - tokens refill after windowMs has elapsed, allowing new requests
 *   - two different IPs have independent buckets (one being limited
 *     doesn't affect the other)
 * -----------------------------------------------------------------------
 */

import { test, describe } from 'node:test';

// import { checkRateLimit } from '../src/ratelimiter.js';

describe('ratelimiter.js - token bucket (PLACEHOLDER, not yet implemented)', () => {
    test.skip('TODO(Ashish/Saikat): first request from a fresh IP is allowed', () => {
        // const config = { rateLimit: { windowMs: 1000, max: 20 } };
        // assert.equal(checkRateLimit('1.2.3.4', config), true);
    });

    test.skip('TODO(Ashish/Saikat): allows up to config.rateLimit.max requests in the window', () => {
        // const config = { rateLimit: { windowMs: 1000, max: 3 } };
        // for (let i = 0; i < 3; i++) {
        //     assert.equal(checkRateLimit('1.2.3.4', config), true);
        // }
    });

    test.skip('TODO(Ashish/Saikat): the request over max within the window is rejected', () => {
        // const config = { rateLimit: { windowMs: 1000, max: 3 } };
        // for (let i = 0; i < 3; i++) checkRateLimit('1.2.3.4', config);
        // assert.equal(checkRateLimit('1.2.3.4', config), false);
    });

    test.skip('TODO(Ashish/Saikat): tokens refill after windowMs elapses', () => {
        // Will likely need a small sleep/delay or a mockable clock —
        // decide with Ashish which approach ratelimiter.js supports
        // before writing this one.
    });

    test.skip('TODO(Ashish/Saikat): different IPs have independent buckets', () => {
        // const config = { rateLimit: { windowMs: 1000, max: 1 } };
        // assert.equal(checkRateLimit('1.1.1.1', config), true);
        // checkRateLimit('1.1.1.1', config); // exhausts 1.1.1.1's bucket
        // assert.equal(checkRateLimit('2.2.2.2', config), true); // unaffected
    });
});
