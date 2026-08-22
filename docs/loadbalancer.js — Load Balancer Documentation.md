# `loadbalancer.js`

## Purpose

`loadbalancer.js` is responsible for selecting which backend should handle an incoming request in Nexus.

It supports three load-balancing strategies:

* **Round-robin** — cycles through available backends.
* **Least-connections** — selects the backend with the fewest active connections.
* **Weighted** — selects backends according to their configured weights.

The module is implemented using native JavaScript `Map` objects and counters, so no external load-balancing library is required.

## Context

`server.js` needs to select a backend before forwarding each request. This module separates that logic from `server.js`.

```text
Client Request
      ↓
   server.js
      ↓
loadbalancer.js
      ↓
Select Backend
      ↓
Forward Request
```

The backend pool and selected strategy come from the Nexus configuration.

## Route State

The module maintains state separately for each route.

Each route stores:

* `index` — current position for round-robin.
* `connections` — active connection count for each backend.
* `totalWeight` — combined backend weight.

This allows different routes to maintain independent load-balancing state.

## Backend Helpers

### `getBackendUrl()`

Extracts the backend URL from either supported configuration format:

```text
"http://localhost:4001"
```

or:

```text
{
  "url": "http://localhost:4001",
  "weight": 3
}
```

### `getBackendWeight()`

Returns the configured backend weight.

If no valid weight is provided, it defaults to `1`.

## Health Check Support

`isBackendHealthy()` determines whether a backend should be considered available.

If no health information is provided, the backend is assumed to be healthy.

The function can work with:

* An object exposing `isHealthy()`
* A `Map`
* A plain object

This allows future integration with `healthcheck.js`.

## Load-Balancing Strategies

### Round-Robin

`pickRoundRobin()` selects backends sequentially.

Example:

```text
Request 1 → Backend A
Request 2 → Backend B
Request 3 → Backend C
Request 4 → Backend A
```

Unhealthy backends are skipped.

### Least-Connections

`pickLeastConnections()` checks the current active connection count of each healthy backend and selects the one with the lowest count.

Example:

```text
Backend A → 5 connections
Backend B → 2 connections
Backend C → 4 connections
```

Result:

```text
Backend B
```

The connection count must be updated using `incrementConnections()` and `decrementConnections()`.

### Weighted

`pickWeighted()` selects a backend based on its configured weight.

Example:

```text
Backend A → weight 3
Backend B → weight 1
```

Over many requests, Backend A will receive approximately three times as many requests as Backend B.

Selection is performed using `Math.random()`.

## Main API

### `createLoadBalancer(config, healthStatus)`

Creates a load-balancer instance using the strategy configured in `config.loadBalancing`.

Supported strategies:

```text
round-robin
least-connections
weighted
```

It also validates the configured strategy before creating the instance.

### `pickBackend(route)`

Returns the selected backend URL for a route.

Returns `null` if the route has no valid backend pool or no healthy backend is available.

### `incrementConnections(route, backendUrl)`

Increases the active connection count for a backend.

### `decrementConnections(route, backendUrl)`

Decreases the active connection count after a request finishes.

### `getConnections(route, backendUrl)`

Returns the current active connection count for a backend.

### `withConnection(route, backendUrl, fn)`

Automatically manages connection tracking around an asynchronous operation.

```text
Increment
   ↓
Execute request
   ↓
Decrement
```

The `finally` block ensures the count is decreased even if the operation fails.

### `setHealthStatus()`

Updates the health information used when selecting backends.

### `getStrategy()`

Returns the currently configured load-balancing strategy.

### `resetRoute()` / `resetAll()`

Clear stored state for testing purposes.

## Legacy API

`pickBackend()` is also exported separately for backward compatibility with the older `server.js` implementation.

If an existing load-balancer instance is provided, it uses that instance. Otherwise, it creates a temporary load balancer.

## Integration

### `server.js`

`server.js` should create one load-balancer instance during startup and use it when handling requests.

Typical flow:

```text
Request
   ↓
matchRoute()
   ↓
pickBackend()
   ↓
Forward Request
```

For the least-connections strategy, `server.js` must also increment the connection count when forwarding starts and decrement it when the request finishes.

### `healthcheck.js`

When health checking is integrated, unhealthy backends can be excluded from selection automatically.

### `config.js`

`config.js` validates the supported strategies and provides backend configuration, including weights for the weighted strategy.

### `metrics.js`

No direct dependency is required. `server.js` can record metrics after the backend has been selected.

## Overall Summary

`loadbalancer.js` is the **backend selection layer** of Nexus.

Its responsibility is to:

```text
Route
  ↓
Backend Pool
  ↓
Filter Unhealthy Backends
  ↓
Apply Load-Balancing Strategy
  ↓
Select Backend
```

It keeps load-balancing logic separate from `server.js` while supporting multiple strategies, connection tracking, health-check integration, and testing utilities without external dependencies.
