/**
 * src/loadbalancer.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Load balancing for Nexus. Given a route and its backend pool,
 *   selects which backend should handle the next request based on the
 *   configured strategy: round-robin, least-connections, or weighted.
 *
 *   Owner: Kanchan
 *   Zero-dep substitution: plain Maps + counters replace specialized
 *   load-balancing libraries. No external dependencies.
 *
 * WHAT THIS FILE DOES
 *   - Round-robin: cycles through backends in order
 *   - Least-connections: picks backend with fewest active requests
 *   - Weighted: picks based on weights assigned to each backend
 *   - Skips backends marked unhealthy (if healthcheck.js is integrated)
 *   - Maintains state per route (counters, connection counts, weights)
 *
 * HOW IT FITS IN THE SYSTEM
 *   server.js calls pickBackend() to choose a backend for each request.
 *   This file replaces the temporary inline pickBackend() function in
 *   server.js and adds support for all load balancing strategies.
 *
 * -----------------------------------------------------------------------
 * INTEGRATION CHECKLIST — what needs to change elsewhere
 * -----------------------------------------------------------------------
 *   1. server.js (Ashish):
 *        - Replace the inline pickBackend() function with:
 *            import { createLoadBalancer, pickBackend } from './loadbalancer.js';
 *        - Create ONE load balancer instance at server startup:
 *            const loadBalancer = createLoadBalancer(config);
 *        - In the request handler, call:
 *            const backend = pickBackend(route, loadBalancer);
 *        - Delete the temporary roundRobinCounters Map and pickBackend function.
 *
 *   2. healthcheck.js (Kanchan - to be implemented):
 *        - Once healthcheck.js exists, loadbalancer.js will read
 *          backend health status from the healthcheck module.
 *        - The healthcheck module should expose:
 *            getHealthyBackends(route): string[] - returns only healthy backends
 *        - For now, we assume all backends are healthy.
 *
 *   3. metrics.js (Saikat - already done):
 *        - No changes needed. server.js records metrics after the
 *          backend is chosen.
 *
 *   4. server.js - request tracking (Ashish):
 *        - For least-connections to work, server.js must track when
 *          requests start and finish (in-flight count).
 *        - Add:
 *            loadBalancer.incrementConnections(route, backend);
 *            // ... forward request ...
 *            loadBalancer.decrementConnections(route, backend);
 *        - Or use the wrapper: loadBalancer.withConnection(route, backend, fn)
 *
 *   5. config.js (Kanchan - already done):
 *        - Already validates config.loadBalancing strategy.
 *        - Supports 'round-robin', 'least-connections', 'weighted'.
 *        - Weighted strategy requires backend weights in config:
 *            "backends": {
 *              "/api": [
 *                { "url": "http://localhost:4001", "weight": 3 },
 *                { "url": "http://localhost:4002", "weight": 1 }
 *              ]
 *            }
 *
 *   6. test/loadbalancer.test.js (Ashish):
 *        - Uncomment the import and replace test.skip() with test()
 *          now that this file is implemented.
 * -----------------------------------------------------------------------
 */

// -------------------------------------------------------------------------
// State storage per route
// -------------------------------------------------------------------------

/** @type {Map<string, { index: number, connections: Map<string, number>, totalWeight: number }>} */
const routeState = new Map();

/**
 * Get or create state for a route.
 *
 * @param {string} route - The route key (e.g., "/api")
 * @param {object} config - Full Nexus config
 * @returns {object} Route state with index, connections map, and total weight
 */
function getRouteState(route, config) {
    if (!routeState.has(route)) {
        // Calculate total weight for this route's backends
        const pool = config.backends[route];
        let totalWeight = 0;
        if (Array.isArray(pool)) {
            for (const backend of pool) {
                const weight = typeof backend === 'object' && backend.weight ? backend.weight : 1;
                totalWeight += weight;
            }
        }

        routeState.set(route, {
            index: 0,
            connections: new Map(),
            totalWeight: totalWeight,
        });
    }
    return routeState.get(route);
}

/**
 * Get a backend's URL from the pool entry (handles both string and object formats).
 *
 * @param {string|object} entry - Backend entry from config
 * @returns {string} The backend URL
 */
function getBackendUrl(entry) {
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object' && entry !== null && entry.url) {
        return entry.url;
    }
    throw new Error(`Invalid backend entry: ${JSON.stringify(entry)}`);
}

