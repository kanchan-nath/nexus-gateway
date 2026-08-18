/**
 * src/ratelimiter.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Per-client (per-IP) rate limiting for Nexus, using the token bucket
 *   algorithm. This is the zero-dependency replacement for something like
 *   `express-rate-limit` + Redis — everything lives in an in-memory Map,
 *   no external store needed.
 *
 *   Owner: Ashish
 *   Zero-dep substitution: `Map` + `Date.now()` math replaces
 *   express-rate-limit / Redis-backed rate limiting.
 *
 * CURRENT SCOPE (Phase 2 — Hours 12-30, "Core Gateway Features")
 *   This file only implements the rate limiter itself (the data structure
 *   + the allow/deny decision logic). It does NOT touch HTTP directly —
 *   no `req`/`res` handling here. That separation is intentional: it
 *   keeps this module unit-testable in isolation (see test/ratelimiter.
 *   test.js) and keeps HTTP-specific concerns (status codes, headers)
 *   inside server.js where they belong.
 *
 * ALGORITHM — Token Bucket
 *   Each client IP gets a "bucket" that holds up to `config.rateLimit.max`
 *   tokens. Every request costs 1 token. Tokens refill continuously over
 *   time at a rate of (max tokens / windowMs) per millisecond, calculated
 *   lazily from elapsed time on each check — NO setInterval/setTimeout is
 *   used, exactly per the plan ("refill via Date.now() math, no timers
 *   needed"). This means idle buckets cost zero CPU between requests.
 *
 * MEMORY NOTE
 *   Buckets are never explicitly deleted by a timer (still no timers!).
 *   Instead, `checkLimit()` opportunistically evicts stale entries when
 *   the map grows past STALE_SWEEP_THRESHOLD, so long-running Nexus
 *   instances don't leak memory for one-off client IPs. This is a lazy
 *   sweep, not a background job — it only runs on the request path.
 *
 * -----------------------------------------------------------------------
 * FUTURE INTEGRATION — what still needs to change elsewhere
 * -----------------------------------------------------------------------
 *   1. server.js (Phase 2 — THIS phase, do this right after this file):
 *        - Import `createRateLimiter` and `getClientIp` from this file.
 *        - Create ONE limiter instance from config when the server
 *          starts (not per-request!) and reuse it across all requests.
 *        - In createRequestHandler(), before matchRoute(), call
 *          limiter.checkLimit(getClientIp(req)). If `!result.allowed`,
 *          respond 429 with a `Retry-After` header (seconds — see
 *          result.retryAfterMs, convert to seconds) and stop, matching
 *          the TODO comment already left in server.js:
 *              // TODO (Phase 2): rate limiter check here -> 429 if exceeded
 *
 *   2. metrics.js (Phase 3, owner: Saikat):
 *        - Nexus should expose a running count of rate-limited (429)
 *          requests on /nexus/metrics. Once metrics.js exists, server.js
 *          should call into it right after a 429 is issued here, e.g.
 *          `metrics.recordRateLimited()`. This file does not (and should
 *          not) import metrics.js directly — keep this module dependency-
 *          free and let server.js glue the two together.
 *
 *   3. dashboard.js (Phase 3, owner: Biyas):
 *        - The live SSE dashboard is expected to show rate-limit activity
 *          in real time. It should read from metrics.js (not from this
 *          file directly) once that counter exists — same reasoning as
 *          above, this file stays a pure, dependency-free data structure.
 *
 *   4. auth.js (Phase 3, owner: Ashish):
 *        - Once auth exists, double check ordering in server.js: rate
 *          limiting should probably run BEFORE auth (cheap check first,
 *          avoids doing HMAC verification work for spam/DoS traffic).
 *          Nothing to change here, just a note for the server.js wiring.
 *
 *   5. config.js (already implemented):
 *        - Already provides defaults: config.rateLimit = { windowMs: 1000,
 *          max: 20 } if not set by the user. No changes needed there —
 *          this file just consumes config.rateLimit as-is.
 * -----------------------------------------------------------------------
 */

// Once the map holds more entries than this, checkLimit() will do a single
// lazy sweep pass to evict buckets that haven't been touched in a while.
// Kept generous so the sweep is rare, not a per-request cost in practice.
const STALE_SWEEP_THRESHOLD = 10000;

// A bucket is considered stale (safe to evict) once it's been fully idle
// for longer than this many refill windows — i.e. it's long since been
// topped back up to full capacity and clearly isn't an active client.
const STALE_IDLE_WINDOWS = 10;

/**
 * Create a rate limiter bound to a specific config. Each call returns an
 * independent limiter with its own bucket map — Nexus should create ONE
 * of these at startup and reuse it for the lifetime of the process, not
 * create a new one per request (that would reset everyone's limits!).
 *
 * @param {object} config - the full Nexus config (uses config.rateLimit)
 * @returns {{ checkLimit: (ip: string) => RateLimitResult }}
 */
export function createRateLimiter(config) {
    const windowMs = config.rateLimit.windowMs;
    const maxTokens = config.rateLimit.max;
    const refillRatePerMs = maxTokens / windowMs;

    /** @type {Map<string, { tokens: number, lastRefill: number }>} */
    const buckets = new Map();

    /**
     * Decide whether a request from `ip` is allowed right now.
     * Mutates that IP's bucket (consumes a token if allowed).
     *
     * @param {string} ip - client identifier (see getClientIp below)
     * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
     */
    function checkLimit(ip) {
        const now = Date.now();

        if (buckets.size > STALE_SWEEP_THRESHOLD) {
            sweepStaleBuckets(now);
        }

        let bucket = buckets.get(ip);
        if (!bucket) {
            // First time we've seen this IP: start with a full bucket.
            bucket = { tokens: maxTokens, lastRefill: now };
            buckets.set(ip, bucket);
        } else {
            // Refill based on however long it's been since we last touched
            // this bucket. This is what makes timers unnecessary — we
            // compute "how many tokens would have regenerated by now"
            // on demand, rather than ticking a clock in the background.
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

        // Not enough tokens — figure out how long until at least 1 token
        // is available, so the caller can send a useful Retry-After.
        const tokensNeeded = 1 - bucket.tokens;
        const retryAfterMs = Math.ceil(tokensNeeded / refillRatePerMs);

        return {
            allowed: false,
            remaining: 0,
            retryAfterMs,
        };
    }

    /**
     * Lazy eviction pass: remove buckets that are both full (or extremely
     * close to full) and haven't been touched in a while — i.e. clients
     * that clearly aren't sending traffic anymore. Runs inline on the
     * request path (no setInterval), only triggered once the map has
     * grown large enough that it's worth the O(n) pass.
     */
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

/**
 * Extract a stable client identifier from an incoming request, to key
 * the rate limiter's bucket map by.
 *
 * NOTE for future modification (server.js / Phase 3+):
 *   Right now this trusts `req.socket.remoteAddress` only. If Nexus ever
 *   runs behind another trusted reverse proxy (not just in front of the
 *   demo backends), `X-Forwarded-For` would need to be consulted instead
 *   — but ONLY if that header is coming from a trusted upstream, since
 *   blindly trusting X-Forwarded-For lets clients spoof their own IP and
 *   bypass rate limiting entirely. Not needed for this hackathon's
 *   architecture (Nexus IS the edge), so left simple on purpose.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
    return req.socket.remoteAddress || 'unknown';
}

/**
 * @typedef {object} RateLimitResult
 * @property {boolean} allowed - whether the request should proceed
 * @property {number} remaining - tokens left in the bucket (post-request)
 * @property {number} retryAfterMs - if denied, ms until a token is available
 */