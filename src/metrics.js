/**
 * src/metrics.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Zero-dependency in-memory metrics collector for Nexus. Tracks total
 *   requests, per-backend and per-route breakdowns, error counts, and a
 *   rolling-window average latency — all with plain JS objects/arrays,
 *   no external stats/metrics library. STDLIB.md entry: Normally
 *   prom-client -> Instead: plain objects + Array.reduce.
 *
 *   Owner: Saikat
 *   Status: DONE — this file is complete and ready to use.
 *
 * WHO NEEDS TO DO WHAT, AND WHEN
 *   - Ashish (server.js): ALREADY wired in (by Saikat) — createMetrics(config)
 *     is created once in createServer(), recordRequest() is called from the
 *     res.on('finish') handler, and the /nexus/metrics route is mounted
 *     before the proxy logic in the request handler. No action needed
 *     unless you want to record something metrics.js doesn't currently
 *     capture (e.g. rate-limit rejections) — see recordRequest() below,
 *     it's safe to call from ratelimiter.js/auth.js too if you want those
 *     counted; just import { getMetricsInstance } is NOT exposed on
 *     purpose (avoids a hidden singleton) — instead pass the same
 *     `metrics` object server.js already created into any module that
 *     needs to record something (dependency injection, not a global).
 *   - Biyas (dashboard.js): call metrics.getSnapshot() every
 *     config.dashboard.pushIntervalMs and push the result over SSE as
 *     `data: ${JSON.stringify(snapshot)}\n\n`. Do not reimplement
 *     counters in dashboard.js — always read through getSnapshot().
 *   - Kanchan (loadbalancer.js/healthcheck.js): no dependency needed,
 *     but if you want "backend marked dead" to show up in metrics later,
 *     ask Saikat before adding new fields so the dashboard/tests don't
 *     silently break.
 *
 * WHAT COUNTS AS AN "ERROR"
 *   Any response with statusCode >= 400 (both 4xx client errors like our
 *   own 404/429/401 and 5xx backend/gateway errors like 502/503) counts
 *   toward errorCount. This is a deliberate, simple threshold — change
 *   ERROR_STATUS_THRESHOLD below if the team wants 5xx-only.
 *
 * LATENCY AVERAGING
 *   The TOP-LEVEL avgLatencyMs is a ROLLING WINDOW average (default: last
 *   100 requests) so the live dashboard reflects *current* behavior, not
 *   a number that gets harder to move the longer the demo runs.
 *   The PER-BACKEND and PER-ROUTE avgLatencyMs are simple ALL-TIME
 *   averages (total duration / total requests for that key) — cheap to
 *   maintain and good enough for a breakdown view.
 * -----------------------------------------------------------------------
 */

const DEFAULT_ROLLING_WINDOW_SIZE = 100;
const ERROR_STATUS_THRESHOLD = 400;

function round2(n) {
    return Math.round(n * 100) / 100;
}

function makeBucket() {
    return { requests: 0, errors: 0, totalDurationMs: 0 };
}

function bucketAvgLatencyMs(bucket) {
    return bucket.requests === 0 ? 0 : round2(bucket.totalDurationMs / bucket.requests);
}

function bucketSnapshot(bucket) {
    return {
        requests: bucket.requests,
        errors: bucket.errors,
        avgLatencyMs: bucketAvgLatencyMs(bucket),
    };
}

/**
 * Create a metrics collector. Each call returns an independent instance
 * (own counters) — deliberately NOT a module-level singleton, so tests
 * can create a fresh one per test and server.js controls its lifetime.
 *
 * @param {object} [options]
 * @param {number} [options.rollingWindowSize] override for latency window
 */