/**
 * Get a backend's weight (defaults to 1 if not specified).
 *
 * @param {string|object} entry - Backend entry from config
 * @returns {number} The weight (always >= 1)
 */
function getBackendWeight(entry) {
    if (typeof entry === 'string') return 1;
    if (typeof entry === 'object' && entry !== null) {
        return entry.weight && typeof entry.weight === 'number' && entry.weight > 0
            ? entry.weight
            : 1;
    }
    return 1;
}

/**
 * Check if a backend should be considered healthy.
 *
 * @param {string} backendUrl - The backend URL
 * @param {object} healthStatus - Health status object (from healthcheck.js)
 * @returns {boolean} True if healthy
 */
function isBackendHealthy(backendUrl, healthStatus) {
    // If no health status provided, assume healthy
    if (!healthStatus) return true;
    // If healthStatus has a method to check, use it
    if (typeof healthStatus.isHealthy === 'function') {
        return healthStatus.isHealthy(backendUrl);
    }
    // If healthStatus is a Map or object with backend as key
    if (healthStatus instanceof Map) {
        return healthStatus.get(backendUrl) !== false;
    }
    if (typeof healthStatus === 'object' && healthStatus !== null) {
        return healthStatus[backendUrl] !== false;
    }
    return true;
}

// -------------------------------------------------------------------------
// Load balancing strategies
// -------------------------------------------------------------------------

/**
 * Round-robin strategy: pick the next backend in the pool.
 *
 * @param {string} route - The route key
 * @param {Array} pool - Backend pool (strings or objects)
 * @param {object} config - Full Nexus config
 * @param {object} [healthStatus] - Health status object
 * @returns {string|null} - The chosen backend URL, or null if none available
 */
function pickRoundRobin(route, pool, config, healthStatus) {
    const state = getRouteState(route, config);

    // Get all healthy backends
    const healthyBackends = [];
    for (const entry of pool) {
        const url = getBackendUrl(entry);
        if (isBackendHealthy(url, healthStatus)) {
            healthyBackends.push(entry);
        }
    }

    if (healthyBackends.length === 0) return null;

    // Cycle through healthy backends
    const index = state.index % healthyBackends.length;
    state.index = (state.index + 1) % healthyBackends.length;

    return getBackendUrl(healthyBackends[index]);
}

/**
 * Least-connections strategy: pick the backend with the fewest active connections.
 *
 * @param {string} route - The route key
 * @param {Array} pool - Backend pool (strings or objects)
 * @param {object} config - Full Nexus config
 * @param {object} [healthStatus] - Health status object
 * @returns {string|null} - The chosen backend URL, or null if none available
 */
function pickLeastConnections(route, pool, config, healthStatus) {
    const state = getRouteState(route, config);

    let bestBackend = null;
    let bestConnections = Infinity;

    for (const entry of pool) {
        const url = getBackendUrl(entry);
        if (!isBackendHealthy(url, healthStatus)) continue;

        const connections = state.connections.get(url) || 0;
        if (connections < bestConnections) {
            bestConnections = connections;
            bestBackend = url;
        }
    }

    return bestBackend;
}

/**
 * Weighted strategy: pick based on assigned weights.
 *
 * @param {string} route - The route key
 * @param {Array} pool - Backend pool (must include weights)
 * @param {object} config - Full Nexus config
 * @param {object} [healthStatus] - Health status object
 * @returns {string|null} - The chosen backend URL, or null if none available
 */
