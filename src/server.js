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
 *     - logger.js for structured logging
 *     - metrics.js for request metrics
 *
 *   Remaining hooks for Phase 2/3 features:
 *     - Rate limiting (ratelimiter.js) - TODO
 *     - Authentication (auth.js) - TODO
 *     - TLS/HTTPS (tls.js) - TODO
 *     - Write-Ahead Log (wal.js) - TODO
 * -----------------------------------------------------------------------
 */

import http from 'node:http';
import { URL } from 'node:url';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { matchRoute } from './router.js';
import { createLoadBalancer } from './loadbalancer.js';

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
// inline in createServer) so it's easy to unit-test later and easy to
// extend in Phase 2/3 with rate-limit + auth checks before forwarding.
//
// `logger`, `metrics`, and `loadBalancer` are created once in createServer()
// and passed in here (dependency injection) rather than imported as globals,
// so tests can pass their own instances and nothing leaks state between
// server instances.
// -------------------------------------------------------------------------
function createRequestHandler(config, logger, metrics, loadBalancer) {
    return function handleRequest(req, res) {
        const startTime = Date.now();
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // Metrics route is served directly by Nexus itself — it never
        // gets proxied to a backend. Must be checked before route
        // matching so it doesn't need an entry in config.backends.
        if (config.metrics && config.metrics.path && parsedUrl.pathname === config.metrics.path) {
            metrics.handleMetricsRoute(req, res);
            logger.logRequest(req, res.statusCode, startTime);
            return;
        }

        // TODO (Phase 2): rate limiter check here -> 429 if exceeded
        // TODO (Phase 3): auth check here -> 401/403 if invalid/missing
        // TODO (Phase 4): wal.js append-before-forward call here

        // Match the route using router.js (supports host-based routing)
        const route = matchRoute(parsedUrl.pathname, config, req.headers.host);
        if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found', detail: `no backend configured for ${parsedUrl.pathname}` }));
            logger.logRequest(req, 404, startTime);
            metrics.recordRequest({ route: null, backend: null, statusCode: 404, durationMs: Date.now() - startTime });
            return;
        }

        // Pick a backend using loadbalancer.js
        const backend = loadBalancer.pickBackend(route);
        if (!backend) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway', detail: `no backends available for ${route}` }));
            logger.logRequest(req, 502, startTime);
            metrics.recordRequest({ route, backend: null, statusCode: 502, durationMs: Date.now() - startTime });
            return;
        }

        // Track active connections for least-connections strategy
        loadBalancer.incrementConnections(route, backend);

        // Hook the 'finish' event so we log/record the *actual* status
        // code the client received, once forwarding completes.
        res.on('finish', () => {
            // Decrement connection count when request completes
            loadBalancer.decrementConnections(route, backend);

            logger.logRequest(req, res.statusCode, startTime);
            metrics.recordRequest({
                route,
                backend,
                statusCode: res.statusCode,
                durationMs: Date.now() - startTime,
            });
        });

        // Handle errors during response to ensure connection tracking cleanup
        res.on('error', (err) => {
            loadBalancer.decrementConnections(route, backend);
            logger.error(`Response error for ${route} -> ${backend}: ${err.message}`);
        });

        forwardRequest(req, res, backend);
    };
}

/**
 * Create (but do not start) the Nexus HTTP server for the given config.
 * Returns a plain node:http Server instance so the caller (cli.js) decides
 * when/how to call .listen().
 *
 * Also returns the `logger`/`metrics`/`loadBalancer` instances attached
 * to the server object so cli.js or dashboard.js can reuse the SAME
 * instances rather than creating their own.
 */
export function createServer(config) {
    if (!config || !config.backends) {
        throw new Error('createServer: a valid config with "backends" is required');
    }

    const logger = createLogger(config);
    const metrics = createMetrics();
    const loadBalancer = createLoadBalancer(config);

    const server = http.createServer(
        createRequestHandler(config, logger, metrics, loadBalancer)
    );

    // Attach instances to server for reuse
    server.logger = logger;
    server.metrics = metrics;
    server.loadBalancer = loadBalancer;

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
    });

    return server;
}