# `src/server.js` — Server / Request Pipeline Analysis

## 1. File Overview

`src/server.js` is the **core HTTP server and request-processing pipeline of Nexus**.

It uses Node.js's built-in `http` module instead of Express and connects the major Nexus components together:

- Router
- Load balancer
- Health checker
- Logger
- Metrics
- Write-ahead log (WAL)
- Rate limiter
- Authentication
- Dashboard

The file has two major responsibilities:

1. **Build and share the Nexus runtime context.**
2. **Process each incoming HTTP request through the complete gateway pipeline.**

The actual reverse-proxy operation happens through `http.request()`, with request and response bodies streamed between the client and selected backend.

---

# 2. High-Level Architecture

The main request flow is:

```text
                    Client Request
                          |
                          v
                createRequestHandler()
                          |
              +-----------+-----------+
              |                       |
              v                       v
       Internal Routes          Dashboard UI/SSE
       /metrics etc.                  |
              |                       |
              +-----------+-----------+
                          |
                          v
                    Rate Limiter
                          |
                    allowed?
                    /       \\
                  NO         YES
                  |            |
                 429           v
                         Authentication
                              |
                         authenticated?
                          /        \\
                        NO          YES
                        |             |
                       401            v
                              Route Matching
                                    |
                              route exists?
                               /          \\
                             NO            YES
                             |               |
                            404              v
                                  Load Balancer
                                        |
                                  healthy backend?
                                   /          \\
                                 NO            YES
                                 |               |
                                502              v
                                          WAL append
                                               |
                                               v
                                      Connection tracking
                                               |
                                               v
                                       Reverse Proxy
                                               |
                                               v
                                        Backend Response
                                               |
                                               v
                                        Client Response
                                               |
                                               v
                                      Metrics + Logging
                                      + WAL response update
```

This makes `server.js` the **orchestrator** rather than the owner of every individual feature.

---

# 3. Dependencies

The file imports Node.js built-ins and Nexus modules.

## Built-in modules

```js
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
```

### `node:http`

Used for:

- Creating the HTTP server.
- Creating outbound backend requests through `http.request()`.

### `node:url`

The `URL` class is used to safely construct and parse URLs.

### `node:fs`

Used to read the static dashboard HTML file.

### `node:path`

Used to construct the dashboard file path.

---

# 4. Nexus Module Dependencies

```js
createLogger()
createMetrics()
matchRoute()
createLoadBalancer()
createHealthChecker()
createWal()
createRateLimiter()
getClientIp()
authenticate()
createDashboard()
```

Each component has a focused responsibility.

| Module | Responsibility |
|---|---|
| `logger.js` | Structured application/request logging |
| `metrics.js` | Request metrics and metrics endpoint |
| `router.js` | Select configured route/backend group |
| `loadbalancer.js` | Select a backend from a route |
| `healthcheck.js` | Monitor backend health |
| `wal.js` | Durable request logging |
| `ratelimiter.js` | Per-IP request limiting |
| `auth.js` | API key / HMAC authentication |
| `dashboard.js` | Live dashboard/SSE functionality |

`server.js` connects these modules together.

---

# 5. `forwardRequest()`

```js
function forwardRequest(clientReq, clientRes, backendBaseUrl)
```

This is the actual **reverse proxy mechanism**.

The function receives:

- The original client request.
- The response object that Nexus will send to the client.
- The selected backend URL.

Its job is to forward the request to the backend and stream the backend response back to the client.

---

# 6. Building the Backend Target URL

```js
const target = new URL(clientReq.url, backendBaseUrl);
```

Suppose the client requests:

```text
/api/users?id=10
```

and the selected backend is:

```text
http://localhost:9000
```

The resulting target becomes conceptually:

```text
http://localhost:9000/api/users?id=10
```

The original path and query string are therefore preserved.

---

# 7. Forwarding Request Headers

```js
const outgoingHeaders = { ...clientReq.headers };
outgoingHeaders.host = target.host;
```

The incoming headers are copied to the backend request.

However, the `Host` header is replaced with the backend's actual host.

This is important because the backend should see its own destination rather than Nexus's public host.

Conceptually:

```text
Client Host
    |
    X
    |
    +--> replaced with backend Host
```

