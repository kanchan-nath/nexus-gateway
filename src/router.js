/**
 * src/router.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Route matching for Nexus. Given an incoming request path (and
 *   optionally the Host header), determines which configured route
 *   (from config.backends) should handle it.
 *
 *   Owner: Kanchan
 *   Zero-dep substitution: plain string operations (`startsWith`,
 *   longest-prefix-wins loop) replace path-to-regexp / Express router.
 *
 * WHAT THIS FILE DOES
 *   - Longest-prefix matching: given a path like "/api/v2/users",
 *     matches the most specific configured route (e.g., "/api/v2"
 *     over "/api").
 *   - Host-based routing: if config.hostRouting is enabled, matches
 *     routes that include a host:port prefix like "api.example.com/api".
 *   - Returns the matched route key (string) or null if no match.
 *
 * HOW IT FITS IN THE SYSTEM
 *   server.js calls matchRoute() to determine which backend pool to use
 *   for a given request. This file replaces the temporary inline
 *   matchRoute() function currently in server.js.
 *
 * -----------------------------------------------------------------------
 * INTEGRATION CHECKLIST — what needs to change elsewhere
 * -----------------------------------------------------------------------
 *   1. server.js (Ashish):
 *        - Replace the inline matchRoute() function at the top of
 *          server.js with:
 *            import { matchRoute } from './router.js';
 *        - Delete the temporary function (lines ~47-63).
 *        - The call site (line ~150) stays exactly the same:
 *            const route = matchRoute(parsedUrl.pathname, config, req.headers.host);
 *
 *   2. config.js (Kanchan — already done):
 *        - No changes needed. router.js reads config.backends keys
 *          as-is. Host-based routing is controlled by a new optional
 *          config key: config.hostRouting (boolean, default false).
 *
 *   3. nexus.config.json (Kanchan — optional):
 *        - If host-based routing is desired, add:
 *            "hostRouting": true
 *        - Then routes can be specified as:
 *            "backends": {
 *              "api.example.com/api": ["http://localhost:4001"],
 *              "api.example.com/v2": ["http://localhost:4002"],
 *              "/public": ["http://localhost:4003"]
 *            }
 *        - Routes without a host prefix match any host.
 *
 *   4. test/router.test.js (Kanchan):
 *        - Uncomment the import and replace test.skip() with test()
 *          now that this file is implemented.
 * -----------------------------------------------------------------------
 */

/**
 * Match a request to a configured route using longest-prefix matching.
 *
 * If host-based routing is enabled (config.hostRouting === true),
 * routes can include a host prefix: "api.example.com/api". The host
 * from the request's Host header is used to match those routes.
 *
 * If host-based routing is disabled (default), only path-based matching
 * is used, and routes with host prefixes are ignored (treated as
 * unmatched).
 *
 * @param {string} pathname - The request path (e.g., "/api/users/123")
 * @param {object} config - Full Nexus config (uses config.backends and config.hostRouting)
 * @param {string|null} hostHeader - The Host header from the request (e.g., "api.example.com:8080")
 * @returns {string|null} - The matched route key, or null if no match
 */
