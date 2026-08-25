import http from 'node:http';
import { URL } from 'node:url';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { matchRoute } from './router.js';
import { createLoadBalancer } from './loadbalancer.js';
import { createHealthChecker } from './healthcheck.js';
import { createWal } from './wal.js';
import { createRateLimiter, getClientIp } from './ratelimiter.js';
import { authenticate } from './auth.js';
import { createDashboard } from './dashboard.js';
import fs from 'node:fs';
import path from 'node:path';

function forwardRequest(clientReq, clientRes, backendBaseUrl) {
    const target = new URL(clientReq.url, backendBaseUrl);

    const outgoingHeaders = { ...clientReq.headers };
    outgoingHeaders.host = target.host;

    const proxyReq = http.request(
        {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: clientReq.method,
            headers: outgoingHeaders,
        },
        (backendRes) => {
            clientRes.writeHead(backendRes.statusCode, backendRes.headers);
            backendRes.pipe(clientRes);
        }
    );

    proxyReq.on('error', (err) => {
        console.error(`[server] backend request failed (${target.href}): ${err.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({ error: 'Bad Gateway', detail: 'backend unreachable' }));
        } else {
            clientRes.destroy();
        }
    });

    clientReq.pipe(proxyReq);
}

function createRequestHandler(config, logger, metrics, loadBalancer, wal, rateLimiter, dashboard) {
    return async function handleRequest(req, res) {
        const startTime = Date.now();
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (config.metrics && config.metrics.path && parsedUrl.pathname === config.metrics.path) {
            metrics.handleMetricsRoute(req, res);
            logger.logRequest(req, res.statusCode, startTime);
            return;
        }

        if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/nexus/dashboard') {
            try {
                const html = fs.readFileSync(path.resolve('./public/index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal Server Error', detail: 'dashboard UI not found' }));
                logger.error(`Failed to serve dashboard UI: ${err.message}`);
            }
            logger.logRequest(req, res.statusCode, startTime);
            return;
        }

        if (config.dashboard?.path && parsedUrl.pathname === config.dashboard.path) {
            return dashboard.handleDashboardStream(req, res);
        }

        const clientIp = getClientIp(req);
        const rateLimitResult = rateLimiter.checkLimit(clientIp);
        if (!rateLimitResult.allowed) {
            const retryAfterSeconds = Math.ceil(rateLimitResult.retryAfterMs / 1000);
            res.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': String(retryAfterSeconds),
            });
            res.end(JSON.stringify({ error: 'Too Many Requests', detail: `retry after ${retryAfterSeconds}s` }));
            logger.logRequest(req, 429, startTime);
            metrics.recordRequest({ route: null, backend: null, statusCode: 429, durationMs: Date.now() - startTime });
            return;
        }

        const authResult = authenticate(req, config);
        if (!authResult.authenticated) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'WWW-Authenticate': 'ApiKey, Bearer',
            });
            res.end(JSON.stringify({ error: 'Unauthorized', detail: authResult.reason }));
            logger.logRequest(req, 401, startTime);
            metrics.recordRequest({ route: null, backend: null, statusCode: 401, durationMs: Date.now() - startTime });
            return;
        }

        const route = matchRoute(parsedUrl.pathname, config, req.headers.host);
        if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found', detail: `no backend configured for ${parsedUrl.pathname}` }));
            logger.logRequest(req, 404, startTime);
            metrics.recordRequest({ route: null, backend: null, statusCode: 404, durationMs: Date.now() - startTime });
            return;
        }

        const backend = loadBalancer.pickBackend(route);
        if (!backend) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway', detail: `no healthy backends available for ${route}` }));
            logger.logRequest(req, 502, startTime);
            metrics.recordRequest({ route, backend: null, statusCode: 502, durationMs: Date.now() - startTime });
            return;
        }

        let walEntryId = null;
        if (wal.enabled) {
            try {
                walEntryId = await wal.append(req, route, backend);
                logger.debug(`WAL entry created: ${walEntryId}`);
            } catch (err) {
                logger.error(`WAL append failed: ${err.message}`);
            }
        }

        loadBalancer.incrementConnections(route, backend);

        res.on('finish', () => {
            loadBalancer.decrementConnections(route, backend);

            const durationMs = Date.now() - startTime;
            logger.logRequest(req, res.statusCode, startTime);
            metrics.recordRequest({
                route,
                backend,
                statusCode: res.statusCode,
                durationMs,
            });

            if (walEntryId && wal.enabled) {
                try {
                    wal.updateResponse(walEntryId, req, route, backend, {
                        statusCode: res.statusCode,
                        headers: res.getHeaders(),
                    }).catch((err) => {
                        logger.error(`WAL update failed: ${err.message}`);
                    });
                } catch (err) {
                    logger.error(`WAL update failed: ${err.message}`);
                }
            }
        });

        res.on('error', (err) => {
            loadBalancer.decrementConnections(route, backend);
            logger.error(`Response error for ${route} -> ${backend}: ${err.message}`);

            if (walEntryId && wal.enabled) {
                try {
                    wal.updateResponse(walEntryId, req, route, backend, {
                        statusCode: 500,
                        headers: {},
                        error: err.message,
                    }).catch(() => { });
                } catch (_) {
                }
            }
        });

        forwardRequest(req, res, backend);
    };
}

export function createRequestContext(config) {
    if (!config || !config.backends) {
        throw new Error('createRequestContext: a valid config with "backends" is required');
    }

    const logger = createLogger(config);
    const metrics = createMetrics();
    const dashboard = createDashboard(config, metrics);
    const healthChecker = createHealthChecker(config, logger);
    healthChecker.start();

    const loadBalancer = createLoadBalancer(config, healthChecker);
    const wal = createWal(config, logger);
    const rateLimiter = createRateLimiter(config);

    const requestHandler = createRequestHandler(config, logger, metrics, loadBalancer, wal, rateLimiter, dashboard);

    return { requestHandler, logger, metrics, loadBalancer, healthChecker, wal, rateLimiter, dashboard };
}

export function createServer(config, existingContext = null) {
    const ctx = existingContext || createRequestContext(config);

    const server = http.createServer(ctx.requestHandler);

    server.logger = ctx.logger;
    server.metrics = ctx.metrics;
    server.loadBalancer = ctx.loadBalancer;
    server.healthChecker = ctx.healthChecker;
    server.wal = ctx.wal;
    server.rateLimiter = ctx.rateLimiter;
    server.requestHandler = ctx.requestHandler;

    return server;
}

export function startServer(config) {
    const server = createServer(config);
    const port = config.listen.http;

    server.listen(port, () => {
        server.logger.info(`Nexus listening on http://localhost:${port}`);
        server.logger.info(`Load balancing strategy: ${server.loadBalancer.getStrategy()}`);
        server.logger.info(`Routes configured: ${Object.keys(config.backends).join(', ')}`);

        const healthyCount = server.healthChecker.getHealthyBackends().length;
        const totalBackends = server.healthChecker.getStatus().size;
        server.logger.info(`Health status: ${healthyCount}/${totalBackends} backends healthy`);

        if (server.wal.enabled) {
            const walStats = server.wal.getStats();
            server.logger.info(`WAL enabled: ${config.wal?.path || './wal.log'} (${walStats.entryCount} entries)`);
        } else {
            server.logger.info('WAL disabled');
        }
    });

    return server;
}

export function shutdownServer(server, timeout = 5000) {
    return new Promise((resolve, reject) => {
        if (!server || !server.listening) {
            resolve();
            return;
        }

        const logger = server.logger || console;
        logger.info('Shutting down server...');

        if (server.healthChecker && typeof server.healthChecker.stop === 'function') {
            server.healthChecker.stop();
        }

        if (server.wal && typeof server.wal.stop === 'function') {
            server.wal.stop().catch((err) => {
                logger.error(`WAL stop error: ${err.message}`);
            });
        }

        const timeoutId = setTimeout(() => {
            logger.warn('Force closing connections after timeout');
            server.close(() => {
                resolve();
            });
        }, timeout);

        server.close((err) => {
            clearTimeout(timeoutId);
            if (err) {
                reject(err);
            } else {
                logger.info('Server shutdown complete');
                resolve();
            }
        });
    });
}