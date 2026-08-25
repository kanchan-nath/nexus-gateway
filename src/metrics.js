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

export function createMetrics(options = {}) {
    const rollingWindowSize = options.rollingWindowSize || DEFAULT_ROLLING_WINDOW_SIZE;

    const state = {
        startedAt: new Date(),
        totalRequests: 0,
        errorCount: 0,
        recentDurations: [],
        recentIndex: 0,
        perBackend: new Map(),
        perRoute: new Map(),
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

        handleMetricsRoute(req, res) {
            const body = JSON.stringify(this.getSnapshot(), null, 2);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
        },

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