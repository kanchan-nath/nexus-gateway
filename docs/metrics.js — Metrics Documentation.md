# `metrics.js`

## Purpose

`metrics.js` is Nexus's **in-memory metrics collector**.

It tracks runtime statistics such as:

* Total requests
* Error count
* Error rate
* Average latency
* Per-backend request statistics
* Per-route request statistics

It uses only native JavaScript structures such as `Map`, arrays, and `reduce()`, avoiding external metrics libraries.

## Context

`server.js` records metrics after a request has completed. The collected data can then be consumed by the metrics endpoint or the live dashboard.

```text id="4w6v1k"
Completed Request
       ↓
server.js
       ↓
recordRequest()
       ↓
metrics.js
       ↓
getSnapshot()
    ↙       ↘
Metrics    Dashboard
Endpoint     (SSE)
```

Each call to `createMetrics()` creates an independent metrics instance rather than using a global singleton.

## Error Tracking

A response is considered an error when:

```text id="h1r4q8"
statusCode >= 400
```

This includes both client errors and server/gateway errors.

Examples:

```text id="y8f3mc"
401 → Error
404 → Error
429 → Error
502 → Error
503 → Error
```

The threshold is defined by `ERROR_STATUS_THRESHOLD`.

## Latency Tracking

The top-level `avgLatencyMs` uses a **rolling window**.

The default window contains the last:

```text id="x6m2qa"
100 requests
```

When the window is full, new durations replace the oldest values.

This keeps the dashboard focused on recent application performance rather than the average across the entire runtime.

Per-backend and per-route latency use all recorded requests for that backend or route.

## Main Metrics

### `totalRequests`

Total number of completed requests recorded by the metrics collector.

### `errorCount`

Number of recorded requests with a status code of `400` or higher.

### `errorRate`

Calculated as:

```text id="u4v9dz"
errorCount / totalRequests
```

Returns `0` when no requests have been recorded.

### `avgLatencyMs`

Average latency of the requests currently stored in the rolling window.

## Per-Backend Metrics

The collector maintains a separate bucket for each backend.

Each bucket contains:

```text id="m3s7pk"
requests
errors
avgLatencyMs
```

This makes it possible to compare backend performance and error rates.

## Per-Route Metrics

The same type of bucket is maintained for each configured route.

Example:

```text id="r9c5hx"
/api
  requests
  errors
  avgLatencyMs

/users
  requests
  errors
  avgLatencyMs
```

## Main Functions

### `createMetrics(options)`

Creates an independent metrics collector.

The rolling-window size can optionally be customized through:

```text id="n7w2ke"
rollingWindowSize
```

### `recordRequest()`

Records one completed request.

It updates:

* Total request count
* Error count
* Rolling latency data
* Backend statistics
* Route statistics

It accepts:

```text id="p8x4mv"
route
backend
statusCode
durationMs
```

### `getSnapshot()`

Returns all current metrics as a plain JavaScript object.

The result can be directly passed to `JSON.stringify()`.

It includes:

```text id="b6q1sy"
startedAt
uptimeSeconds
totalRequests
errorCount
errorRate
avgLatencyMs
rollingWindowSize
rollingWindowSamples
perBackend
perRoute
```

### `handleMetricsRoute()`

Provides an HTTP handler that returns the current metrics as JSON.

This can be mounted at the configured metrics path, such as:

```text id="k2d8rn"
/nexus/metrics
```

### `reset()`

Clears all counters, latency samples, route buckets, and backend buckets.

It is mainly useful for testing.

## Integration

### `server.js`

`server.js` creates one metrics instance and calls `recordRequest()` after each response finishes.

### `dashboard.js`

The dashboard should use:

```text id="v5m9qt"
metrics.getSnapshot()
```

rather than maintaining its own counters.

The snapshot can then be sent to the browser through Server-Sent Events (SSE).

### Other Modules

Other modules can use the same metrics instance if additional events need to be recorded.

The design intentionally avoids a hidden global metrics singleton and instead relies on dependency injection.

## Overall Summary

`metrics.js` is Nexus's **runtime monitoring layer**.

Its basic flow is:

```text id="s3f7qa"
Request Completed
       ↓
recordRequest()
       ↓
Update Metrics
       ↓
getSnapshot()
    ↙       ↘
HTTP API   Dashboard
```

It provides lightweight request, error, route, backend, and latency metrics without requiring an external monitoring library.
