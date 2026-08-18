/**
 * src/healthcheck.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Health checking for Nexus backends. Periodically probes each backend
 *   to determine if it's healthy and should receive traffic.
 *
 *   Owner: Kanchan
 *   Zero-dep substitution: `setInterval` + `http.request` replace
 *   health-check libraries like `node-fetch` + `node-cron`.
 *
 * WHAT THIS FILE DOES
 *   - Periodically sends HTTP requests to each backend's health endpoint
 *   - Tracks consecutive failures (unhealthyThreshold)
 *   - Marks backends as healthy/unhealthy based on probe results
 *   - Exposes health status to loadbalancer.js and server.js
 *
 * HOW IT FITS IN THE SYSTEM
 *   - loadbalancer.js reads health status to skip unhealthy backends
 *   - dashboard.js can display backend health status
 *   - Server logs health transitions (dead/alive)
 *
 * -----------------------------------------------------------------------
 * INTEGRATION CHECKLIST — what needs to change elsewhere
 * -----------------------------------------------------------------------
 *   1. server.js (Ashish):
 *        - Import and create health checker at startup:
 *            import { createHealthChecker } from './healthcheck.js';
 *            const healthChecker = createHealthChecker(config, logger);
 *            healthChecker.start();
 *        - Pass healthChecker to loadBalancer:
 *            const loadBalancer = createLoadBalancer(config, healthChecker);
 *
 *   2. loadbalancer.js (Kanchan - already supports this):
 *        - Accepts healthStatus parameter and uses it to filter backends
 *        - Already integrated with healthChecker.getStatus()
 *
 *   3. dashboard.js (Biyas - future):
 *        - Can display health status via healthChecker.getStatus()
 *        - Can show health check events in real-time
 *
 *   4. logger.js (Saikat - already done):
 *        - Health checker uses logger for structured logging
 *
 *   5. metrics.js (Saikat - future enhancement):
 *        - Could track health check failures separately
 * -----------------------------------------------------------------------
 */

import http from 'node:http';
import { URL } from 'node:url';

/**
 * Create a health checker for backend monitoring.
 *
 * @param {object} config - Full Nexus config (uses healthCheck section)
 * @param {object} logger - Logger instance from logger.js
 * @param {object} [options] - Optional overrides
 * @param {number} [options.intervalMs] - Check interval (overrides config)
 * @param {number} [options.timeoutMs] - Request timeout (overrides config)
 * @param {number} [options.unhealthyThreshold] - Consecutive failures to mark dead
 * @returns {object} Health checker API
 */