---

# 8. Creating the Backend Request

```js
const proxyReq = http.request(
    {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: clientReq.method,
        headers: outgoingHeaders,
    },
    (backendRes) => { ... }
);
```

Nexus creates a new outbound HTTP request to the selected backend.

Important properties are copied from the original request:

- HTTP method
- Path
- Query string
- Headers

The backend receives a new connection created by Nexus.

That is what makes Nexus a **reverse proxy**.

---

# 9. Backend Response Handling

When the backend responds:

```js
(backendRes) => {
    clientRes.writeHead(
        backendRes.statusCode,
        backendRes.headers
    );

    backendRes.pipe(clientRes);
}
```

The backend's:

- status code
- response headers
- response body

are passed back to the client.

The body is streamed using:

```js
backendRes.pipe(clientRes);
```

This avoids manually buffering the entire response in memory.

---

# 10. Why Streaming Is Important

For a large backend response, Nexus does not need to do:

```text
Backend response
      ↓
Load entire body into RAM
      ↓
Send to client
```

Instead:

```text
Backend
  |
  | stream
  v
Nexus
  |
  | stream
  v
Client
```

This is much more suitable for a gateway/proxy.

---

# 11. Backend Error Handling

```js
proxyReq.on('error', (err) => { ... });
```

If the backend connection fails, Nexus returns:

```http
502 Bad Gateway
```

with:

```json
{
  "error": "Bad Gateway",
  "detail": "backend unreachable"
}
```

The error is logged internally with more detail.

---

# 12. Why `502` Is Used

A `502 Bad Gateway` indicates that Nexus, acting as a gateway/proxy, could not obtain a valid response from the upstream backend.

This is different from:

```text
401 → authentication problem
404 → no route
429 → rate limit exceeded
```

So the status code accurately represents the failure layer.

---

# 13. Handling Errors After Headers Were Sent

```js
if (!clientRes.headersSent) {
    clientRes.writeHead(502, ...);
    clientRes.end(...);
} else {
    clientRes.destroy();
}
```

If Nexus has not started the response, it can safely send a `502`.

If headers have already been sent, changing the HTTP status is no longer safe.

In that situation the connection is destroyed instead.

This avoids attempting to send a second HTTP response after the response has already started.

---

# 14. Streaming the Client Request Body

```js
clientReq.pipe(proxyReq);
```

This is important for methods such as:

```text
POST
PUT
PATCH
```

The incoming request body is streamed directly to the backend.

So Nexus does not need to manually collect the complete request body first.

---

# 15. `createRequestHandler()`

```js
function createRequestHandler(
    config,
    logger,
    metrics,
    loadBalancer,
    wal,
    rateLimiter,
    dashboard
)
```

This function constructs the main HTTP request handler.

It uses **dependency injection**.

Instead of doing this inside the request handler:

```js
createLogger()
createMetrics()
createRateLimiter()
```

the instances are created once and passed into the handler.

This prevents state from being recreated per request.

It also makes unit testing easier because tests can supply controlled/mock dependencies.

---

# 16. Request Start Time

```js
const startTime = Date.now();
```

Every request records its start time.

This is later used to calculate:

```text
durationMs = endTime - startTime
```

That duration is sent to logging and metrics.

---

# 17. Parsing the Request URL

```js
const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
);
```

The URL parser gives Nexus access to:

```js
parsedUrl.pathname
parsedUrl.search
```

and other URL components.

The host fallback ensures URL parsing still has a base when the request does not contain a usable `Host` header.

---

# 18. Internal Metrics Route

The first internal route checked is the configured metrics path:

```js
if (
    config.metrics &&
    config.metrics.path &&
    parsedUrl.pathname === config.metrics.path
) {
    metrics.handleMetricsRoute(req, res);
    logger.logRequest(req, res.statusCode, startTime);
    return;
}
```

This route is handled directly by Nexus.

It is **not sent to a backend**.

This is an important distinction between:

```text
Internal Nexus endpoint
```

and:

```text
Proxied application endpoint
```

---

# 19. Dashboard UI Route

The following routes serve the static dashboard page:

```text
/
/nexus/dashboard
```

The file is read using:

```js
fs.readFileSync(path.resolve('./public/index.html'))
```

and returned as:

```http
Content-Type: text/html
```

---

# 20. Dashboard Failure

If the dashboard file cannot be read:

```http
500 Internal Server Error
```

is returned.

The internal error is logged:

```js
logger.error(...)
```

This prevents the raw filesystem error from being exposed directly to the client.

---

# 21. Dashboard SSE Stream

```js
if (
    config.dashboard?.path &&
    parsedUrl.pathname === config.dashboard.path
) {
    return dashboard.handleDashboardStream(req, res);
}
```

The dashboard's live stream is also handled directly by Nexus.

It is not routed to a backend.

The dashboard component presumably provides the Server-Sent Events behavior.

---

# 22. Rate Limiting

After internal routes are handled, the normal request pipeline performs rate limiting:

```js
const clientIp = getClientIp(req);
const rateLimitResult = rateLimiter.checkLimit(clientIp);
```

The client IP becomes the bucket key.

If the limit is exceeded:

```js
if (!rateLimitResult.allowed) { ... }
```

Nexus immediately stops processing the request.

---

# 23. HTTP 429 Response

The server calculates:

```js
const retryAfterSeconds = Math.ceil(
    rateLimitResult.retryAfterMs / 1000
);
```

Then returns:

```http
429 Too Many Requests
Retry-After: <seconds>
```

with JSON:

```json
{
  "error": "Too Many Requests",
  "detail": "retry after Xs"
}
```

The request is then logged and recorded in metrics.

---

# 24. Why Rate Limiting Happens Before Authentication

The code deliberately performs:

```text
Rate limiting
     ↓
Authentication
```

instead of:

```text
Authentication
     ↓
Rate limiting
```

This is useful because authentication may require HMAC cryptographic work.

An attacker sending large volumes of garbage requests should ideally be rejected cheaply before Nexus performs unnecessary authentication operations.

---

# 25. Authentication

After rate limiting:

```js
const authResult = authenticate(req, config);
```

If authentication fails:

```js
if (!authResult.authenticated) { ... }
```

Nexus returns:

```http
401 Unauthorized
```

with:

```http
WWW-Authenticate: ApiKey, Bearer
```

The response body contains the authentication failure reason.

---

# 26. Why Authentication Happens Before Routing

The intended normal flow is:

```text
Rate limit
   ↓
Authentication
   ↓
Route matching
   ↓
Backend selection
```

This prevents unauthenticated clients from learning or using the normal backend routing pipeline.

---

# 27. Route Matching

```js
const route = matchRoute(
    parsedUrl.pathname,
    config,
    req.headers.host
);
```

The router decides which configured route matches the request.

It receives:

- URL pathname
- Nexus configuration
- request host

This allows Nexus to support path/host-based routing.

---

# 28. Route Not Found

If:

```js
!route
```

Nexus returns:

```http
404 Not Found
```

with:

```json
{
  "error": "Not Found",
  "detail": "no backend configured for /requested/path"
}
```

The failure is also logged and recorded in metrics.

---

# 29. Load Balancer Integration

Once a route exists:

```js
const backend = loadBalancer.pickBackend(route);
```

The router identifies the backend group/route.

The load balancer then chooses the actual backend instance.

This separation is important:

```text
Router
  ↓
Which backend group?

Load Balancer
  ↓
Which backend instance?
```

---

# 30. No Healthy Backend

If:

```js
!backend
```

Nexus returns:

```http
502 Bad Gateway
```

with:

```json
{
  "error": "Bad Gateway",
  "detail": "no healthy backends available for ..."
}
```

This means routing succeeded but there is currently no usable upstream backend.

---

# 31. WAL Integration

Before forwarding the request, Nexus optionally creates a WAL entry:

```js
if (wal.enabled) {
    walEntryId = await wal.append(req, route, backend);
}
```

The WAL is the **write-ahead logging/durability layer**.

Conceptually:

```text
Request selected
      ↓
WAL append
      ↓
Forward to backend
```

If WAL writing fails, the request is not automatically rejected. Instead, the error is logged.

That means WAL is currently treated as an observability/durability feature rather than a hard dependency for request forwarding.

---

