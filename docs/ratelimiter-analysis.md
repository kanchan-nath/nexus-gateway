# `src/ratelimiter.js` — Rate Limiter Analysis

## 1. File Overview

`src/ratelimiter.js` implements Nexus's **per-client IP rate limiter** using the **Token Bucket algorithm**.

Its responsibilities are:

- Maintain a token bucket for each client IP.
- Refill tokens over time.
- Allow or reject requests based on available tokens.
- Calculate how long a rejected client should wait before retrying.
- Remove stale buckets to prevent unlimited in-memory growth.
- Extract the client's IP address from a Node.js HTTP request.

The implementation is deliberately **zero-dependency**. Instead of using libraries such as `express-rate-limit` or Redis, it uses:

```text
Map + Date.now() + arithmetic
```

The module also does **not** directly handle HTTP responses. It returns a result that `server.js` can use to send a `429 Too Many Requests` response.

---

## 2. Architectural Role

The intended Nexus request pipeline is:

```text
Incoming HTTP Request
        |
        v
getClientIp(req)
        |
        v
limiter.checkLimit(ip)
        |
        +---- allowed ----> Authentication
        |                       |
        |                       v
        |                  Route Matching
        |                       |
        |                       v
        |                  Backend Forward
        |
        +---- denied -----> HTTP 429
                            Retry-After
```

The rate limiter should run **before authentication** because rate limiting is cheap in-memory work, while authentication may involve HMAC verification.

---

## 3. Core Algorithm: Token Bucket

Each IP gets an independent bucket:

```text
IP A → Bucket A
IP B → Bucket B
IP C → Bucket C
```

Each bucket contains:

```js
{
    tokens,
    lastRefill
}
```

The bucket can hold at most:

```text
config.rateLimit.max
```

tokens.

Every accepted request costs **1 token**.

Tokens regenerate continuously at:

```text
maxTokens / windowMs
```

tokens per millisecond.

The important point is that tokens are not actually regenerated in the background. The code calculates the refill lazily when the next request arrives.

---

## 4. Why Token Bucket?

Token Bucket allows a controlled burst while still enforcing an average request rate.

For example:

```text
max = 20
windowMs = 1000
```

The bucket starts with 20 tokens and refills at:

```text
20 / 1000 = 0.02 tokens/ms = 20 tokens/sec
```

Therefore a client can initially send a burst of up to 20 requests, while continuous traffic is controlled by the refill rate.

---

## 5. Important Constants

### `STALE_SWEEP_THRESHOLD`

```js
const STALE_SWEEP_THRESHOLD = 10000;
```

The map is allowed to grow normally until it contains more than 10,000 entries. Only then does a cleanup sweep occur.

This prevents an O(n) scan from happening on every request.

### `STALE_IDLE_WINDOWS`

```js
const STALE_IDLE_WINDOWS = 10;
```

A bucket becomes eligible for deletion after being idle for:

```text
10 × windowMs
```

The bucket must also be full before it is deleted.

---

## 6. `createRateLimiter(config)`

```js
export function createRateLimiter(config)
```

This factory creates an independent rate limiter instance.

It reads:

```js
const windowMs = config.rateLimit.windowMs;
const maxTokens = config.rateLimit.max;
```

and calculates:

```js
const refillRatePerMs = maxTokens / windowMs;
```

### Why one limiter instance matters

Nexus should create **one limiter at server startup** and reuse it for all requests.

Correct:

```text
Server starts
    ↓
createRateLimiter(config)
    ↓
ONE buckets Map
    ↓
Reuse for every request
```

Incorrect:

```text
Request 1 → createRateLimiter()
Request 2 → createRateLimiter()
Request 3 → createRateLimiter()
```

Creating a new limiter per request would create a new empty `Map` and effectively reset everyone's limits.

---

## 7. Bucket Storage

```js
const buckets = new Map();
```

Conceptually:

```text
Map<IP, Bucket>
```

Example:

```text
127.0.0.1
    ↓
{ tokens: 14.5, lastRefill: ... }

192.168.1.10
    ↓
{ tokens: 8.2, lastRefill: ... }
```

