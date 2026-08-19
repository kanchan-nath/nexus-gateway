/**
 * src/dashboard.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Live metrics dashboard backend for Nexus. Pushes a metrics.js
 *   snapshot to the browser every `config.dashboard.pushIntervalMs`,
 *   over a Server-Sent Events (SSE) stream — no socket.io, no WebSocket
 *   library. SSE is plain HTTP: we just keep the response open and
 *   write `data: <json>\n\n` chunks.
 *
 *   Owner: Biyas
 *   Zero-dep substitution: `http` (built-in, reused from server.js) +
 *   `res.write()` replace socket.io / Grafana's push mechanism.
 *
 * WHAT THIS FILE DOES
 *   - Exposes createDashboard(config, metrics) which returns a
 *     `handleDashboardStream(req, res)` handler.
 *   - On each new connection: sets SSE headers, sends an immediate
 *     snapshot, then sends another every pushIntervalMs.
 *   - Cleans up its interval when the client disconnects (req 'close'),
 *     so we don't leak timers per dashboard tab left open.
 *   - Does NOT reimplement any counters — always reads through
 *     metrics.getSnapshot(), per the contract metrics.js documents.
 *
 * INTEGRATION — one small addition needed in server.js (owner: Ashish)
 * -----------------------------------------------------------------------
 *   server.js already mounts /nexus/metrics before route matching. The
 *   dashboard stream needs the same treatment. In createRequestContext():
 *
 *     import { createDashboard } from './dashboard.js';
 *     ...
 *     const dashboard = createDashboard(config, metrics);
 *
 *   and in createRequestHandler()'s handleRequest, right after the
 *   /nexus/metrics check:
 *
 *     if (config.dashboard?.path && parsedUrl.pathname === config.dashboard.path) {
 *       return dashboard.handleDashboardStream(req, res);
 *     }
 *
 *   (`dashboard` needs to be threaded through createRequestHandler()'s
 *   params the same way `metrics` already is.) Until that's wired in,
 *   this file works standalone — see the `if (import.meta.url ...)`
 *   block at the bottom for a way to smoke-test it directly.
 * -----------------------------------------------------------------------
 */

/**
 * @param {object} config - full Nexus config (uses config.dashboard.pushIntervalMs)
 * @param {object} metrics - the SAME metrics instance server.js created
 *   (dependency injection, not a global — matches metrics.js's own note
 *   about avoiding a hidden singleton).
 */
export function createDashboard(config, metrics) {
    const pushIntervalMs = config.dashboard?.pushIntervalMs || 1000;

    return {
        /**
         * SSE handler — mount this at config.dashboard.path.
         * Keeps the connection open and streams metrics.getSnapshot()
         * every pushIntervalMs until the client disconnects.
         */
        handleDashboardStream(req, res) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                // Allow the dashboard page to be served from a different
                // port during local dev (e.g. a static file server) —
                // harmless to leave on for the production demo too.
                'Access-Control-Allow-Origin': '*',
            });

            // flushHeaders() sends the headers immediately instead of
            // waiting for the first res.write() — without this some
            // browsers/proxies delay showing the connection as "open".
            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            const send = () => {
                const snapshot = metrics.getSnapshot();
                res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
            };

            send(); // immediate first push, don't make the UI wait a full interval
            const timer = setInterval(send, pushIntervalMs);

            // SSE keep-alive comment every 20s so idle proxies/load
            // balancers don't time out the connection during a quiet demo.
            const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);

            const cleanup = () => {
                clearInterval(timer);
                clearInterval(keepAlive);
            };

            req.on('close', cleanup);
            res.on('close', cleanup);
        },
    };
}

// -------------------------------------------------------------------------
// Standalone smoke test: run this file directly to confirm the SSE
// stream works before it's wired into server.js.
//   node src/dashboard.js
//   curl http://localhost:5055/nexus/dashboard/stream
// -------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    const http = await import('node:http');
    const { createMetrics } = await import('./metrics.js');

    const metrics = createMetrics();
    // Fake a few requests so the stream isn't just zeros.
    setInterval(() => {
        metrics.recordRequest({
            route: '/api',
            backend: 'http://localhost:4001',
            statusCode: Math.random() < 0.1 ? 500 : 200,
            durationMs: Math.floor(50 + Math.random() * 200),
        });
    }, 500);

    const dashboard = createDashboard({ dashboard: { pushIntervalMs: 1000 } }, metrics);
    const server = http.default.createServer((req, res) => {
        if (req.url === '/nexus/dashboard/stream') {
            return dashboard.handleDashboardStream(req, res);
        }
        res.writeHead(404).end();
    });
    server.listen(5055, () => console.log('dashboard smoke test on http://localhost:5055/nexus/dashboard/stream'));
}