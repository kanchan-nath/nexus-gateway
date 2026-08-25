const STALE_SWEEP_THRESHOLD = 10000;

const STALE_IDLE_WINDOWS = 10;

export function createRateLimiter(config) {
    const windowMs = config.rateLimit.windowMs;
    const maxTokens = config.rateLimit.max;
    const refillRatePerMs = maxTokens / windowMs;

    const buckets = new Map();

    function checkLimit(ip) {
        const now = Date.now();

        if (buckets.size > STALE_SWEEP_THRESHOLD) {
            sweepStaleBuckets(now);
        }

        let bucket = buckets.get(ip);
        if (!bucket) {
            bucket = { tokens: maxTokens, lastRefill: now };
            buckets.set(ip, bucket);
        } else {
            const elapsedMs = now - bucket.lastRefill;
            const refilled = elapsedMs * refillRatePerMs;
            bucket.tokens = Math.min(maxTokens, bucket.tokens + refilled);
            bucket.lastRefill = now;
        }

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return {
                allowed: true,
                remaining: Math.floor(bucket.tokens),
                retryAfterMs: 0,
            };
        }

        const tokensNeeded = 1 - bucket.tokens;
        const retryAfterMs = Math.ceil(tokensNeeded / refillRatePerMs);

        return {
            allowed: false,
            remaining: 0,
            retryAfterMs,
        };
    }

    function sweepStaleBuckets(now) {
        const staleAfterMs = windowMs * STALE_IDLE_WINDOWS;
        for (const [ip, bucket] of buckets) {
            const idleMs = now - bucket.lastRefill;
            if (idleMs > staleAfterMs && bucket.tokens >= maxTokens) {
                buckets.delete(ip);
            }
        }
    }

    return { checkLimit };
}

export function getClientIp(req) {
    return req.socket.remoteAddress || 'unknown';
}