Each IP therefore has an independent rate-limit state.

---

## 8. `checkLimit(ip)`

```js
function checkLimit(ip)
```

This is the core function. It:

1. Gets the current time.
2. Runs stale cleanup when necessary.
3. Finds or creates the IP bucket.
4. Refills tokens based on elapsed time.
5. Consumes one token if possible.
6. Otherwise calculates `retryAfterMs`.

---

## 9. Lazy Refill

For an existing bucket:

```js
const elapsedMs = now - bucket.lastRefill;
const refilled = elapsedMs * refillRatePerMs;
bucket.tokens = Math.min(maxTokens, bucket.tokens + refilled);
bucket.lastRefill = now;
```

Example:

```text
maxTokens = 20
windowMs = 1000
refillRate = 0.02 token/ms
```

If 500 ms passed:

```text
500 × 0.02 = 10 tokens
```

The bucket gains those 10 tokens when the next request arrives.

`Math.min()` prevents the bucket from ever exceeding its maximum capacity.

---

## 10. First Request From an IP

If an IP has no bucket:

```js
bucket = {
    tokens: maxTokens,
    lastRefill: now
};
```

The bucket starts full.

If `maxTokens` is 20:

```text
New IP → 20 tokens
```

This gives the client its configured burst capacity immediately.

---

## 11. Allowed Request

```js
if (bucket.tokens >= 1) {
    bucket.tokens -= 1;

    return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
    };
}
```

A request costs one token.

The returned `remaining` value uses `Math.floor()` because refill can produce fractional tokens.

For example:

```text
bucket.tokens = 7.84
remaining = 7
```

This represents the number of complete requests that could immediately be served.

---

## 12. Denied Request and `retryAfterMs`

When fewer than one token is available:

```js
const tokensNeeded = 1 - bucket.tokens;
const retryAfterMs = Math.ceil(tokensNeeded / refillRatePerMs);
```

Example:

```text
bucket.tokens = 0.4
refillRate = 0.02 token/ms
```

Tokens needed:

```text
1 - 0.4 = 0.6
```

Wait time:

```text
0.6 / 0.02 = 30 ms
```

So the result is approximately:

```js
{
    allowed: false,
    remaining: 0,
    retryAfterMs: 30
}
```

`server.js` can convert this value into an HTTP `Retry-After` header.

---

## 13. Returned Result

### Successful request

```js
{
    allowed: true,
    remaining: 12,
    retryAfterMs: 0
}
```

### Rejected request

```js
{
    allowed: false,
    remaining: 0,
    retryAfterMs: 50
}
```

This cleanly separates rate-limit decisions from HTTP handling.

---

## 14. `sweepStaleBuckets(now)`

```js
function sweepStaleBuckets(now)
```

This is the memory-management mechanism.

It calculates:

```js
const staleAfterMs = windowMs * STALE_IDLE_WINDOWS;
```

and examines each bucket.

A bucket is deleted only when:

```text
idle longer than staleAfterMs
AND
bucket is full
```

implemented as:

```js
if (idleMs > staleAfterMs && bucket.tokens >= maxTokens) {
    buckets.delete(ip);
}
```

A full bucket means the client has been idle long enough to completely recover, so deleting it does not disadvantage that client.

---

## 15. Memory Management Strategy

Without cleanup, every new client IP could remain in the map for the entire process lifetime.

The module instead uses:

```text
Normal operation
     ↓
No sweep

Map > 10,000 entries
     ↓
Run one sweep
     ↓
Remove long-idle full buckets
```

This is called **lazy eviction** because cleanup happens as part of the request path rather than through a background timer.

---

## 16. `getClientIp(req)`

```js
export function getClientIp(req) {
    return req.socket.remoteAddress || 'unknown';
}
```

This provides the key used by the rate limiter.

The current implementation intentionally trusts only:

```js
req.socket.remoteAddress
```

---

## 17. Why `X-Forwarded-For` Is Not Used

The code deliberately does not trust:

```http
X-Forwarded-For
```

because a client can potentially spoof that header.

If Nexus blindly trusted it, an attacker could send different fake IPs and bypass a per-IP limit.

