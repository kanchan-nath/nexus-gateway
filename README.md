# Nexus

A zero-dependency reverse proxy / API gateway built entirely on Node.js
built-in modules — no Express, no npm packages of any kind. Built in 72
hours for **Hackathon Raptors — Track C: Web & Network**.

**Co-owners:** Biyas, Saikat
**Status of this document:** skeleton drafted by Saikat — sections
marked `[PLACEHOLDER - Biyas]` still need screenshots/video/demo content
before submission. Everything else reflects the actual state of the
repo as of this commit.

---

## What Nexus does

Nexus sits in front of one or more backend servers and:

- Routes incoming requests to backends based on path (and, later, host)
- Load-balances across multiple backend instances
- Terminates TLS (HTTPS in, HTTP to backend)
- Rate-limits clients (token bucket per IP)
- Authenticates requests (API key, or a signed HMAC token)
- Writes a Write-Ahead Log of every request before forwarding, for
  durability/replay
- Serves a live metrics dashboard over Server-Sent Events — no
  WebSocket library needed

Every one of the above is built on Node's standard library only. See
[`STDLIB.md`](./STDLIB.md) for the full substitution list (what we'd
normally reach for an npm package for, and what stdlib module replaces
it).

---

## Project status

This README documents the repo **as it stands right now**, not the
finished product. Some modules are implemented and tested; others are
still empty stubs per the team's phased build plan. Check
[`STDLIB.md`](./STDLIB.md)'s Status column for the authoritative
per-module list — the short version:

**Implemented today:**
- `src/config.js` — loads/validates `nexus.config.json`, applies env
  overrides and defaults (Kanchan)
- `src/logger.js` — leveled, timestamped console logger (Saikat)
- `src/metrics.js` — in-memory request counters, rolling-window
  latency, `/nexus/metrics` JSON endpoint (Saikat)
- `src/server.js` — core `http.createServer` request pipeline, with a
  temporary inline router/load-balancer until `router.js`/
  `loadbalancer.js` land (Ashish)
- Test suite for the above (`node --test`) — 42 passing, 19 skipped
  placeholders for not-yet-built modules, 0 failing

- `src/dashboard.js` — SSE endpoint pushing `metrics.getSnapshot()`
  every `pushIntervalMs` (Biyas)
- `public/index.html` — live dashboard UI, plain HTML/CSS/vanilla JS,
  no framework (Biyas)
- `examples/backend-echo.js` — dummy backend for demo/dev, echoes
  requests, plus `/health` and `?slow=1` for demoing health checks and
  load balancing visibly (Biyas)

**Still not yet implemented:** `tls.js`

**Integration note:** `dashboard.js` needs one small wire-up in
`server.js` (mounting `config.dashboard.path` the same way
`config.metrics.path` is already mounted) — see the header comment in
`dashboard.js` for the exact diff.

---

## Getting started

### Requirements

Node.js **18+** (for `node:test` and stable `node:` protocol imports).
Nothing else — no `npm install` step, because there are no
dependencies.

```bash
node -v   # should print v18.x or higher
```

### Running Nexus

> **Note:** `src/cli.js` (the intended single entrypoint,
> `node src/cli.js start --config nexus.config.json`) and `build.sh`
> haven't been built yet. Until they exist, start the server directly:

```bash
node --input-type=module -e "
import { loadConfig } from './src/config.js';
import { startServer } from './src/server.js';
const config = loadConfig('./nexus.config.json');
startServer(config);
"
```

Once `cli.js`/`build.sh` land, this will collapse to:

```bash
./build.sh
# which just runs: node src/cli.js start --config nexus.config.json
```

### Running the tests

```bash
node --test
```

This runs every `test/*.test.js` file with Node's built-in test runner
— no Jest, no Mocha. Expect output like:

- tests 61
- suites 19
- pass 42
- fail 0
- skipped 19


The 19 skipped tests are intentional placeholders (`test.skip(...)`)
for modules that haven't been implemented yet — see each skipped
file's header comment for exactly what to fill in and who owns it.

> `package.json`'s `"test"` script is still the default placeholder
> (`echo "Error: no test specified" && exit 1`). Someone should update
> it to `"node --test"` before submission so `npm test` works too.

---

## Configuration

Nexus is configured entirely through a single JSON file,
`nexus.config.json`:

```json
{
  "listen": { "http": 8080, "https": 8443 },
  "backends": {
    "/api": ["http://localhost:4001", "http://localhost:4002"]
  },
  "loadBalancing": "round-robin",
  "rateLimit": { "windowMs": 1000, "max": 20 },
  "auth": { "required": true, "apiKeys": ["demo-key-123"] }
}
```

`src/config.js` validates this shape and fills in defaults for
anything you omit (health check interval, WAL path, metrics path,
dashboard path, log level — see `config.js`'s `applyDefaults()` for
the full list).

**Secrets via environment variables** (so they never have to live in
the config file or git history):

| Env var | Overrides |
|---|---|
| `NEXUS_API_KEYS` | comma-separated list -> `config.auth.apiKeys` |
| `NEXUS_HMAC_SECRET` | -> `config.auth.hmac.secret` |

---

## API endpoints Nexus itself serves

These are handled directly by Nexus (not proxied to a backend):

