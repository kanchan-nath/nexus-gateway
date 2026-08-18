# STDLIB.md — Zero-Dependency Substitution Log

**Owner:** Saikat
**Purpose:** For every piece of functionality in Nexus that would
normally pull in an npm package, this file documents exactly which
Node.js built-in module(s) we used instead. This is our evidence for
the "Zero-Dependency Craft" judging criterion (30%) and the "Package
Killer" / "STDLIB Log" bonuses.

**How to read this file:** each row is one substitution. **Status**
tells you whether the substitution is actually implemented and running
today (`Done`) or is the team's committed plan for a module that
hasn't been built yet (`Planned`, per the Phase build order in the
hackathon plan doc). Whoever builds a `Planned` file should flip its
row to `Done` and add a one-line note on how it actually turned out,
in the same commit that adds the module.

---

## Substitutions

| # | Would Normally Use | Instead: Node Stdlib | Used In | Status | Notes |
|---|---|---|---|---|---|
| 1 | Express | `node:http` | `server.js` | Done | `http.createServer` + manual `http.request` proxying/piping is the entire "reverse proxy" mechanic — no routing framework needed. |
| 2 | `dotenv` / config libs (`convict`, `nconf`) | `node:fs` + `node:path` + `JSON.parse` + `process.env` | `config.js` | Done | Config is loaded with `fs.readFileSync`, parsed with `JSON.parse`, and sensitive values (API keys, HMAC secret) are overridable via `process.env` — no `.env` file parser needed. |
| 3 | `winston` / `pino` | `console` + `Date` | `logger.js` | Done | Structured, leveled logging (`debug`/`info`/`error`) with ISO timestamps, built entirely on `console.log`/`console.error` + `Date.toISOString()`. |
| 4 | `prom-client` | Plain JS objects/`Map` + `Array.prototype.reduce` | `metrics.js` | Done | In-memory counters (total requests, per-backend, per-route, rolling-window average latency) using a `Map` for per-key buckets and a plain circular-buffer array for the rolling window — no metrics/stats library. |
| 5 | `path-to-regexp` / Express router | Plain string matching (`startsWith`, longest-prefix-wins loop) | `router.js` (currently a temporary inline version inside `server.js`, to be extracted) | Planned | Path matching doesn't need a regex router for a prefix-based gateway; a simple longest-match loop over `Object.keys(config.backends)` is sufficient and easier to reason about. |
| 6 | Custom/3rd-party load-balancing libs | Plain counter (`Map<route, index>`) for round-robin; a second `Map` for in-flight counts for least-connections | `loadbalancer.js` | Planned | Round-robin is just "next index modulo pool length" — no state machine library needed. |
| 7 | `jsonwebtoken` | `node:crypto` (`crypto.createHmac('sha256', secret)`) | `auth.js` | Planned | Signed tokens via HMAC-SHA256 give the same tamper-evidence guarantee as a JWT library, without pulling one in. This is the team's "Package Killer" bonus target. |
| 8 | `bcrypt` (if we end up hashing anything, e.g. stored API keys) | `node:crypto` (`crypto.scrypt` / `crypto.timingSafeEqual`) | `auth.js` | Planned | Only needed if API keys are ever stored hashed rather than compared in plaintext from config; `crypto.timingSafeEqual` also protects the plain comparison path from timing attacks either way. |
| 9 | `express-rate-limit` | Plain `Map<ip, {tokens, lastRefill}>` + `Date.now()` math | `ratelimiter.js` | Planned | Token-bucket algorithm implemented by hand — refill amount is computed from elapsed time on each request, no background timers/intervals required. |
| 10 | `node-cron` / interval-scheduling libs | `setInterval` | `healthcheck.js` | Planned | A periodic `http.get` health probe on each backend is just a `setInterval` loop; no cron/scheduling library needed for a fixed-interval check. |
| 11 | `winston-daily-rotate-file` / durability/queue libs (e.g. Bull, better-queue) | `node:fs` (`fs.appendFileSync`, or a buffered `fs.createWriteStream`) | `wal.js` | Planned | The Write-Ahead Log is just newline-delimited JSON appended to a file; "replay" mode is just reading that file back line by line with `fs.readFileSync` + `.split('\n')`. |
| 12 | `openssl`-wrapping libs / `node-forge` (at runtime) | `node:tls` + `node:https` + `node:crypto` | `tls.js` | Planned | Nexus only *loads and serves* a cert/key pair at runtime via `tls`/`https`; one-time cert *generation* during dev setup may still shell out to `openssl`, but that's a one-time dev-machine step documented in the README, not a runtime dependency of Nexus itself. |
| 13 | `socket.io` / `ws` (WebSockets) | Plain HTTP + Server-Sent Events (`res.write('data: ...\n\n')`, no upgrade handshake) | `dashboard.js` | Planned | SSE is just a long-lived HTTP response with a specific content type and a `data:`-prefixed write per message — no WebSocket library or protocol upgrade needed for one-directional server-to-browser push. |
| 14 | `chart.js` / `d3` (client-side charting) | `<canvas>` 2D context, plain vanilla JS | `public/index.html` | Planned | The live dashboard's bar chart is drawn with raw `CanvasRenderingContext2D` calls (`fillRect`, etc.) driven by the SSE payload — no charting library shipped to the browser. |
| 15 | `commander` / `yargs` (CLI argument parsing) | `process.argv` (manual parsing) | `cli.js` | Planned | Nexus only needs a couple of flags/subcommands (`nexus start --config <path>`), which a short manual `process.argv` parse handles without a CLI framework. |
| 16 | `jest` / `mocha` + `chai`/`sinon` | `node:test` + `node:assert/strict` | `test/*.test.js` | Done | Every test file in this repo (`logger.test.js`, `metrics.test.js`, `config.test.js`, plus the placeholder files) runs on Node's built-in test runner via `node --test` — no test framework or assertion library installed. |

---

## Summary

- **16 substitutions documented**, well past the 10+ target for the STDLIB Log bonus.
- **6 are `Done`** today (config, logger, metrics, server's core proxy, and the whole test suite).
- **10 are `Planned`**, each mapped to a specific teammate's file per the build plan — this table doubles as a checklist: when a `Planned` file lands, flip its row to `Done`.
- Every row maps to a Node.js **built-in** (`http`, `https`, `tls`, `fs`, `path`, `crypto`, `net`, `Map`/`Array`, `console`, `Date`, `process`, `setInterval`, `<canvas>`) — `package.json`'s `dependencies` field stays empty for the entire project.
