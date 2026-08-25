import http from 'node:http';
import { URL } from 'node:url';

export function createHealthChecker(config, logger, options = {}) {
    const healthConfig = config.healthCheck || {};

    const intervalMs = options.intervalMs || healthConfig.intervalMs || 5000;
    const timeoutMs = options.timeoutMs || healthConfig.timeoutMs || 2000;
    const unhealthyThreshold = options.unhealthyThreshold || healthConfig.unhealthyThreshold || 2;
    const healthPath = healthConfig.path || '/health';

    const statusMap = new Map();

    const pendingChecks = new Map();

    let intervalTimer = null;

    let isRunning = false;

    function initializeBackends() {
        const allBackends = getAllBackends(config);
        for (const backend of allBackends) {
            if (!statusMap.has(backend)) {
                statusMap.set(backend, {
                    healthy: true,
                    failures: 0,
                    lastCheck: null,
                    lastError: null,
                    responseTimeMs: null,
                });
            }
        }
    }

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

    function checkBackendHealth(backendUrl) {
        return new Promise((resolve) => {
            const target = new URL(healthPath, backendUrl);
            const status = statusMap.get(backendUrl);

            const timeoutId = setTimeout(() => {
                const pending = pendingChecks.get(backendUrl);
                if (pending && pending.req) {
                    pending.req.destroy();
                }

                pendingChecks.delete(backendUrl);

                const newStatus = markBackendUnhealthy(backendUrl, `Timeout after ${timeoutMs}ms`);
                resolve(newStatus.healthy);
            }, timeoutMs);

            const startTime = Date.now();

            const req = http.request(target, (res) => {
                clearTimeout(timeoutId);
                pendingChecks.delete(backendUrl);

                const durationMs = Date.now() - startTime;
                const isHealthy = res.statusCode >= 200 && res.statusCode < 300;

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

            pendingChecks.set(backendUrl, { req, timeoutId });

            req.on('error', (err) => {
                clearTimeout(timeoutId);
                pendingChecks.delete(backendUrl);

                const reason = err.code || err.message;
                markBackendUnhealthy(backendUrl, reason);
                resolve(false);
            });

            req.setTimeout(timeoutMs, () => {
                req.destroy();
            });

            req.end();
        });
    }

    function markBackendHealthy(backendUrl, responseTimeMs) {
        const status = statusMap.get(backendUrl);
        if (!status) return;

        const wasHealthy = status.healthy;
        status.healthy = true;
        status.failures = 0;
        status.lastCheck = Date.now();
        status.lastError = null;
        status.responseTimeMs = responseTimeMs;

        if (!wasHealthy) {
            logger.info(`Backend ${backendUrl} is now healthy (response: ${responseTimeMs}ms)`);
        }
    }

    function markBackendUnhealthy(backendUrl, reason) {
        const status = statusMap.get(backendUrl);

        if (!status) {
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

        if (status.failures >= unhealthyThreshold) {
            status.healthy = false;

            if (wasHealthy) {
                logger.warn(`Backend ${backendUrl} is now UNHEALTHY (${status.failures} consecutive failures, last: ${reason})`);
            }
        } else {
            logger.debug(`Backend ${backendUrl} health check failed (${status.failures}/${unhealthyThreshold}): ${reason}`);
        }

        return status;
    }

    async function checkAllBackends() {
        const backends = getAllBackends(config);
        const results = new Map();

        const batchSize = 5;

        for (let i = 0; i < backends.length; i += batchSize) {
            const batch = backends.slice(i, i + batchSize);
            const promises = batch.map((backend) => checkBackendHealth(backend));
            await Promise.all(promises);
        }

        for (const backend of backends) {
            const status = statusMap.get(backend);
            results.set(backend, status ? status.healthy : false);
        }

        return results;
    }

    function start() {
        if (isRunning) {
            logger.warn('Health checker is already running');
            return;
        }

        initializeBackends();

        logger.info('Running initial health checks...');

        checkAllBackends().then((results) => {
            const healthyCount = Array.from(results.values()).filter(Boolean).length;
            const total = results.size;
            logger.info(`Initial health check complete: ${healthyCount}/${total} backends healthy`);
        }).catch((err) => {
            logger.error(`Initial health check failed: ${err.message}`);
        });

        intervalTimer = setInterval(() => {
            logger.debug('Running periodic health checks...');

            checkAllBackends().catch((err) => {
                logger.error(`Health check interval failed: ${err.message}`);
            });
        }, intervalMs);

        isRunning = true;
        logger.info(`Health checker started (interval: ${intervalMs}ms, threshold: ${unhealthyThreshold})`);
    }

    function stop() {
        if (intervalTimer) {
            clearInterval(intervalTimer);
            intervalTimer = null;
        }

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

    function getBackendStatus(backendUrl) {
        return statusMap.get(backendUrl) || {
            healthy: false,
            failures: 0,
            lastCheck: null,
            lastError: 'Unknown backend',
            responseTimeMs: null,
        };
    }

    function isBackendHealthy(backendUrl) {
        const status = statusMap.get(backendUrl);
        return status ? status.healthy : false;
    }

    function getStatus() {
        return statusMap;
    }

    function getStatusAsObject() {
        const result = {};

        for (const [backend, status] of statusMap) {
            result[backend] = { ...status };
        }

        return result;
    }

    function getHealthyBackends() {
        const healthy = [];

        for (const [backend, status] of statusMap) {
            if (status.healthy) {
                healthy.push(backend);
            }
        }

        return healthy;
    }

    function getUnhealthyBackends() {
        const unhealthy = [];

        for (const [backend, status] of statusMap) {
            if (!status.healthy) {
                unhealthy.push(backend);
            }
        }

        return unhealthy;
    }

    async function forceCheck() {
        logger.info('Manual health check triggered');
        return await checkAllBackends();
    }

    async function forceCheckBackend(backendUrl) {
        logger.info(`Manual health check for ${backendUrl}`);
        return await checkBackendHealth(backendUrl);
    }

    function resetBackend(backendUrl) {
        const status = statusMap.get(backendUrl);

        if (status) {
            status.healthy = true;
            status.failures = 0;
            status.lastError = null;
            logger.info(`Reset health status for ${backendUrl}`);
        }
    }

    initializeBackends();

    return {
        start,
        stop,
        forceCheck,
        forceCheckBackend,
        resetBackend,

        getBackendStatus,
        isBackendHealthy,
        getStatus,
        getStatusAsObject,
        getHealthyBackends,
        getUnhealthyBackends,

        get intervalMs() { return intervalMs; },
        get unhealthyThreshold() { return unhealthyThreshold; },
        get isRunning() { return isRunning; },

        get: statusMap,
    };
}