| Path | Method | Description | Status |
|---|---|---|---|
| `config.metrics.path` (default `/nexus/metrics`) | GET | Live JSON snapshot: total requests, error rate, rolling-window average latency, per-backend and per-route breakdown | Implemented |
| `config.dashboard.path` (default `/nexus/dashboard/stream`) | GET | Server-Sent Events stream pushing a metrics snapshot every `pushIntervalMs` | Implemented (Biyas) — needs the one-line mount in `server.js` |

Example `/nexus/metrics` response shape:

```json
{
  "startedAt": "2026-08-18T07:03:20.635Z",
  "uptimeSeconds": 42,
  "totalRequests": 128,
  "errorCount": 3,
  "errorRate": 0.02,
  "avgLatencyMs": 14.6,
  "rollingWindowSize": 100,
  "rollingWindowSamples": 100,
  "perBackend": {
    "http://localhost:4001": { "requests": 64, "errors": 1, "avgLatencyMs": 13.9 }
  },
  "perRoute": {
    "/api": { "requests": 128, "errors": 3, "avgLatencyMs": 14.6 }
  }
}
```

---

## Running the full demo locally

Once `server.js` mounts `dashboard.js` (see integration note above),
this is the full loop to demo Nexus end-to-end:

```bash
# 1. Start two dummy backends (separate terminals)
node examples/backend-echo.js --port 4001 --name backend-A
node examples/backend-echo.js --port 4002 --name backend-B

# 2. Start Nexus
node --input-type=module -e "
import { loadConfig } from './src/config.js';
import { startServer } from './src/server.js';
const config = loadConfig('./nexus.config.json');
startServer(config);
"

# 3. Open the dashboard
# Serve public/index.html any way you like, e.g.:
npx --yes serve public
# then open http://localhost:3000 in a browser — it connects to
# http://localhost:8080/nexus/dashboard/stream automatically.

# 4. Generate traffic
curl -H "X-API-Key: demo-key-123" http://localhost:8080/api/hello

# 5. Demo load balancing + health checks
curl -H "X-API-Key: demo-key-123" "http://localhost:4001/health?fail=1"
# watch the dashboard's Backends table mark backend-A unhealthy and
# traffic shift entirely to backend-B

# 6. Demo rate limiting
for i in $(seq 1 30); do curl -H "X-API-Key: demo-key-123" http://localhost:8080/api/hello; done
# after `rateLimit.max` requests in the window, expect 429s
```

---

## Project structure

``` txt
nexus/
├── src/
│ ├── cli.js → Kanchan [done]
│ ├── config.js → Kanchan [done]
│ ├── server.js → Ashish [done — Phase 1 core, hooks for Phase 2/3]
│ ├── tls.js → Ashish [not yet implemented]
│ ├── router.js → Kanchan [done]
│ ├── loadbalancer.js → Kanchan [done]
│ ├── healthcheck.js → Kanchan [done]
│ ├── ratelimiter.js → Ashish [not yet implemented]
│ ├── auth.js → Ashish [not yet implemented]
│ ├── wal.js → Kanchan [done]
│ ├── metrics.js → Saikat [done]
│ ├── logger.js → Saikat [done]
│ └── dashboard.js → Biyas [done]
├── public/
│ └── index.html → Biyas [done]
├── test/
│ ├── config.test.js → Kanchan [done]
│ ├── logger.test.js → Saikat [done]
│ ├── metrics.test.js → Saikat [done]
│ ├── router.test.js → Kanchan [placeholder scaffold]
│ ├── loadbalancer.test.js→ Ashish [placeholder scaffold]
│ ├── ratelimiter.test.js → Saikat [placeholder scaffold]
│ └── auth.test.js → Biyas [placeholder scaffold]
├── examples/
│ └── backend-echo.js → Biyas [done]
├── README.md → Biyas + Saikat [this file]
├── STDLIB.md → Saikat [done]
├── nexus.config.json → Kanchan [done]
└── build.sh → Ashish [not yet implemented]
```

---

## Zero-dependency approach

Full details in [`STDLIB.md`](./STDLIB.md), including the exact stdlib
module used in place of each library we'd normally reach for. Short
version: `http`/`https`/`tls`/`net` replace Express and TLS libraries,
`crypto` replaces `jsonwebtoken`/`bcrypt`, and `node:test` replaces
Jest/Mocha. `package.json`'s `dependencies` field is, and will remain,
empty.

---

## Screenshots

`[PLACEHOLDER - Biyas]` — add screenshots of:
- The live dashboard mid-demo (request counts moving)
- A `curl` round trip through Nexus to a backend
- Load balancing across two backend instances
- A killed backend being skipped after health check marks it dead
- Rate limiting kicking in (a 429 response)

---

## Demo video

`[PLACEHOLDER - Biyas]` — link the 5-minute demo video here once
recorded. Suggested walkthrough order (per the team plan): show config
→ start Nexus → show load balancing → show a killed backend being
skipped → show rate limiting → show the live dashboard → show the WAL
log file.

---

## Team

| Member | Focus area |
|---|---|
| Kanchan | Config, routing, load balancing, health checks, WAL, integration |
| Ashish | Server core, TLS, rate limiting, auth, build script |
| Saikat | Logging, metrics, tests, STDLIB.md |
| Biyas | Dashboard UI, dummy backend, README, demo video |