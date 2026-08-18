/**
 * test/router.test.js
 * -----------------------------------------------------------------------
 * PLACEHOLDER — src/router.js has not been implemented yet.
 *
 * Owner of router.js: Kanchan
 * Owner of this test file: Kanchan (per file table) — Saikat scaffolded
 * it as a starting point so `node --test` still passes cleanly today
 * instead of failing on an import of a file that doesn't exist yet.
 *
 * TODO(Kanchan): once src/router.js exports matchRoute() (host-based +
 * path-based prefix matching per the Phase 1/3 plan), do the following:
 *   1. Uncomment the import below.
 *   2. Replace each test.skip(...) with test(...) and fill in real
 *      assertions against your actual matchRoute() signature.
 *   3. Remove this placeholder header once real tests are in place.
 *
 * Suggested cases to cover (matches server.js's current temporary
 * matchRoute() behavior, which yours should be a superset of):
 *   - exact path match against a configured route
 *   - longest-prefix-wins when multiple routes could match
 *   - no match returns null (caller returns 404)
 *   - host-based routing (once added on top of path-based, per Phase 3)
 * -----------------------------------------------------------------------
 */

import { test, describe } from 'node:test';

// import { matchRoute } from '../src/router.js';

describe('router.js - matchRoute (PLACEHOLDER, not yet implemented)', () => {
    test.skip('TODO(Kanchan): exact path match returns the matching route', () => {
        // const config = { backends: { '/api': ['http://localhost:4001'] } };
        // assert.equal(matchRoute('/api', config), '/api');
    });

    test.skip('TODO(Kanchan): longest matching prefix wins over a shorter one', () => {
        // e.g. both "/api" and "/api/v2" configured, path "/api/v2/widgets"
        // should match "/api/v2", not "/api".
    });

    test.skip('TODO(Kanchan): unmatched path returns null', () => {
        // const config = { backends: { '/api': ['http://localhost:4001'] } };
        // assert.equal(matchRoute('/nope', config), null);
    });

    test.skip('TODO(Kanchan): host-based routing (Phase 3 extension)', () => {
        // Once router.js supports routing by the Host header in addition
        // to path, add coverage here.
    });
});