export function createHealthChecker(config, logger, options = {}) {
    const healthConfig = config.healthCheck || {};

    // Use options if provided, otherwise fall back to config, then defaults
    const intervalMs = options.intervalMs || healthConfig.intervalMs || 5000;
    const timeoutMs = options.timeoutMs || healthConfig.timeoutMs || 2000;
    const unhealthyThreshold = options.unhealthyThreshold || healthConfig.unhealthyThreshold || 2;
    const healthPath = healthConfig.path || '/health';

    /**
     * Health status for each backend URL.
     * {
     *   healthy: boolean,
     *   failures: number,
     *   lastCheck: timestamp,
     *   lastError: string | null,
     *   responseTimeMs: number | null
     * }
     */
    const statusMap = new Map();

    /**
     * Map of backend URLs to their current check timers/timeouts.
     * Used to cancel in-flight checks.
     */
    const pendingChecks = new Map();

    /** @type {NodeJS.Timeout|null} */
    let intervalTimer = null;

    /** @type {boolean} */
    let isRunning = false;

    /**
     * Initialize status for all backends across all routes.
     */
    function initializeBackends() {
        const allBackends = getAllBackends(config);
        for (const backend of allBackends) {
            if (!statusMap.has(backend)) {
                statusMap.set(backend, {
                    healthy: true, // Start optimistic
                    failures: 0,
                    lastCheck: null,
                    lastError: null,
                    responseTimeMs: null,
                });
            }
        }
    }

    /**
     * Get all unique backend URLs from all routes.
     *
     * @param {object} cfg - Nexus config
     * @returns {string[]} Array of backend URLs
     */
    function getAllBackends(cfg) {
        const backends = new Set();
        for (const route of Object.keys(cfg.backends || {})) {
            const pool = cfg.backends[route];
            if (Array.isArray(pool)) {
                for (const entry of pool) {
                    const url = typeof entry === 'string' ? entry : entry.url;
                    if (url) backends.add(url);
                }
            }
        }
        return Array.from(backends);
    }

    /**
     * Check a single backend's health.
     *
     * @param {string} backendUrl - The backend URL to check
     * @returns {Promise<boolean>} True if healthy, false otherwise
     */
    function checkBackendHealth(backendUrl) {
        return new Promise((resolve) => {
            const target = new URL(healthPath, backendUrl);
            const status = statusMap.get(backendUrl);

            // Set up timeout
            const timeoutId = setTimeout(() => {
                // Clean up the request if it hasn't completed
                const pending = pendingChecks.get(backendUrl);
                if (pending && pending.req) {
                    pending.req.destroy();
                }
                pendingChecks.delete(backendUrl);

                // Mark as unhealthy on timeout
                const newStatus = markBackendUnhealthy(backendUrl, `Timeout after ${timeoutMs}ms`);
                resolve(newStatus.healthy);
            }, timeoutMs);

            const startTime = Date.now();

            const req = http.request(target, (res) => {
                clearTimeout(timeoutId);
                pendingChecks.delete(backendUrl);

                const durationMs = Date.now() - startTime;
                const isHealthy = res.statusCode >= 200 && res.statusCode < 300;

                // Drain response body to free up connection
                res.on('data', () => { });
                res.on('end', () => {
                    if (isHealthy) {
                        markBackendHealthy(backendUrl, durationMs);
                    } else {
                        const reason = `Status ${res.statusCode}`;
                        markBackendUnhealthy(backendUrl, reason);
                    }
                    resolve(isHealthy);
                });
            });

            // Store pending request for cleanup
            pendingChecks.set(backendUrl, { req, timeoutId });

            req.on('error', (err) => {
                clearTimeout(timeoutId);
                pendingChecks.delete(backendUrl);

                const reason = err.code || err.message;
                markBackendUnhealthy(backendUrl, reason);
                resolve(false);
            });

            req.setTimeout(timeoutMs, () => {
                // This is an alternative timeout mechanism
                req.destroy();
            });

            req.end();
        });
    }

    /**
     * Mark a backend as healthy (reset failure count).
     *
     * @param {string} backendUrl - The backend URL
     * @param {number} responseTimeMs - Response time of the check
     */
    function markBackendHealthy(backendUrl, responseTimeMs) {
        const status = statusMap.get(backendUrl);
        if (!status) return;

        const wasHealthy = status.healthy;
        status.healthy = true;
        status.failures = 0;
        status.lastCheck = Date.now();
        status.lastError = null;
        status.responseTimeMs = responseTimeMs;

        // Log state change: unhealthy -> healthy
        if (!wasHealthy) {
            logger.info(`Backend ${backendUrl} is now healthy (response: ${responseTimeMs}ms)`);
        }
    }

    /**
     * Mark a backend as unhealthy (increment failures).
     *
     * @param {string} backendUrl - The backend URL
     * @param {string} reason - Why it failed
     * @returns {object} The updated status
     */
    function markBackendUnhealthy(backendUrl, reason) {
        const status = statusMap.get(backendUrl);
        if (!status) {
            // Should not happen, but handle gracefully
            statusMap.set(backendUrl, {
                healthy: false,
                failures: 1,
                lastCheck: Date.now(),
                lastError: reason,
                responseTimeMs: null,
            });
            return statusMap.get(backendUrl);
        }

        const wasHealthy = status.healthy;
        status.failures += 1;
        status.lastCheck = Date.now();
        status.lastError = reason;
        status.responseTimeMs = null;

        // Only mark unhealthy if failures >= threshold
        if (status.failures >= unhealthyThreshold) {
            status.healthy = false;
            // Log state change: healthy -> unhealthy
            if (wasHealthy) {
                logger.warn(`Backend ${backendUrl} is now UNHEALTHY (${status.failures} consecutive failures, last: ${reason})`);
            }
        } else {
            // Still healthy but accumulating failures
            logger.debug(`Backend ${backendUrl} health check failed (${status.failures}/${unhealthyThreshold}): ${reason}`);
        }

        return status;
    }

    /**
     * Check all backends.
     *
     * @returns {Promise<Map<string, boolean>>} Map of backend URL -> healthy status
     */
    async function checkAllBackends() {
        const backends = getAllBackends(config);
        const results = new Map();

        // Check all backends concurrently (but with a limit to avoid overwhelming)
        const batchSize = 5;
        for (let i = 0; i < backends.length; i += batchSize) {
            const batch = backends.slice(i, i + batchSize);
            const promises = batch.map((backend) => checkBackendHealth(backend));
            await Promise.all(promises);
        }

        // Build results map
        for (const backend of backends) {
            const status = statusMap.get(backend);
            results.set(backend, status ? status.healthy : false);
        }

        return results;
    }

    /**
     * Start periodic health checking.
     */
    function start() {
        if (isRunning) {
            logger.warn('Health checker is already running');
            return;
        }

        // Initialize status for all backends
        initializeBackends();

        // Do an immediate check before starting the interval
        logger.info('Running initial health checks...');
        checkAllBackends().then((results) => {
            const healthyCount = Array.from(results.values()).filter(Boolean).length;
            const total = results.size;
            logger.info(`Initial health check complete: ${healthyCount}/${total} backends healthy`);
        }).catch((err) => {
            logger.error(`Initial health check failed: ${err.message}`);
        });

        // Start periodic checks
        intervalTimer = setInterval(() => {
            logger.debug('Running periodic health checks...');
            checkAllBackends().catch((err) => {
                logger.error(`Health check interval failed: ${err.message}`);
            });
        }, intervalMs);

        isRunning = true;
        logger.info(`Health checker started (interval: ${intervalMs}ms, threshold: ${unhealthyThreshold})`);
    }

    /**
     * Stop periodic health checking.
     */
    function stop() {
        if (intervalTimer) {
            clearInterval(intervalTimer);
            intervalTimer = null;
        }

        // Cancel all pending checks
        for (const [backend, pending] of pendingChecks) {
            if (pending.req) {
                pending.req.destroy();
            }
            if (pending.timeoutId) {
                clearTimeout(pending.timeoutId);
            }
        }
        pendingChecks.clear();

        isRunning = false;
        logger.info('Health checker stopped');
    }

    /**
     * Get the health status of a specific backend.
     *
     * @param {string} backendUrl - The backend URL
     * @returns {object} Status object with healthy, failures, lastCheck, etc.
     */
    function getBackendStatus(backendUrl) {
        return statusMap.get(backendUrl) || {
            healthy: false,
            failures: 0,
            lastCheck: null,
            lastError: 'Unknown backend',
            responseTimeMs: null,
        };
    }

    /**
     * Check if a specific backend is healthy.
     *
     * @param {string} backendUrl - The backend URL
     * @returns {boolean} True if healthy
     */
    function isBackendHealthy(backendUrl) {
        const status = statusMap.get(backendUrl);
        return status ? status.healthy : false;
    }

    /**
     * Get the full health status map for all backends.
     *
     * @returns {Map<string, object>} Map of backend URL -> status object
     */
    function getStatus() {
        return statusMap;
    }

    /**
     * Get the full health status as a plain object (for JSON serialization).
     *
     * @returns {object} Plain object with backend URLs as keys
     */
    function getStatusAsObject() {
        const result = {};
        for (const [backend, status] of statusMap) {
            result[backend] = { ...status };
        }
        return result;
    }

    /**
     * Get all healthy backends.
     *
     * @returns {string[]} Array of healthy backend URLs
     */
    function getHealthyBackends() {
        const healthy = [];
        for (const [backend, status] of statusMap) {
            if (status.healthy) {
                healthy.push(backend);
            }
        }
        return healthy;
    }

    /**
     * Get all unhealthy backends.
     *
     * @returns {string[]} Array of unhealthy backend URLs
     */
    function getUnhealthyBackends() {
        const unhealthy = [];
        for (const [backend, status] of statusMap) {
            if (!status.healthy) {
                unhealthy.push(backend);
            }
        }
        return unhealthy;
    }

    /**
     * Manually trigger a health check for all backends.
     *
     * @returns {Promise<Map<string, boolean>>} Results of the check
     */
    async function forceCheck() {
        logger.info('Manual health check triggered');
        return await checkAllBackends();
    }

    /**
     * Manually trigger a health check for a single backend.
     *
     * @param {string} backendUrl - The backend URL
     * @returns {Promise<boolean>} True if healthy
     */
    async function forceCheckBackend(backendUrl) {
        logger.info(`Manual health check for ${backendUrl}`);
        return await checkBackendHealth(backendUrl);
    }

    /**
     * Reset health status for a backend (mark as healthy and reset failures).
     *
     * @param {string} backendUrl - The backend URL
     */
    function resetBackend(backendUrl) {
        const status = statusMap.get(backendUrl);
        if (status) {
            status.healthy = true;
            status.failures = 0;
            status.lastError = null;
            logger.info(`Reset health status for ${backendUrl}`);
        }
    }

    // Initialize immediately (but don't start checking)
    initializeBackends();

    return {
        // Lifecycle
        start,
        stop,
        forceCheck,
        forceCheckBackend,
        resetBackend,

        // Status queries
        getBackendStatus,
        isBackendHealthy,
        getStatus,
        getStatusAsObject,
        getHealthyBackends,
        getUnhealthyBackends,

        // Configuration
        get intervalMs() { return intervalMs; },
        get unhealthyThreshold() { return unhealthyThreshold; },
        get isRunning() { return isRunning; },

        // For integration with loadbalancer.js - this matches the expected interface
        get: statusMap, // Allow direct Map access via .get()
    };
}