# 32. Why `walEntryId` Is Stored

```js
let walEntryId = null;
```

If an entry was successfully created, its ID is saved.

After the response finishes, the same WAL entry can be updated with response information.

This gives the WAL a request/response lifecycle:

```text
Request
  ↓
WAL entry created
  ↓
Backend response
  ↓
WAL entry updated
```

---

# 33. Load Balancer Connection Tracking

Before forwarding:

```js
loadBalancer.incrementConnections(route, backend);
```

This allows the load balancer to track active connections.

That information can be useful for strategies that consider current connection counts.

---

# 34. `res.on('finish')`

The server registers a response completion handler:

```js
res.on('finish', () => { ... });
```

This is a major integration point.

When the response finishes, Nexus:

1. Decrements active backend connections.
2. Calculates request duration.
3. Logs the request.
4. Records metrics.
5. Updates the WAL entry if one exists.

---

# 35. Connection Decrement

```js
loadBalancer.decrementConnections(route, backend);
```

The connection count must be decremented after the response completes.

Otherwise, the load balancer could eventually believe there are more active connections than actually exist.

---

# 36. Request Metrics

The server records:

```js
metrics.recordRequest({
    route,
    backend,
    statusCode: res.statusCode,
    durationMs,
});
```

This gives metrics enough information to track:

- Route
- Backend
- HTTP status
- Request duration

This is useful for monitoring both performance and errors.

---

# 37. WAL Response Update

If a WAL entry exists:

```js
wal.updateResponse(...)
```

stores response information such as:

```text
statusCode
headers
```

The update is asynchronous and its failure is logged rather than allowed to crash the request path.

---

# 38. `res.on('error')`

The response also listens for errors:

```js
res.on('error', (err) => { ... });
```

If an error occurs:

- Active connection count is decremented.
- The error is logged.
- The WAL can be updated with an error status.

This provides a second cleanup path for abnormal response behavior.

---

# 39. Actual Proxy Call

After all request-processing checks:

```js
forwardRequest(req, res, backend);
```

The request finally leaves the gateway and is sent to the selected backend.

At this point the pipeline has completed:

```text
Rate limit
→ Auth
→ Route
→ Backend selection
→ WAL
→ Connection tracking
→ Forward
```

---

# 40. `createRequestContext(config)`

```js
export function createRequestContext(config)
```

This function creates all shared Nexus components **without starting an HTTP listener**.

This is a very important architectural feature.

It allows the same runtime components to be reused by HTTP and HTTPS listeners.

---

# 41. Configuration Validation

```js
if (!config || !config.backends) {
    throw new Error(...);
}
```

The server requires a valid configuration containing backend definitions.

Without backends, the gateway cannot perform its primary job.

---

# 42. Creating Shared Components

The context creates:

```js
const logger = createLogger(config);
const metrics = createMetrics();
const dashboard = createDashboard(config, metrics);
const healthChecker = createHealthChecker(config, logger);
const loadBalancer = createLoadBalancer(config, healthChecker);
const wal = createWal(config, logger);
const rateLimiter = createRateLimiter(config);
```

These objects are created **once per context**.

---

# 43. Health Checker Startup

```js
healthChecker.start();
```

The health checker begins monitoring backend availability.

This happens when the request context is created, even though no HTTP listener has started yet.

That is intentional because health monitoring is independent of whether requests arrive through HTTP or HTTPS.

---

# 44. Building the Request Handler

```js
const requestHandler = createRequestHandler(
    config,
    logger,
    metrics,
    loadBalancer,
    wal,
    rateLimiter,
    dashboard
);
```

The shared instances are injected into the handler.

The resulting context contains everything needed by the server.

---

# 45. Context Return Value

`createRequestContext()` returns:

```js
{
    requestHandler,
    logger,
    metrics,
    loadBalancer,
    healthChecker,
    wal,
    rateLimiter,
    dashboard
}
```

This object is effectively Nexus's **shared runtime context**.

---

# 46. Why `createRequestContext()` Exists

Without this separation, HTTPS support could accidentally create a second set of components:

```text
HTTP
 ↓
healthChecker A
wal A
metrics A
rateLimiter A

HTTPS
 ↓
healthChecker B
wal B
metrics B
rateLimiter B
```

