# Live Metrics Dashboard Backend

## Overview

`src/dashboard.js` is responsible for providing a **live metrics stream** for the Nexus Gateway dashboard.

It uses **Server-Sent Events (SSE)** over normal HTTP instead of WebSockets or Socket.IO.

The dashboard client keeps an HTTP connection open, and Nexus periodically sends the latest metrics snapshot:

```text
Browser Dashboard
       │
       │  HTTP request
       ▼
/nexus/dashboard/stream
       │
       ▼
dashboard.js
       │
       ▼
metrics.getSnapshot()
       │
       ▼
JSON metrics snapshot
       │
       ▼
SSE: data: <json>
       │
       ▼
Browser updates dashboard
```

The main advantage is that this implementation requires **no additional real-time networking library**.

It uses Node.js's built-in HTTP functionality and `res.write()`.

---

# Purpose

The main responsibilities of this file are:

* Create the dashboard stream handler.
* Expose metrics through an SSE endpoint.
* Immediately send the current metrics snapshot when a client connects.
* Periodically push updated metrics.
* Keep the SSE connection alive.
* Clean up timers when the client disconnects.
* Reuse the existing `metrics` instance instead of maintaining separate counters.
* Provide a standalone smoke-test server for development.

---

# Main Function: `createDashboard(config, metrics)`

```js
export function createDashboard(config, metrics)
```

This is the main exported function of the module.

It receives two dependencies:

```text
config
metrics
```

### `config`

The complete Nexus configuration object.

The dashboard uses:

```text
config.dashboard.pushIntervalMs
```

to determine how frequently metrics should be pushed.

If no interval is configured, the default is:

```text
1000 ms
```

which means the dashboard receives a snapshot approximately every second.

---

### `metrics`

This is the **same metrics instance created by `server.js`**.

The dashboard does not create its own metrics object.

Instead, it uses:

```js
metrics.getSnapshot()
```

This is important because the dashboard should display the same counters that the rest of Nexus Gateway is using.

Conceptually:

```text
                    metrics instance
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
       Server requests             Dashboard
             │                           │
             ▼                           ▼
    recordRequest()                getSnapshot()
                                         │
                                         ▼
                                  Live dashboard
```

This is an example of **dependency injection**.

The metrics object is passed into the dashboard instead of being stored as a hidden global singleton.

---

# Dashboard Interval

The push interval is obtained using:

```js
const pushIntervalMs = config.dashboard?.pushIntervalMs || 1000;
```

Therefore:

* If `config.dashboard.pushIntervalMs` exists, it is used.
* Otherwise, the dashboard defaults to `1000 ms`.

Example:

```json
{
    "dashboard": {
        "pushIntervalMs": 2000
    }
}
```

This would make the dashboard send a new snapshot approximately every 2 seconds.

---

# `handleDashboardStream(req, res)`

The `createDashboard()` function returns an object containing:

```js
handleDashboardStream(req, res)
```

This function acts as the actual **SSE HTTP request handler**.

It is intended to be mounted at:

```text
config.dashboard.path
```

The default dashboard path configured elsewhere is:

```text
/nexus/dashboard/stream
```

---

# Server-Sent Events

## What is SSE?

Server-Sent Events allow a server to keep an HTTP connection open and continuously send events to a browser.

Unlike a normal HTTP response:

```text
Request
   ↓
Server
   ↓
Response
   ↓
Connection closes
```

SSE works like:

```text
Request
   ↓
Server
   ↓
Connection remains open
   │
   ├── Event
   ├── Event
   ├── Event
   ├── Event
   └── ...
```

The browser can receive these events using the JavaScript `EventSource` API.

---

# SSE Response Headers

When a dashboard client connects, the handler sends:

```js
res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
});
```

### `Content-Type`

```text
text/event-stream
```

This tells the browser that the response is an SSE stream.

### `Cache-Control`

```text
no-cache
```

Prevents intermediate caching of the live stream.

### `Connection`

```text
keep-alive
```

Indicates that the connection should remain open.

### `Access-Control-Allow-Origin`

```text
*
```

Allows a dashboard page hosted on another origin or development port to connect to the stream.

For example:

```text
Dashboard UI
localhost:3000
       │
       │ SSE
       ▼
Nexus Gateway
localhost:8000
```

---

# `flushHeaders()`

The handler checks:

```js
if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
}
```

This sends the HTTP headers immediately.

Without flushing, some browsers or proxies may wait until data is written before treating the connection as fully established.

For an SSE connection, immediately establishing the stream is useful.

---

# Sending Metrics

The `send()` function is responsible for pushing the current metrics snapshot:

```js
const send = () => {
    const snapshot = metrics.getSnapshot();
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
};
```

The process is:

```text
metrics.getSnapshot()
        │
        ▼
    JavaScript object
        │
        ▼
 JSON.stringify()
        │
        ▼
SSE data format
        │
        ▼
     res.write()
```

The SSE message looks conceptually like:

```text
data: {"requests":123,"errors":4,...}

```

The two newline characters are important because they mark the end of an SSE event.

---

# Immediate First Snapshot

The handler calls:

```js
send();
```

immediately after establishing the connection.

This prevents the dashboard from waiting for the first interval.

Without this:

```text
Connect
  │
  │ wait 1 second
  ▼
First metrics snapshot
```

With the current implementation:

```text
Connect
  │
  ▼
Immediate snapshot
  │
  ▼
Wait pushIntervalMs
  │
  ▼
Next snapshot
```

This makes the dashboard feel more responsive.

---

# Periodic Metrics Updates

After the first snapshot, the module creates:

```js
const timer = setInterval(send, pushIntervalMs);
```

For example, with:

```text
pushIntervalMs = 1000
```

the flow becomes:

```text
0s      → snapshot
1s      → snapshot
2s      → snapshot
3s      → snapshot
4s      → snapshot
...
```

Every snapshot is generated directly from:

```js
metrics.getSnapshot()
```

Therefore, the dashboard always reads the latest metrics state.

---

# SSE Keep-Alive

The module also creates another interval:

```js
const keepAlive = setInterval(
    () => res.write(': keep-alive\n\n'),
    20000
);
```

This sends an SSE comment every 20 seconds.

The message:

```text
: keep-alive
```

is not treated as a normal dashboard event.

Its purpose is to keep the connection active.

---

## Why Keep-Alive Is Needed

Some proxies and load balancers may terminate connections that appear idle for too long.

Even if the dashboard metrics do not change significantly, the connection can still benefit from periodic traffic:

```text
Dashboard
    │
    │ open SSE connection
    ▼
Nexus
    │
    │ : keep-alive
    │
    │ : keep-alive
    │
    │ : keep-alive
    ▼
Connection stays active
```

---

# Connection Cleanup

One of the most important parts of this file is cleanup.

Every dashboard connection creates two timers:

```text
metrics timer
keep-alive timer
```

If these timers were never cleared, opening and closing dashboard tabs repeatedly could leave unnecessary timers running.

The module therefore defines:

```js
const cleanup = () => {
    clearInterval(timer);
    clearInterval(keepAlive);
};
```

---

# Client Disconnect Handling

Cleanup is registered on both:

```js
req.on('close', cleanup);
res.on('close', cleanup);
```

This ensures the timers are stopped when the connection closes.

Conceptually:

```text
Dashboard connects
       │
       ▼
Create timers
       │
       ▼
Send metrics
       │
       ▼
Client disconnects
       │
       ▼
cleanup()
       │
       ├── clear metrics timer
       │
       └── clear keep-alive timer
```

This prevents timer/resource leaks.

---

# Why Both `req` and `res` Have Cleanup

The request and response objects can expose connection lifecycle events from different sides of the HTTP interaction.

Registering cleanup on both provides a defensive cleanup mechanism.

Calling:

```js
cleanup()
```

multiple times is safe because clearing an already-cleared interval does not cause a problem.

---

# No Metrics Reimplementation

This module intentionally does **not** maintain its own request counters.

It does not duplicate logic such as:

```text
request count
error count
latency
backend statistics
```

Instead, it relies on:

```js
metrics.getSnapshot()
```

This is important because otherwise the dashboard could display values different from the actual Nexus metrics.

The intended architecture is:

```text
                    metrics.js
                       │
              ┌────────┴────────┐
              ▼                 ▼
        Gateway logic      dashboard.js
              │                 │
              ▼                 ▼
      recordRequest()      getSnapshot()
                                │
                                ▼
                         SSE dashboard
```

---

# Integration With `server.js`

This file is designed to be integrated into the existing Nexus server.

The integration requires a small change to `server.js`.

First import:

```js
import { createDashboard } from './dashboard.js';
```

Then create the dashboard using the same metrics instance:

```js
const dashboard = createDashboard(config, metrics);
```

The important part is that `metrics` should be the same instance already created by `server.js`.

---

# Dashboard Route

The dashboard stream should be handled near the existing metrics endpoint.

Conceptually:

```js
if (config.dashboard?.path &&
    parsedUrl.pathname === config.dashboard.path) {
    return dashboard.handleDashboardStream(req, res);
}
```

This allows:

```text
/nexus/dashboard/stream
```

to be handled directly by the dashboard module.

---

# Integration Architecture

After integration, the server structure becomes approximately:

```text
                     server.js
                         │
             ┌───────────┴───────────┐
             │                       │
          metrics                dashboard
             │                       │
             │                 getSnapshot()
             │                       │
             ▼                       ▼
       Request Metrics          SSE Stream
             │                       │
             └───────────┬───────────┘
                         ▼
                    Browser UI
```

The dashboard is therefore another consumer of the central metrics system.

---

# Standalone Smoke Test

The file also contains a standalone test block.

It can be run directly using:

```text
node src/dashboard.js
```

The smoke test creates:

* a temporary HTTP server,
* a metrics instance,
* fake request traffic,
* a dashboard instance.

The server listens on:

```text
http://localhost:5055/nexus/dashboard/stream
```

The stream can be tested with:

```text
curl http://localhost:5055/nexus/dashboard/stream
```

---

# Fake Metrics Generation

The smoke test periodically generates fake requests:

```js
metrics.recordRequest({
    route: '/api',
    backend: 'http://localhost:4001',
    statusCode: Math.random() < 0.1 ? 500 : 200,
    durationMs: Math.floor(50 + Math.random() * 200),
});
```

This allows the dashboard stream to show changing metrics instead of remaining at zero.

The fake traffic includes:

* `/api` route
* `http://localhost:4001` backend
* mostly `200` responses
* occasional `500` responses
* random response durations

This is only for development/testing and is not part of the production dashboard logic.

---

# Zero-Dependency Design

One of the notable design decisions in this file is avoiding external real-time libraries.

It does not require:

```text
Socket.IO
WebSocket libraries
Grafana push components
```

Instead, it uses Node.js's built-in HTTP functionality:

```text
Node.js http
     +
res.write()
     +
Server-Sent Events
```

This keeps the implementation lightweight and reduces project dependencies.

---

# Request-to-Dashboard Flow

The complete runtime flow can be summarized as:

```text
1. Browser connects to dashboard endpoint
                │
                ▼
2. server.js routes request to dashboard.js
                │
                ▼
3. SSE headers are sent
                │
                ▼
4. Current metrics snapshot is sent immediately
                │
                ▼
5. Timer periodically calls metrics.getSnapshot()
                │
                ▼
6. Snapshot is serialized to JSON
                │
                ▼
7. JSON is sent as an SSE event
                │
                ▼
8. Keep-alive comments are periodically sent
                │
                ▼
9. Browser disconnects
                │
                ▼
10. All timers are cleared
```

---

# Important Design Decisions

## 1. Server-Sent Events Instead of WebSockets

SSE is sufficient because the communication pattern is primarily:

```text
Server → Browser
```

The dashboard does not need continuous browser-to-server communication.

---

## 2. Dependency Injection

The metrics instance is passed into:

```js
createDashboard(config, metrics)
```

instead of creating a global metrics instance.

This keeps the dashboard loosely coupled and makes it easier to test.

---

## 3. Immediate First Push

The first snapshot is sent immediately after connection.

This improves dashboard responsiveness.

---

## 4. Timer Cleanup

Timers are explicitly cleared when the connection closes.

This prevents unnecessary resources from remaining active for disconnected dashboard clients.

---

## 5. Centralized Metrics

The dashboard reads from:

```js
metrics.getSnapshot()
```

instead of maintaining separate counters.

This keeps dashboard data consistent with the main gateway metrics.

---

# Context Within Nexus Gateway

`dashboard.js` belongs to the **observability/monitoring layer** of Nexus Gateway.

A simplified architecture is:

```text
                    Nexus Gateway
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
     Routing          Security        Observability
        │                │                │
        ▼                ▼                ├── Metrics
    Backends         Auth/TLS             │
                                          └── Dashboard
                                               │
                                               ▼
                                          SSE Stream
                                               │
                                               ▼
                                         Browser UI
```

The file does not handle routing, authentication, backend communication, or metrics collection itself.

Its job is to **expose existing metrics to a live browser dashboard**.

---

# Summary

`src/dashboard.js` is the **live dashboard streaming backend for Nexus Gateway**.

Its main responsibilities are:

1. Create an SSE dashboard handler.
2. Send metrics snapshots to connected browsers.
3. Send the first snapshot immediately.
4. Push new snapshots at a configurable interval.
5. Send periodic keep-alive messages.
6. Clean up timers when clients disconnect.
7. Reuse the existing `metrics` instance.
8. Avoid additional WebSocket/Socket.IO dependencies.
9. Provide a standalone smoke test for development.
10. Integrate with `server.js` through the configured dashboard route.

In short:

```text
Metrics
   │
   │ getSnapshot()
   ▼
dashboard.js
   │
   │ JSON over SSE
   ▼
Browser Dashboard
```

The module provides a lightweight, dependency-free way to turn Nexus Gateway's existing metrics system into a **live browser dashboard**.
