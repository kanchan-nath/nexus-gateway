/**
 * examples/backend-echo.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   A tiny dummy backend server used to demo Nexus. It stands in for a
 *   "real" microservice: Nexus proxies to instances of THIS file during
 *   dev/testing and the live demo video.
 *
 *   Owner: Biyas
 *   Zero-dep substitution: `http` (built-in) — no Express needed for a
 *   stub this small.
 *
 * PHASE 1 (hour 0-12): plain echo — returns method/path/headers as JSON
 * PHASE 2 (hour 12-30): extended with a /health route (for healthcheck.js)
 *   and an artificial delay flag (?slow=1) so the team can visibly demo
 *   load balancing and health checks in the dashboard.
 *
 * USAGE
 *   node examples/backend-echo.js                  # listens on :4001
 *   node examples/backend-echo.js --port 4002       # pick a different port
 *   node examples/backend-echo.js --port 4002 --name backend-B
 *
 *   Then point nexus.config.json's backends at these ports, e.g.:
 *     "backends": { "/api": ["http://localhost:4001", "http://localhost:4002"] }
 *
 *   Health check: GET /health -> 200 { "status": "ok", ... }
 *   Slow demo:    GET /api/anything?slow=1 -> same response, delayed
 *                 ~800-2000ms (random) so the dashboard's latency graph
 *                 visibly reacts, and you can demo the health checker
 *                 marking a backend "unhealthy" by adding &fail=1 too.
 * -----------------------------------------------------------------------
 */

import http from 'node:http';

// -------------------------------------------------------------------------
// CLI flags (manual parsing — zero-dependency, matches cli.js style)
// -------------------------------------------------------------------------
function parseArgs(argv) {
    const args = argv.slice(2);
    const result = { port: 4001, name: 'backend' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) {
            result.port = Number(args[i + 1]);
            i++;
        } else if (args[i] === '--name' && args[i + 1]) {
            result.name = args[i + 1];
            i++;
        }
    }
    return result;
}

const { port, name } = parseArgs(process.argv);

// -------------------------------------------------------------------------
// Request handler
// -------------------------------------------------------------------------
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // ---- /health : used by healthcheck.js -----------------------------
    // Supports ?fail=1 so the team can demo the load balancer marking
    // this backend unhealthy and skipping it (kill the health signal
    // without killing the process).
    if (url.pathname === '/health') {
        if (url.searchParams.get('fail') === '1') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'unhealthy', backend: name }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', backend: name, port }));
        return;
    }

    // ---- everything else: echo the request back as JSON ---------------
    // ?slow=1 adds a random 800-2000ms delay so latency shows up
    // visibly on the live dashboard during the demo.
    const respond = () => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const payload = {
                backend: name,
                port,
                method: req.method,
                path: url.pathname + url.search,
                headers: req.headers,
                body: body || null,
                receivedAt: new Date().toISOString(),
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload, null, 2));
        });
    };

    if (url.searchParams.get('slow') === '1') {
        const delayMs = 800 + Math.floor(Math.random() * 1200);
        setTimeout(respond, delayMs);
    } else {
        respond();
    }
});

server.listen(port, () => {
    console.log(`[backend-echo:${name}] listening on http://localhost:${port}`);
    console.log(`[backend-echo:${name}] health: http://localhost:${port}/health`);
});