That would cause problems such as:

- duplicate health-check polling
- multiple WAL writers
- independent rate-limit state
- inconsistent metrics

Instead, the design aims for:

```text
             Shared Context
                   |
          +--------+--------+
          |                 |
        HTTP              HTTPS
          |                 |
          +--------+--------+
                   |
        Same components/state
```

---

# 47. `createServer(config, existingContext)`

```js
export function createServer(config, existingContext = null)
```

This creates the actual Node.js HTTP server.

If an existing context is provided:

```js
const ctx = existingContext || createRequestContext(config);
```

it reuses that context.

Otherwise it creates a new one.

---

# 48. Creating the HTTP Server

```js
const server = http.createServer(ctx.requestHandler);
```

Node's built-in HTTP server receives the previously constructed request handler.

No Express application is involved.

This is the project's zero-dependency replacement for an Express server.

---

# 49. Attaching Components to the Server

The code attaches shared components to the server object:

```js
server.logger = ctx.logger;
server.metrics = ctx.metrics;
server.loadBalancer = ctx.loadBalancer;
server.healthChecker = ctx.healthChecker;
server.wal = ctx.wal;
server.rateLimiter = ctx.rateLimiter;
server.requestHandler = ctx.requestHandler;
```

This allows other modules such as `cli.js` or TLS-related code to access and reuse the exact same instances.

---

# 50. `startServer(config)`

```js
export function startServer(config)
```

This is the convenience function for the normal HTTP startup path.

It performs:

```text
createServer()
     ↓
server.listen()
```

---

# 51. Listening on the HTTP Port

```js
const port = config.listen.http;
server.listen(port, () => { ... });
```

The HTTP port comes from configuration.

Once the server starts, useful information is logged.

---

# 52. Startup Information

The server logs:

### Listening URL

```text
http://localhost:<port>
```

### Load-balancing strategy

```js
server.loadBalancer.getStrategy()
```

### Configured routes

```js
Object.keys(config.backends)
```

### Health status

```text
healthy backends / total backends
```

### WAL status

It reports whether WAL is enabled and, if enabled, its configured path and current entry count.

This makes startup diagnostics much easier.

---

# 53. `shutdownServer(server, timeout)`

```js
export function shutdownServer(server, timeout = 5000)
```

This handles graceful server shutdown.

Default timeout:

```text
5000 ms = 5 seconds
```

---

# 54. Shutdown Flow

The shutdown sequence is approximately:

```text
shutdownServer()
      |
      v
Stop health checker
      |
      v
Stop WAL / flush entries
      |
      v
Wait for server connections
      |
      +---- closes normally ----> resolve
      |
      +---- timeout ------------> force close
```

This is significantly safer than immediately terminating the process.

---

# 55. Already-Stopped Server

```js
if (!server || !server.listening) {
    resolve();
    return;
}
```

If the server does not exist or is already stopped, shutdown succeeds immediately.

This makes the helper safer to call during cleanup code.

---

# 56. Health Checker Shutdown

```js
server.healthChecker.stop();
```

This stops background health-check activity.

It is important because health checks may use timers or network requests that should not continue after shutdown begins.

---

# 57. WAL Shutdown

```js
server.wal.stop()
```

The WAL is stopped so pending entries can be flushed appropriately.

If WAL shutdown encounters an error, it is logged.

The code does not allow a WAL shutdown error to prevent the rest of the server shutdown sequence from proceeding.

---

# 58. Forced Shutdown Timeout

```js
const timeoutId = setTimeout(() => {
    logger.warn('Force closing connections after timeout');
    server.close(() => {
        resolve();
    });
}, timeout);
```

If connections do not close within the configured timeout, Nexus attempts a forced close.

This prevents graceful shutdown from hanging forever.

---

# 59. Normal Graceful Shutdown

```js
server.close((err) => {
    clearTimeout(timeoutId);

    if (err) {
        reject(err);
    } else {
        logger.info('Server shutdown complete');
        resolve();
    }
});
```

When the server closes normally:

1. The force-shutdown timer is cancelled.
2. The promise resolves.
3. A shutdown completion message is logged.

---

# 60. Complete Normal Request Pipeline

