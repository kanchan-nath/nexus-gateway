# `metrics.js`

## Purpose

`metrics.js` Nexus ka **in-memory metrics collector** hai.

Ye application ke runtime performance statistics track karta hai, jaise:

- Total requests
- Error count
- Error rate
- Average latency
- Per-backend request statistics
- Per-route request statistics

Ye kisi external metrics library, jaise `prom-client`, ko use nahi karta. Simple JavaScript objects, `Map`, arrays aur `reduce()` se metrics maintain karta hai.

## Context

`server.js` har completed request ke baad metrics record karta hai. Ye same metrics:

- `/nexus/metrics` endpoint se JSON ke form me expose hote hain.
- `dashboard.js` ko live dashboard ke liye provide kiye jaate hain.

```text id="q7j9ew"
Request
   ↓
server.js
   ↓
recordRequest()
   ↓
metrics.js
   ↓
getSnapshot()
   ├── /nexus/metrics
   └── dashboard.js (SSE)
```

## What Counts as an Error?

Agar response status code:

```text id="5wy2xq"
>= 400
```

hai, to request ko error maana jata hai.

Isme dono include hain:

- `4xx` → client/gateway errors
- `5xx` → backend/server errors

Example:

```text id="2h9n5g"
404 → Error
401 → Error
429 → Error
502 → Error
503 → Error
```

## Metrics Tracked

### Total Requests

`totalRequests` application ko receive hue completed requests ki total count rakhta hai.

### Error Count

`errorCount` un requests ki count rakhta hai jinka status code `400` ya higher hai.

### Error Rate

```text id="8lpk0g"
errorRate = errorCount / totalRequests
```

Agar koi request nahi hui hai, error rate `0` hota hai.

### Average Latency

Top-level `avgLatencyMs` **rolling-window average** hai.

Default window:

```text id="x3dfw7"
100 requests
```

Matlab dashboard current/recent performance ko reflect karta hai, instead of poore application lifetime ka average.

## Rolling Window

Recent request durations ek array me store hote hain.

Jab 100 samples complete ho jaate hain, purane values overwrite hone lagte hain.

```text id="f5d6me"
Request 1
Request 2
...
Request 100
       ↓
Request 101 replaces oldest sample
```

Isliye memory usage controlled rehti hai aur average current performance ke closer rehta hai.

## Per-Backend Metrics

Har backend ke liye separate bucket maintain hota hai.

Example:

```text id="e6b6wt"
Backend A
  requests
  errors
  avgLatencyMs

Backend B
  requests
  errors
  avgLatencyMs
```

Backend-level latency **all-time average** hoti hai.

## Per-Route Metrics

Har route ke liye bhi separate statistics maintain hote hain.

Example:

```text id="l8k9py"
/api
  requests
  errors
  avgLatencyMs

/users
  requests
  errors
  avgLatencyMs
```

Ye bhi all-time average use karta hai.

## Main Functions

### `createMetrics(options)`

Ek independent metrics instance create karta hai.

Optional:

```text id="w4w7i9"
rollingWindowSize
```

se rolling latency window ka size change kiya ja sakta hai.

Har instance ka apna state hota hai, isliye testing ke liye fresh metrics object easily create kiya ja sakta hai.

### `recordRequest()`

Completed request ke metrics update karta hai.

Input me mainly:

- `route`
- `backend`
- `statusCode`
- `durationMs`

milte hain.

Ye update karta hai:

```text id="6p8k6x"
totalRequests
errorCount
latency window
perBackend
perRoute
```

### `getSnapshot()`

Current metrics ko ek **plain JavaScript object** me return karta hai.

Snapshot directly:

```text id="j5z1fh"
JSON.stringify(snapshot)
```

ke through JSON me convert kiya ja sakta hai.

Isliye ye dashboard aur HTTP metrics endpoint dono ke liye useful hai.

### `handleMetricsRoute()`

Metrics ko HTTP JSON response ke form me expose karta hai.

Example:

```text id="4m5j2p"
GET /nexus/metrics
       ↓
JSON metrics response
```

### `reset()`

Saare counters aur stored data clear karta hai.

Mainly testing ke liye useful hai.

## Snapshot Structure

Snapshot roughly ye information provide karta hai:

```text id="g2a5u7"
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

## Integration

### `server.js`

`server.js` ek metrics instance create karta hai aur request complete hone par `recordRequest()` call karta hai.

### `dashboard.js`

Dashboard ko metrics directly calculate nahi karne chahiye.

Instead:

```text id="k8x3v4"
metrics.getSnapshot()
```

call karke snapshot SSE ke through browser ko push karna chahiye.

### Other Modules

Future me `ratelimiter.js` ya `auth.js` additional events record karna chahein to same metrics instance dependency injection ke through pass kiya ja sakta hai.

Global singleton intentionally avoid kiya gaya hai.

## Overall Summary

`metrics.js` Nexus ka **runtime monitoring/data collection layer** hai.

Simple flow:

```text id="s7n1ce"
Completed Request
      ↓
recordRequest()
      ↓
Update Counters
      ↓
Calculate Metrics
      ↓
getSnapshot()
      ├── HTTP JSON endpoint
      └── Live Dashboard
```

Overall, ye file Nexus ke requests, errors aur latency ko lightweight aur zero-dependency way me track karti hai, while keeping the metrics logic separate from `server.js`.