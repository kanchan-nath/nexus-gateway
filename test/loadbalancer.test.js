/**
 * test/loadbalancer.test.js
 * -----------------------------------------------------------------------
 * PLACEHOLDER — src/loadbalancer.js has not been implemented yet.
 *
 * Owner of loadbalancer.js: Kanchan
 * Owner of this test file: Ashish (per file table) — Saikat scaffolded
 * it as a starting point so `node --test` still passes cleanly today
 * instead of failing on an import of a file that doesn't exist yet.
 *
 * TODO(Ashish/Kanchan): once src/loadbalancer.js exports pickBackend()
 * (round-robin + least-connections, per the Phase 2 plan), do the
 * following:
 *   1. Uncomment the import below.
 *   2. Replace each test.skip(...) with test(...) and fill in real
 *      assertions against your actual pickBackend() signature.
 *   3. Remove this placeholder header once real tests are in place.
 *
 * Suggested cases to cover (matches server.js's current temporary
 * round-robin pickBackend() behavior, which yours should replace):
 *   - round-robin cycles through the pool in order, then wraps around
 *   - least-connections picks the backend with the fewest in-flight
 *     requests, not just the next index
 *   - a backend marked dead by healthcheck.js is skipped entirely
 *   - empty/no-backend pool returns null (caller returns 502)
 * -----------------------------------------------------------------------
 */

import { test, describe } from 'node:test';

// import { pickBackend } from '../src/loadbalancer.js';

describe('loadbalancer.js - pickBackend (PLACEHOLDER, not yet implemented)', () => {
    test.skip('TODO(Kanchan): round-robin cycles through the pool in order', () => {
        // const pool = ['http://b1', 'http://b2', 'http://b3'];
        // assert.equal(pickBackend('/api', pool), 'http://b1');
        // assert.equal(pickBackend('/api', pool), 'http://b2');
        // assert.equal(pickBackend('/api', pool), 'http://b3');
        // assert.equal(pickBackend('/api', pool), 'http://b1'); // wraps
    });

    test.skip('TODO(Kanchan): least-connections picks the backend with fewest in-flight requests', () => {
        // Requires tracking in-flight count per backend somewhere the
        // loadbalancer can read it — confirm the interface with server.js
        // before implementing (does server.js increment/decrement it, or
        // does loadbalancer.js own that state?).
    });

    test.skip('TODO(Kanchan): skips backends marked dead by healthcheck.js', () => {
        // Depends on healthcheck.js's dead/alive interface existing first.
    });

    test.skip('TODO(Kanchan): returns null for an empty or missing pool', () => {
        // assert.equal(pickBackend('/api', []), null);
        // assert.equal(pickBackend('/api', undefined), null);
    });
});