function pickWeighted(route, pool, config, healthStatus) {
    const state = getRouteState(route, config);

    // Get healthy backends with their weights
    const healthyEntries = [];
    let totalWeight = 0;
    for (const entry of pool) {
        const url = getBackendUrl(entry);
        if (isBackendHealthy(url, healthStatus)) {
            const weight = getBackendWeight(entry);
            healthyEntries.push({ entry, url, weight });
            totalWeight += weight;
        }
    }

    if (healthyEntries.length === 0) return null;

    // If total weight is 0 (shouldn't happen), fall back to round-robin
    if (totalWeight === 0) return pickRoundRobin(route, pool, config, healthStatus);

    // Pick a random number between 0 and totalWeight - 1
    const random = Math.random() * totalWeight;
    let cumulative = 0;

    for (const item of healthyEntries) {
        cumulative += item.weight;
        if (random < cumulative) {
            return item.url;
        }
    }

    // Fallback (shouldn't reach here)
    return healthyEntries[0].url;
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Create a load balancer instance.
 *
 * @param {object} config - Full Nexus config
 * @param {object} [healthStatus] - Health status object (from healthcheck.js)
 * @returns {object} Load balancer API
 */
export function createLoadBalancer(config, healthStatus = null) {
    const strategy = config.loadBalancing || 'round-robin';

    // Validate strategy
    if (!['round-robin', 'least-connections', 'weighted'].includes(strategy)) {
        throw new Error(`Invalid load balancing strategy: ${strategy}`);
    }

    const strategyMap = {
        'round-robin': pickRoundRobin,
        'least-connections': pickLeastConnections,
        'weighted': pickWeighted,
    };

    const pickFn = strategyMap[strategy];

    return {
        /**
         * Pick a backend for a given route.
         *
         * @param {string} route - The route key (e.g., "/api")
         * @returns {string|null} - Backend URL or null if none available
         */
        pickBackend(route) {
            const pool = config.backends[route];
            if (!pool || !Array.isArray(pool) || pool.length === 0) {
                return null;
            }
            return pickFn(route, pool, config, healthStatus);
        },

        /**
         * Increment the active connection count for a backend.
         *
         * @param {string} route - The route key
         * @param {string} backendUrl - The backend URL
         */
        incrementConnections(route, backendUrl) {
            const state = getRouteState(route, config);
            const current = state.connections.get(backendUrl) || 0;
            state.connections.set(backendUrl, current + 1);
        },

        /**
         * Decrement the active connection count for a backend.
         *
         * @param {string} route - The route key
         * @param {string} backendUrl - The backend URL
         */
        decrementConnections(route, backendUrl) {
            const state = getRouteState(route, config);
            const current = state.connections.get(backendUrl) || 0;
            if (current <= 1) {
                state.connections.delete(backendUrl);
            } else {
                state.connections.set(backendUrl, current - 1);
            }
        },

        /**
         * Get the current connection count for a backend.
         *
         * @param {string} route - The route key
         * @param {string} backendUrl - The backend URL
         * @returns {number} Active connection count
         */
        getConnections(route, backendUrl) {
            const state = getRouteState(route, config);
            return state.connections.get(backendUrl) || 0;
        },

        /**
         * Update health status (for integration with healthcheck.js).
         *
         * @param {object} newHealthStatus - Updated health status
         */
        setHealthStatus(newHealthStatus) {
            healthStatus = newHealthStatus;
        },

        /**
         * Execute a function while tracking the connection.
         * Automatically increments before and decrements after.
         *
         * @param {string} route - The route key
         * @param {string} backendUrl - The backend URL
         * @param {Function} fn - Function to execute
         * @returns {Promise<any>} Result of the function
         */
        async withConnection(route, backendUrl, fn) {
            this.incrementConnections(route, backendUrl);
            try {
                return await fn();
            } finally {
                this.decrementConnections(route, backendUrl);
            }
        },

        /**
         * Get the current strategy name.
         *
         * @returns {string} The strategy name
         */
        getStrategy() {
            return strategy;
        },

        /**
         * Reset state for a route (useful for testing).
         *
         * @param {string} route - The route key
         */
        resetRoute(route) {
            routeState.delete(route);
        },

        /**
         * Reset all state (useful for testing).
         */
        resetAll() {
            routeState.clear();
        },
    };
}

/**
 * Legacy function for backward compatibility with server.js.
 * Create a load balancer instance and use pickBackend.
 *
 * @param {string} route - The route key
 * @param {Array} pool - Backend pool (not used if loadBalancer is provided)
 * @param {object} config - Full Nexus config
 * @param {object} loadBalancer - Load balancer instance (from createLoadBalancer)
 * @returns {string|null} - Backend URL or null if none available
 */
export function pickBackend(route, pool, config, loadBalancer) {
    // If a load balancer instance is provided, use it
    if (loadBalancer && typeof loadBalancer.pickBackend === 'function') {
        return loadBalancer.pickBackend(route);
    }

    // Fallback: create a temporary load balancer (for backward compatibility)
    const lb = createLoadBalancer(config);
    return lb.pickBackend(route);
}

// -------------------------------------------------------------------------
// Utility functions for testing
// -------------------------------------------------------------------------

/**
 * Get the current state for a route (for testing).
 *
 * @param {string} route - The route key
 * @param {object} config - Full Nexus config
 * @returns {object} Route state
 */
export function getRouteStateForTesting(route, config) {
    return getRouteState(route, config);
}