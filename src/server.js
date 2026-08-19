/**
 * src/server.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   This is the core of Nexus. It creates the raw HTTP server (using only
 *   Node's built-in `http` module — no Express, no dependencies) and is
 *   responsible for the request pipeline: an incoming request comes in,
 *   gets matched to a backend, gets forwarded with `http.request`, and
 *   the backend's response gets piped straight back to the client.
 *
 *   Owner: Ashish
 *   Zero-dep substitution: `http` (built-in) replaces Express.
 *
 * CURRENT SCOPE (Phase 4 — Full Integration)
 *   All core modules are now integrated:
 *     - router.js for path/host-based routing
 *     - loadbalancer.js for intelligent backend selection
 *     - healthcheck.js for backend health monitoring
 *     - logger.js for structured logging
 *     - metrics.js for request metrics
 *     - wal.js for write-ahead logging (durability)
 *     - ratelimiter.js for per-IP rate limiting  <-- newly wired in
 *     - auth.js for API key / HMAC token auth    <-- newly wired in
 *
 *   Remaining hook: TLS/HTTPS (tls.js). This file now exposes
 *   `createRequestContext()` (construction only, no listener started)
 *   specifically so tls.js can reuse the EXACT SAME request pipeline —
 *   same loadBalancer, healthChecker, wal, metrics, and rateLimiter
 *   instances — instead of spinning up a second, independent set of
 *   background workers (duplicate health-check polling, a second WAL
 *   writer racing on the same file, etc). See createServer() below and
 *   the notes in tls.js for how this gets threaded through cli.js.
 * -----------------------------------------------------------------------
 */

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
// -------------------------------------------------------------------------
// Forward a single request to a chosen backend and pipe the response back.
// This is the actual "reverse proxy" mechanic: we open our own outbound
// http.request to the backend, stream the client's request body into it,
// then stream the backend's response straight back out to the client.
// -------------------------------------------------------------------------
function forwardRequest(clientReq, clientRes, backendBaseUrl) {
    const target = new URL(clientReq.url, backendBaseUrl);

    // Copy incoming headers, but let the backend see its own Host.
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
            // Pass the backend's status + headers straight through to the client.
            clientRes.writeHead(backendRes.statusCode, backendRes.headers);
            backendRes.pipe(clientRes);
        }
    );

    // If the backend is unreachable, times out, or errors mid-stream,
    // fail cleanly with a 502 instead of hanging the client connection.
    proxyReq.on('error', (err) => {
        console.error(`[server] backend request failed (${target.href}): ${err.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({ error: 'Bad Gateway', detail: 'backend unreachable' }));
        } else {
            clientRes.destroy();
        }
    });

    // Stream the client's request body (POST/PUT payloads, etc.) through.
    clientReq.pipe(proxyReq);
}

// -------------------------------------------------------------------------
// Build the main request handler. Kept as its own function (rather than
// inline in createServer) so it's easy to unit-test later.
//
// `logger`, `metrics`, `loadBalancer`, `wal`, and `rateLimiter` are all
// created once in createRequestContext() and passed in here (dependency
// injection) rather than imported as globals, so tests can pass their own
// instances and nothing leaks state between server instances.
// -------------------------------------------------------------------------
function createRequestHandler(config, logger, metrics, loadBalancer, wal, rateLimiter, dashboard) {
    return async function handleRequest(req, res) {
        const startTime = Date.now();
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (config.metrics && config.metrics.path && parsedUrl.pathname === config.metrics.path) {
            metrics.handleMetricsRoute(req, res);
            logger.logRequest(req, res.statusCode, startTime);
            return;
        }

        // ---- Static dashboard UI (public/index.html) -------------------
        // Served directly by Nexus at "/" — the page's own JS connects
        // to config.dashboard.path (the SSE stream) client-side.
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

        // ---- Dashboard SSE stream (dashboard.js) -----------------------
        // Served directly by Nexus, same as /nexus/metrics — never proxied.
        if (config.dashboard?.path && parsedUrl.pathname === config.dashboard.path) {
            return dashboard.handleDashboardStream(req, res);
        }

        // ---- Rate limit check (ratelimiter.js) -----------------------
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

/**
 * Build the full set of shared components (logger, metrics, load balancer,
 * health checker, WAL, rate limiter) plus the resulting request-handler
 * function — WITHOUT creating an http.Server or starting anything that
 * listens on a socket. This is deliberately separated from createServer()
 * so tls.js can build (or reuse) the exact same pipeline for HTTPS
 * without duplicating background workers.
 *
 * NOTE: healthChecker.start() IS called here (it has to run regardless of
 * which protocol requests arrive on) — so whichever caller builds a
 * context first "owns" the health-check polling and WAL file handle for
 * that process. If both HTTP and HTTPS are enabled, cli.js should build
 * ONE context and reuse it for both listeners (see tls.js for the exact
 * hook), not call this twice.
 *
 * @param {object} config
 * @returns {{ requestHandler: Function, logger: object, metrics: object,
 *   loadBalancer: object, healthChecker: object, wal: object, rateLimiter: object }}
 */
export function createRequestContext(config) {
    if (!config || !config.backends) {
        throw new Error('createRequestContext: a valid config with "backends" is required');
    }

    // Create core components
    const logger = createLogger(config);
    const metrics = createMetrics();
    const dashboard = createDashboard(config, metrics);
    // Create health checker and start it
    const healthChecker = createHealthChecker(config, logger);
    healthChecker.start();

    // Create load balancer with health checker integration
    const loadBalancer = createLoadBalancer(config, healthChecker);

    // Create WAL
    const wal = createWal(config, logger);

    // Create rate limiter (one bucket-map per process/context, not per request)
    const rateLimiter = createRateLimiter(config);

    const requestHandler = createRequestHandler(config, logger, metrics, loadBalancer, wal, rateLimiter, dashboard);

    return { requestHandler, logger, metrics, loadBalancer, healthChecker, wal, rateLimiter, dashboard };
}

/**
 * Create (but do not start) the Nexus HTTP server for the given config.
 * Returns a plain node:http Server instance so the caller (cli.js) decides
 * when/how to call .listen().
 *
 * Also returns the `logger`/`metrics`/`loadBalancer`/`healthChecker`/`wal`/
 * `rateLimiter`/`requestHandler` instances attached to the server object
 * so cli.js, tls.js, or dashboard.js can reuse the SAME instances rather
 * than creating their own. `requestHandler` in particular is what tls.js
 * needs to stand up an HTTPS listener that shares this exact pipeline —
 * see FUTURE INTEGRATION note in tls.js.
 *
 * @param {object} config
 * @param {object} [existingContext] - reuse a context built elsewhere
 *   (e.g. by tls.js) instead of constructing a new one. Optional.
 */
export function createServer(config, existingContext = null) {
    const ctx = existingContext || createRequestContext(config);

    const server = http.createServer(ctx.requestHandler);

    // Attach instances to server for reuse by other modules
    server.logger = ctx.logger;
    server.metrics = ctx.metrics;
    server.loadBalancer = ctx.loadBalancer;
    server.healthChecker = ctx.healthChecker;
    server.wal = ctx.wal;
    server.rateLimiter = ctx.rateLimiter;
    server.requestHandler = ctx.requestHandler;

    return server;
}

/**
 * Convenience helper: create the server and start it listening on
 * config.listen.http. Returns the running server instance.
 *
 * (HTTPS listening on config.listen.https is added in Phase 3 once
 * tls.js exists — this only starts the plain HTTP listener for now.)
 */
export function startServer(config) {
    const server = createServer(config);
    const port = config.listen.http;

    server.listen(port, () => {
        server.logger.info(`Nexus listening on http://localhost:${port}`);
        server.logger.info(`Load balancing strategy: ${server.loadBalancer.getStrategy()}`);
        server.logger.info(`Routes configured: ${Object.keys(config.backends).join(', ')}`);

        // Log health checker status
        const healthyCount = server.healthChecker.getHealthyBackends().length;
        const totalBackends = server.healthChecker.getStatus().size;
        server.logger.info(`Health status: ${healthyCount}/${totalBackends} backends healthy`);

        // Log WAL status
        if (server.wal.enabled) {
            const walStats = server.wal.getStats();
            server.logger.info(`WAL enabled: ${config.wal?.path || './wal.log'} (${walStats.entryCount} entries)`);
        } else {
            server.logger.info('WAL disabled');
        }
    });

    return server;
}

/**
 * Gracefully shutdown the server and all components.
 * 
 * @param {http.Server} server - The running server instance
 * @param {number} [timeout=5000] - Max time to wait for connections to close
 * @returns {Promise<void>}
 */
export function shutdownServer(server, timeout = 5000) {
    return new Promise((resolve, reject) => {
        if (!server || !server.listening) {
            resolve();
            return;
        }

        const logger = server.logger || console;
        logger.info('Shutting down server...');

        // Stop health checker
        if (server.healthChecker && typeof server.healthChecker.stop === 'function') {
            server.healthChecker.stop();
        }

        // Stop WAL (flushes remaining entries)
        if (server.wal && typeof server.wal.stop === 'function') {
            server.wal.stop().catch((err) => {
                logger.error(`WAL stop error: ${err.message}`);
            });
        }

        // Set timeout for force shutdown
        const timeoutId = setTimeout(() => {
            logger.warn('Force closing connections after timeout');
            server.close(() => {
                resolve();
            });
        }, timeout);

        // Graceful shutdown
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