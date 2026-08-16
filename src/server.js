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
 * PLANNED FOR LATER PHASES (do not implement yet, just leaving hooks):
 *   Phase 2  -> wire ratelimiter.js into the pipeline (429 responses)
 *   Phase 3  -> wire auth.js (API key / HMAC token check) + tls.js
 *               (https.createServer alongside this http.createServer)
 *   Phase 4  -> replace matchRoute/pickBackend with router.js /
 *               loadbalancer.js, wire in wal.js (durability log) and
 *               metrics.js (request counters) via small hook functions
 * -----------------------------------------------------------------------
 */

import http from 'node:http';
import { URL } from 'node:url';

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
// -------------------------------------------------------------------------
function createRequestHandler(config) {
    return function handleRequest(req, res) {
        const startTime = Date.now();
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // TODO (Phase 2): rate limiter check here -> 429 if exceeded
        // TODO (Phase 3): auth check here -> 401/403 if invalid/missing
        // TODO (Phase 4): wal.js append-before-forward call here

        const route = matchRoute(parsedUrl.pathname, config);
        if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found', detail: `no backend configured for ${parsedUrl.pathname}` }));
            logRequest(req, 404, startTime);
            return;
        }

        const pool = config.backends[route];
        const backend = pickBackend(route, pool);
        if (!backend) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway', detail: `no backends available for ${route}` }));
            logRequest(req, 502, startTime);
            return;
        }

        // Hook the 'finish' event so we log the *actual* status code the
        // client received, once forwarding completes.
        res.on('finish', () => logRequest(req, res.statusCode, startTime));

        forwardRequest(req, res, backend);

        // TODO (Phase 4): metrics.js request counter increment here
    };
}

// -------------------------------------------------------------------------
// Minimal inline request logger for Phase 1.
// Owner note: Saikat's logger.js will replace this in Phase 1/2 — this is
// just enough to see traffic flowing during early development/testing.
// -------------------------------------------------------------------------
function logRequest(req, statusCode, startTime) {
    const durationMs = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${statusCode} ${durationMs}ms`);
}

/**
 * Create (but do not start) the Nexus HTTP server for the given config.
 * Returns a plain node:http Server instance so the caller (cli.js) decides
 * when/how to call .listen().
 */
export function createServer(config) {
    if (!config || !config.backends) {
        throw new Error('createServer: a valid config with "backends" is required');
    }

    return http.createServer(createRequestHandler(config));
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
        console.log(`[server] Nexus listening on http://localhost:${port}`);
    });

    return server;
}