For a normal proxied request, the complete path is:

```text
1. Client sends HTTP request
          |
          v
2. Node HTTP server receives request
          |
          v
3. Parse URL
          |
          v
4. Check internal Nexus routes
   (/metrics, dashboard, SSE)
          |
          v
5. Get client IP
          |
          v
6. Rate-limit request
          |
          +---- denied → 429
          |
          v
7. Authenticate
          |
          +---- failed → 401
          |
          v
8. Match route
          |
          +---- missing → 404
          |
          v
9. Pick healthy backend
          |
          +---- none → 502
          |
          v
10. Append WAL entry if enabled
          |
          v
11. Increment backend connection count
          |
          v
12. Forward request using http.request()
          |
          v
13. Backend responds
          |
          v
14. Stream backend response to client
          |
          v
15. `finish` event
          |
          +---- decrement connections
          +---- log request
          +---- record metrics
          +---- update WAL
```

---

# 61. HTTP Status Codes Used

| Situation | Status |
|---|---:|
| Successful backend response | Backend's original status |
| Rate limit exceeded | `429` |
| Authentication failed | `401` |
| Route not found | `404` |
| No healthy backend | `502` |
| Backend connection failure | `502` |
| Dashboard file missing | `500` |

This gives different failure layers clear HTTP semantics.

---

# 62. Separation of Responsibilities

Although `server.js` is large, it does not implement every feature itself.

Instead:

```text
server.js
    |
    +--> router.js
    +--> loadbalancer.js
    +--> healthcheck.js
    +--> ratelimiter.js
    +--> auth.js
    +--> logger.js
    +--> metrics.js
    +--> wal.js
    +--> dashboard.js
```

`server.js` mainly coordinates them.

This is an important architectural pattern: **orchestration instead of feature duplication**.

---

# 63. Dependency Injection

The following are passed into `createRequestHandler()`:

```js
logger
metrics
loadBalancer
wal
rateLimiter
dashboard
```

This has several advantages:

- State is not recreated per request.
- Tests can provide mock objects.
- Multiple server instances can have independent contexts.
- HTTP and HTTPS can reuse one context.
- The handler does not depend on global singleton state.

---

# 64. Important State-Lifetime Rule

There are three different lifetimes worth understanding:

```text
Application / Context lifetime
    ↓
logger
metrics
loadBalancer
healthChecker
wal
rateLimiter

Request lifetime
    ↓
startTime
route
backend
walEntryId

Response lifetime
    ↓
finish/error handlers
```

Keeping these lifetimes correct is critical to the server's behavior.

---

# 65. Potential Implementation Considerations

## 65.1 Dashboard Routes Bypass Rate Limiting and Authentication

The code handles these routes before the rate limiter:

```text
metrics
/
/nexus/dashboard
configured dashboard SSE path
```

Therefore, they are intentionally treated as internal/public routes by the current implementation.

If the dashboard or metrics endpoints should be protected in the future, their ordering would need to change.

---

## 65.2 `res.on('error')` and Connection Counting

The code decrements connections in both:

```text
finish
error
```

This is intended as defensive cleanup, but future changes should ensure that a single request cannot cause the decrement operation to happen twice for the same connection lifecycle.

The load balancer implementation should ideally make its connection accounting robust against duplicate cleanup paths.

---

## 65.3 HTTP vs HTTPS Backend Protocol

`forwardRequest()` uses:

```js
http.request()
```

Therefore, this function is currently designed around HTTP upstreams.

If Nexus later supports HTTPS backends, the outbound client would need protocol-aware handling, potentially using `https.request()` when the backend URL uses `https:`.

This is separate from Nexus itself listening over HTTPS.

---

## 65.4 Default Backend Port

```js
port: target.port || 80
```

This assumes HTTP when no port is explicitly present.

That is correct for the current `http.request()` implementation but should be reconsidered if HTTPS upstream support is introduced.

---

## 65.5 Synchronous Dashboard File Read

```js
fs.readFileSync(...)
```

The dashboard HTML is small and loaded only for dashboard requests, so this is simple and acceptable for the current scope.

For a high-throughput production server, asynchronous file access or a cached HTML buffer could avoid blocking the event loop during file reads.