If Nexus is later deployed behind a **trusted reverse proxy**, `X-Forwarded-For` can be considered, but only when the proxy is known to be trusted.

For the current architecture, Nexus itself is the edge, so `remoteAddress` is intentionally simple.

---

## 18. Zero-Dependency Design

A traditional architecture might use:

```text
express-rate-limit + Redis
```

Nexus replaces that with:

```text
Map + Date.now() + Token Bucket arithmetic
```

Advantages:

- No external package.
- No Redis server.
- No network round-trip.
- Simple deployment.
- Easy unit testing.
- Low runtime overhead.

The trade-off is that rate-limit state exists only inside the current Node.js process.

---

## 19. Important Limitation: In-Memory State

Because the state is stored in a JavaScript `Map`, it is local to one Nexus process.

If multiple Nexus instances are running:

```text
                 Client
                /      \\
               /        \\
        Nexus A          Nexus B
          |                |
       Map A             Map B
```

both instances maintain separate limits.

For a distributed production deployment, a shared store such as Redis could be introduced later.

For the current zero-dependency/hackathon architecture, the in-memory approach is intentional.

---

## 20. Integration With `server.js`

The intended integration is:

```js
const limiter = createRateLimiter(config);
```

This should happen once when the server starts.

For each request:

```js
const ip = getClientIp(req);
const result = limiter.checkLimit(ip);
```

If:

```js
!result.allowed
```

`server.js` should stop processing and return:

```http
429 Too Many Requests
```

with a suitable:

```http
Retry-After: <seconds>
```

The rate limiter itself does not create that response.

---

## 21. Separation of Concerns

`ratelimiter.js` intentionally does not contain:

```js
res.writeHead(...)
res.setHeader(...)
res.end(...)
```

Instead:

```text
ratelimiter.js
      ↓
rate-limit decision
      ↓
server.js
      ↓
HTTP response
```

This makes the algorithm easier to test independently of Node's HTTP response objects.

---

## 22. Integration With Other Nexus Components

### `server.js`

Uses the limiter to decide whether a request should continue or receive `429`.

### `metrics.js`

Should eventually record the number of rate-limited requests. `ratelimiter.js` should remain independent and let `server.js` connect the two systems.

### `dashboard.js`

Can display rate-limit activity by reading the metrics layer rather than directly accessing the private bucket map.

### `auth.js`

The intended ordering is:

```text
Rate Limiter
     ↓
Authentication
```

This prevents unnecessary HMAC work for traffic that should already be rejected.

### `config.js`

Provides:

```js
config.rateLimit.windowMs
config.rateLimit.max
```

The limiter consumes these values rather than defining its own limits.

---

## 23. Example Request Sequence

Assume:

```text
max = 3
windowMs = 1000 ms
```

Initial state:

```text
Bucket = 3
```

### Request 1

```text
3 → consume 1 → 2
```

Allowed.

### Request 2

```text
2 → consume 1 → 1
```

Allowed.

### Request 3

```text
1 → consume 1 → 0
```

Allowed.

### Request 4 immediately

```text
0 → cannot consume
```

Denied.

After enough time passes, tokens begin regenerating.

---

## 24. Continuous Refill Example

Suppose:

```text
max = 20
windowMs = 1000
```

Then:

```text
refillRate = 20 / 1000
           = 0.02 token/ms
```

After 250 ms:

```text
0.02 × 250 = 5 tokens
```

The important detail is that no timer ran during those 250 ms. The refill was calculated when the next request arrived.

---

## 25. Why No Timers Are Used

A timer-based implementation might use `setInterval()` to refill buckets.

This implementation instead does:

```text
Request arrives
      ↓
calculate elapsed time
      ↓
calculate refill
      ↓
continue
```

Benefits:

- No background timer.
- No CPU work for idle clients.
- Simpler lifecycle.
- Easier testing.
- No timer cleanup required during shutdown.

---

## 26. Edge Cases

### Missing IP

```js
req.socket.remoteAddress || 'unknown'
```

If no remote address exists, the string `unknown` becomes the bucket key.

### `max = 0`