export function matchRoute(pathname, config, hostHeader = null) {
    const routes = Object.keys(config.backends);
    if (routes.length === 0) return null;

    const hostRouting = config.hostRouting === true;
    let bestMatch = null;
    let bestLength = -1;

    for (const route of routes) {
        // Determine if this route has a host prefix
        const hasHostPrefix = route.includes('/') && route.indexOf('/') > 0;

        if (hostRouting && hasHostPrefix) {
            // Host-based route: match both host and path
            if (hostHeader === null) continue;

            // Normalize host: remove port if present, but keep it if it's
            // part of the route (e.g., "localhost:8080/api" is valid)
            const routeHost = route.substring(0, route.indexOf('/'));
            const routePath = route.substring(route.indexOf('/'));

            // Match host (case-insensitive, with optional port normalization)
            if (!hostMatches(hostHeader, routeHost)) continue;

            // Now match the path part using prefix matching
            if (pathMatches(pathname, routePath)) {
                if (route.length > bestLength) {
                    bestLength = route.length;
                    bestMatch = route;
                }
            }
        } else if (!hostRouting && !hasHostPrefix) {
            // Path-only routing (default): match path only
            if (pathMatches(pathname, route)) {
                if (route.length > bestLength) {
                    bestLength = route.length;
                    bestMatch = route;
                }
            }
        } else if (hostRouting && !hasHostPrefix) {
            // Host routing is enabled, but this route has no host prefix:
            // it matches any host (wildcard host) as long as the path matches
            if (pathMatches(pathname, route)) {
                if (route.length > bestLength) {
                    bestLength = route.length;
                    bestMatch = route;
                }
            }
        }
        // If hostRouting is false and route has host prefix: skip it
    }

    return bestMatch;
}

/**
 * Check if a path matches a route prefix.
 *
 * @param {string} pathname - The request path
 * @param {string} route - The route prefix (e.g., "/api")
 * @returns {boolean} - True if pathname starts with route
 */
function pathMatches(pathname, route) {
    // Exact match or prefix match (with path separator boundary)
    if (pathname === route) return true;
    if (pathname.startsWith(route)) {
        // Ensure we don't match "/api" with "/api2" by checking the
        // next character is either '/' or end of string
        const nextChar = pathname[route.length];
        return nextChar === '/' || nextChar === undefined;
    }
    return false;
}

/**
 * Check if a host header matches a route's host prefix.
 *
 * Handles:
 *   - Case-insensitive comparison
 *   - Port normalization: "localhost:8080" matches "localhost"
 *   - Host-only route "api.example.com" matches any port
 *
 * @param {string} hostHeader - From request (e.g., "localhost:8080")
 * @param {string} routeHost - From route (e.g., "localhost" or "localhost:8080")
 * @returns {boolean} - True if they match
 */
function hostMatches(hostHeader, routeHost) {
    if (!hostHeader || !routeHost) return false;

    // Normalize: lower-case both for case-insensitive comparison
    const hostLower = hostHeader.toLowerCase();
    const routeHostLower = routeHost.toLowerCase();

    // If the route host includes a port, do exact match (with normalization)
    if (routeHostLower.includes(':')) {
        return hostLower === routeHostLower;
    }

    // Route host has no port: match if the host header starts with the
    // route host, followed by either ':' (port) or end of string
    if (hostLower === routeHostLower) return true;
    if (hostLower.startsWith(routeHostLower + ':')) return true;

    return false;
}

/**
 * Legacy API: matchRouteLegacy(pathname, config) for backward compatibility
 * with server.js's temporary matchRoute() signature.
 *
 * @param {string} pathname - The request path
 * @param {object} config - Full Nexus config
 * @returns {string|null} - The matched route key, or null if no match
 */
export function matchRouteLegacy(pathname, config) {
    return matchRoute(pathname, config, null);
}

/**
 * Get all routes that match a given host (useful for debugging/dashboard)
 *
 * @param {string} host - The host to filter by
 * @param {object} config - Full Nexus config
 * @returns {string[]} - Array of matching route keys
 */
export function getRoutesForHost(host, config) {
    const routes = Object.keys(config.backends);
    const hostRouting = config.hostRouting === true;
    const result = [];

    for (const route of routes) {
        const hasHostPrefix = route.includes('/') && route.indexOf('/') > 0;

        if (hostRouting && hasHostPrefix) {
            const routeHost = route.substring(0, route.indexOf('/'));
            if (hostMatches(host, routeHost)) {
                result.push(route);
            }
        } else if (!hostRouting || !hasHostPrefix) {
            // Path-only routes match any host
            result.push(route);
        }
    }

    return result;
}