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
 * CURRENT SCOPE (Phase 1 — Hours 0-12, "Core Skeleton")
 *   Per the build plan, at this stage the only goal is: a request hits
 *   Nexus, gets forwarded to a backend for the matching route, and the
 *   response comes back. Nothing fancy yet. To make that testable today
 *   (before router.js / loadbalancer.js exist), this file contains two
 *   small INTERNAL placeholder helpers:
 *
 *     - matchRoute()   -> temporary stand-in for src/router.js
 *     - pickBackend()  -> temporary stand-in for src/loadbalancer.js
 *
 *   These are intentionally isolated at the top of the file so that once
 *   Kanchan's router.js / loadbalancer.js modules exist, we delete these
 *   two functions and import the real ones instead — nothing else in
 *   this file needs to change.
 *
 * WIRING LOG (who changed what, so nobody overwrites each other)
 *   [Saikat] Wired in src/logger.js and src/metrics.js in place of the
 *   old inline logRequest() placeholder:
 *     - logger.js replaces logRequest() — same call site, same info.
 *     - metrics.js is mounted at config.metrics.path (GET returns JSON)
 *       AND records every completed request (route, backend, status,
 *       duration) via metrics.recordRequest() on the 'finish' event.
 *   Ashish/Kanchan: if you touch the request pipeline (auth, rate limit,
 *   WAL), please keep the existing `logger`/`metrics` instances flowing
 *   through — they're created once in createServer() and passed into
 *   createRequestHandler(config, logger, metrics). Don't create new
 *   instances per-request, and don't console.log() directly — use the
 *   `logger` param that's already there.
 *
 * PLANNED FOR LATER PHASES (do not implement yet, just leaving hooks):
 *   Phase 2  -> wire ratelimiter.js into the pipeline (429 responses)
 *   Phase 3  -> wire auth.js (API key / HMAC token check) + tls.js
 *               (https.createServer alongside this http.createServer)
 *   Phase 4  -> replace matchRoute/pickBackend with router.js /
 *               loadbalancer.js, wire in wal.js (durability log)
 * -----------------------------------------------------------------------
 */

import http from 'node:http';
import { URL } from 'node:url';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';

// -------------------------------------------------------------------------
// TEMPORARY (Phase 1 only) — replace with `import { matchRoute } from
// './router.js'` once router.js is implemented.
//
// Very small "longest prefix wins" matcher: config.backends is an object
// like { "/api": [...], "/auth": [...] }. We pick the most specific
// (longest) route key that the request path starts with.
// -------------------------------------------------------------------------
function matchRoute(pathname, config) {
    const routes = Object.keys(config.backends);
    let best = null;

    for (const route of routes) {
        if (pathname === route || pathname.startsWith(route)) {
            if (best === null || route.length > best.length) {
                best = route;
            }
        }
    }

    return best; // route key (string) or null if nothing matched
}

// -------------------------------------------------------------------------
// TEMPORARY (Phase 1 only) — replace with `import { pickBackend } from
// './loadbalancer.js'` once loadbalancer.js is implemented (round-robin /
// least-connections / health-check-aware selection).
//
// For now: plain round-robin over whatever backends are listed for the
// route. No health checks yet — that's Phase 2 (healthcheck.js).
// -------------------------------------------------------------------------
const roundRobinCounters = new Map(); // route -> next index

function pickBackend(route, pool) {
    if (!pool || pool.length === 0) return null;

    const current = roundRobinCounters.get(route) ?? 0;
    const backend = pool[current % pool.length];
    roundRobinCounters.set(route, current + 1);

    return backend; // e.g. "http://localhost:4001"
}

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
// `logger` and `metrics` are created once in createServer() and passed
// in here (dependency injection) rather than imported as globals, so
// tests can pass their own instances and nothing leaks state between
// server instances.
// -------------------------------------------------------------------------
function createRequestHandler(config, logger, metrics) {
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

        const route = matchRoute(parsedUrl.pathname, config);
        if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found', detail: `no backend configured for ${parsedUrl.pathname}` }));
            logger.logRequest(req, 404, startTime);
            metrics.recordRequest({ route: null, backend: null, statusCode: 404, durationMs: Date.now() - startTime });
            return;
        }

        const pool = config.backends[route];
        const backend = pickBackend(route, pool);
        if (!backend) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway', detail: `no backends available for ${route}` }));
            logger.logRequest(req, 502, startTime);
            metrics.recordRequest({ route, backend: null, statusCode: 502, durationMs: Date.now() - startTime });
            return;
        }

        // Hook the 'finish' event so we log/record the *actual* status
        // code the client received, once forwarding completes.
        res.on('finish', () => {
            logger.logRequest(req, res.statusCode, startTime);
            metrics.recordRequest({
                route,
                backend,
                statusCode: res.statusCode,
                durationMs: Date.now() - startTime,
            });
        });

        forwardRequest(req, res, backend);
    };
}

/**
 * Create (but do not start) the Nexus HTTP server for the given config.
 * Returns a plain node:http Server instance so the caller (cli.js) decides
 * when/how to call .listen().
 *
 * Also returns the `logger`/`metrics` instances attached to the server
 * object (server.logger / server.metrics) so cli.js or dashboard.js can
 * reuse the SAME instances rather than creating their own — this matters
 * for dashboard.js in particular, which needs to read the exact counters
 * this server is updating, not a separate empty set.
 */
export function createServer(config) {
    if (!config || !config.backends) {
        throw new Error('createServer: a valid config with "backends" is required');
    }

    const logger = createLogger(config);
    const metrics = createMetrics();

    const server = http.createServer(createRequestHandler(config, logger, metrics));
    server.logger = logger;
    server.metrics = metrics;

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
    });

    return server;
}