---

# 66. Security Observations

The request pipeline has a sensible security order for the current architecture:

```text
Rate Limit
    ↓
Authentication
    ↓
Routing
    ↓
Backend
```

This prevents unauthenticated traffic from reaching configured application backends.

The backend error response also avoids returning the raw internal error message to the client; the detailed error is logged internally instead.

The server should still be careful that logs themselves do not accidentally contain secrets such as API keys or Bearer tokens.

---

# 67. Performance Characteristics

Normal requests mainly perform:

```text
URL parsing
Map-based rate-limit lookup
Authentication
Route matching
Backend selection
Network I/O
```

The actual request and response bodies are streamed rather than buffered.

This is appropriate for a gateway because memory usage does not have to grow proportionally with the size of every request/response body.

The main potentially expensive operations are external/network operations such as:

- WAL I/O
- Backend communication
- HMAC verification
- Health checking in the background

---

# 68. Why `await wal.append()` Is Used

The request handler is declared `async` because WAL append can be asynchronous:

```js
walEntryId = await wal.append(req, route, backend);
```

This means the request pipeline waits for the WAL append attempt before forwarding the request.

However, WAL failure is caught and logged, so a failed WAL append does not currently block the request from reaching the backend.

---

# 69. Error Isolation Philosophy

The code generally tries to prevent secondary systems from taking down the main proxy path.

Examples:

```text
WAL append failure → log error, continue request
WAL update failure → log error
Backend failure → 502
Dashboard file failure → 500
Authentication failure → 401
Rate limit failure → 429
```

This is a good gateway design principle: observability and durability features should not accidentally create confusing failures in unrelated layers unless they are explicitly configured as hard requirements.

---

# 70. Quick Function Reference

| Function | Purpose | Exported? |
|---|---|---|
| `forwardRequest()` | Proxy request to backend | No |
| `createRequestHandler()` | Build request-processing handler | No |
| `createRequestContext()` | Build shared Nexus runtime context | Yes |
| `createServer()` | Create HTTP server without listening | Yes |
| `startServer()` | Create and start HTTP server | Yes |
| `shutdownServer()` | Gracefully stop server/components | Yes |

---

# 71. Most Important Concepts to Remember

If you only remember a few things about `server.js`, remember these:

### 1. It is the orchestrator

It connects all Nexus modules rather than implementing every feature itself.

### 2. `forwardRequest()` is the reverse proxy

```js
http.request()
```
creates the backend connection and `pipe()` streams data.

### 3. Request order matters

For normal application routes:

```text
Rate Limit
→ Auth
→ Route
→ Backend Selection
→ WAL
→ Proxy
```

### 4. Internal routes bypass the normal proxy pipeline

Metrics and dashboard routes are served directly by Nexus.

### 5. Shared context prevents duplicate state

`createRequestContext()` creates one shared set of components that can be reused by HTTP/HTTPS listeners.

### 6. Shutdown is graceful

Health checks are stopped, WAL is stopped, connections are allowed to close, and a timeout provides a final escape hatch.

---

# 72. Final Summary

`src/server.js` is the **central integration layer of Nexus**.

It transforms Nexus from a collection of independent modules into a working reverse-proxy gateway.

Its normal request pipeline is:

```text
Client
  ↓
URL parsing
  ↓
Internal Nexus routes
  ↓
Rate limiting
  ↓
Authentication
  ↓
Route matching
  ↓
Load balancing
  ↓
WAL
  ↓
Connection tracking
  ↓
http.request()
  ↓
Backend
  ↓
Stream response
  ↓
Client
  ↓
Metrics + Logging + WAL update
```

The strongest architectural feature is the separation between **building the shared runtime context** and **starting a listener**.

`createRequestContext()` creates the reusable Nexus components, while `createServer()` creates the actual HTTP listener and `startServer()` decides when to listen. This design is especially important for future HTTPS/TLS support because both HTTP and HTTPS can reuse the same health checker, load balancer, metrics, WAL, rate limiter, and request handler.

Overall, `server.js` acts as the **traffic controller and integration backbone** of Nexus: individual modules handle specialized jobs, while this file controls when and how those jobs participate in the request lifecycle.