A zero capacity means no request can obtain a token. Configuration validation should prevent unreasonable values.

### Very small `windowMs`

A very small window produces a high refill rate, so `config.js` should validate configuration values appropriately.

### Fractional tokens

Fractional tokens are expected because refill is continuous. They are useful internally for accurate timing, while `remaining` reports only complete tokens using `Math.floor()`.

---

## 27. Testing Strategy

Recommended unit tests include:

### Basic behavior

- First request is allowed.
- Each successful request consumes one token.
- Requests are denied when fewer than one token is available.
- `remaining` is correct.

### Refill behavior

- Tokens refill after elapsed time.
- Tokens never exceed `max`.
- Fractional tokens are handled correctly.
- `retryAfterMs` is calculated correctly.

### Per-IP isolation

```text
IP A → Bucket A
IP B → Bucket B
```

Traffic from A must not consume B's tokens.

### Stale cleanup

- A large map triggers a sweep.
- Long-idle full buckets are removed.
- Active or non-full buckets are retained.

### IP extraction

- `remoteAddress` is returned.
- Missing `remoteAddress` returns `unknown`.

### Configuration

- Different `max` values work.
- Different `windowMs` values work.

---

## 28. Complexity

Normal rate-limit checks use `Map.get()` and `Map.set()`, which are O(1) on average.

Therefore normal request processing is effectively:

```text
O(1)
```

The stale sweep is:

```text
O(n)
```

but it is only triggered after the map exceeds 10,000 entries, so the expensive operation is intentionally infrequent.

---

## 29. Design Strengths

### Simple

Uses basic Node.js primitives.

### Dependency-free

No external rate-limiting library or Redis is required.

### Efficient

No timers continuously refill buckets.

### Per-client isolation

Each IP gets an independent bucket.

### Useful retry information

`retryAfterMs` allows the HTTP layer to provide meaningful retry information.

### Memory-conscious

Lazy eviction prevents inactive IP buckets from accumulating forever.

### Testable

The core algorithm is independent of HTTP response handling.

---

## 30. Design Trade-offs

| Design | Advantage | Trade-off |
|---|---|---|
| In-memory `Map` | Fast and simple | Not shared across processes |
| Token Bucket | Allows controlled bursts | More complex than a simple counter |
| Lazy refill | No timers | Refill is calculated on request |
| Lazy cleanup | Avoids constant O(n) scans | Stale entries may temporarily remain |
| `remoteAddress` | Simple and directly provided by socket | Does not identify original client behind a trusted proxy |
| No Redis | Zero infrastructure | Not suitable for distributed global rate limits |

---

## 31. Quick Reference

| Function / Variable | Purpose |
|---|---|
| `createRateLimiter(config)` | Creates an independent limiter |
| `checkLimit(ip)` | Allows or denies a request |
| `sweepStaleBuckets(now)` | Removes old inactive buckets |
| `getClientIp(req)` | Gets client IP |
| `buckets` | Stores per-IP token state |
| `refillRatePerMs` | Controls token regeneration |
| `retryAfterMs` | Wait time after rejection |
| `STALE_SWEEP_THRESHOLD` | Controls when cleanup starts |
| `STALE_IDLE_WINDOWS` | Controls how long a bucket must be idle |

---

## 32. Final Summary

`src/ratelimiter.js` is Nexus's **dependency-free per-IP rate-limiting engine**.

Its core logic is:

```text
Client IP
   ↓
Token Bucket
   ↓
Calculate elapsed time
   ↓
Refill tokens lazily
   ↓
Token available?
   ├── YES → consume token → allow
   └── NO  → reject → calculate retry time
```

The most important implementation detail is that tokens are **not refilled by a background timer**. The module calculates how many tokens should have regenerated whenever a request arrives.

The module also performs lazy cleanup so long-idle buckets do not remain in memory forever.

Architecturally, this file only makes the rate-limit decision. `server.js` is responsible for converting that decision into an HTTP `429 Too Many Requests` response and a `Retry-After` header.

Overall, this is a clean, lightweight Token Bucket implementation that fits Nexus's zero-dependency architecture very well while remaining easy to test and integrate.