export function createMetrics(options = {}) {
    const rollingWindowSize = options.rollingWindowSize || DEFAULT_ROLLING_WINDOW_SIZE;

    const state = {
        startedAt: new Date(),
        totalRequests: 0,
        errorCount: 0,
        // Circular buffer of the last N request durations, for the
        // rolling-window average. Plain array + index, no libraries.
        recentDurations: [],
        recentIndex: 0,
        perBackend: new Map(), // backendUrl -> bucket
        perRoute: new Map(), // route -> bucket
    };

    function pushRollingDuration(durationMs) {
        if (state.recentDurations.length < rollingWindowSize) {
            state.recentDurations.push(durationMs);
        } else {
            state.recentDurations[state.recentIndex] = durationMs;
            state.recentIndex = (state.recentIndex + 1) % rollingWindowSize;
        }
    }

    function rollingAvgLatencyMs() {
        if (state.recentDurations.length === 0) return 0;
        const sum = state.recentDurations.reduce((acc, d) => acc + d, 0);
        return round2(sum / state.recentDurations.length);
    }

    function getOrCreateBucket(map, key) {
        if (!map.has(key)) map.set(key, makeBucket());
        return map.get(key);
    }

    return {
        /**
         * Record a single completed request. Call this once per request,
         * after the response has finished (e.g. on the 'finish' event),
         * so statusCode/durationMs reflect what actually happened.
         *
         * @param {object} entry
         * @param {string} [entry.route]      matched route key, e.g. "/api"
         * @param {string} [entry.backend]     backend URL that served it
         * @param {number} entry.statusCode
         * @param {number} entry.durationMs
         */
        recordRequest({ route, backend, statusCode, durationMs }) {
            state.totalRequests += 1;
            if (statusCode >= ERROR_STATUS_THRESHOLD) {
                state.errorCount += 1;
            }
            pushRollingDuration(durationMs);

            if (backend) {
                const bucket = getOrCreateBucket(state.perBackend, backend);
                bucket.requests += 1;
                bucket.totalDurationMs += durationMs;
                if (statusCode >= ERROR_STATUS_THRESHOLD) bucket.errors += 1;
            }

            if (route) {
                const bucket = getOrCreateBucket(state.perRoute, route);
                bucket.requests += 1;
                bucket.totalDurationMs += durationMs;
                if (statusCode >= ERROR_STATUS_THRESHOLD) bucket.errors += 1;
            }
        },

        /**
         * Plain-object snapshot of current metrics. Safe to JSON.stringify
         * directly — used by both the /nexus/metrics HTTP route and by
         * dashboard.js for the SSE push.
         */
        getSnapshot() {
            const perBackend = {};
            for (const [key, bucket] of state.perBackend) {
                perBackend[key] = bucketSnapshot(bucket);
            }
            const perRoute = {};
            for (const [key, bucket] of state.perRoute) {
                perRoute[key] = bucketSnapshot(bucket);
            }

            return {
                startedAt: state.startedAt.toISOString(),
                uptimeSeconds: Math.floor((Date.now() - state.startedAt.getTime()) / 1000),
                totalRequests: state.totalRequests,
                errorCount: state.errorCount,
                errorRate: state.totalRequests === 0 ? 0 : round2(state.errorCount / state.totalRequests),
                avgLatencyMs: rollingAvgLatencyMs(),
                rollingWindowSize,
                rollingWindowSamples: state.recentDurations.length,
                perBackend,
                perRoute,
            };
        },

        /**
         * Ready-to-mount HTTP handler for config.metrics.path. Usage in
         * server.js's request handler:
         *
         *   if (parsedUrl.pathname === config.metrics.path) {
         *     return metrics.handleMetricsRoute(req, res);
         *   }
         *
         * Responds with plain JSON — no Prometheus text format (team
         * decision: keep it simple, easy to curl and easy for the
         * dashboard to consume directly).
         */
        handleMetricsRoute(req, res) {
            const body = JSON.stringify(this.getSnapshot(), null, 2);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
        },

        /**
         * Clears all counters. Not used by server.js — exists for tests
         * that want a clean slate without constructing a new instance.
         */
        reset() {
            state.startedAt = new Date();
            state.totalRequests = 0;
            state.errorCount = 0;
            state.recentDurations = [];
            state.recentIndex = 0;
            state.perBackend.clear();
            state.perRoute.clear();
        },
    };
}
