# Backend Health Checker

## Overview

`src/healthcheck.js` is responsible for **monitoring the health of Nexus Gateway backends**.

It periodically sends HTTP requests to each backend's health endpoint and determines whether the backend should continue receiving traffic.

```text
Backends
   │
   ▼
Health Checker
   │
   ├── HTTP health probe
   ├── Failure tracking
   ├── Healthy / Unhealthy status
   └── Response time
   │
   ▼
Load Balancer / Dashboard / Server
```

It uses Node.js built-in `http.request()` and `setInterval()` instead of external health-check libraries.

---

# Purpose

The main responsibilities are:

* Periodically check all backend servers.
* Determine whether each backend is healthy.
* Track consecutive failures.
* Mark backends unhealthy after a configured failure threshold.
* Restore backends to healthy when they respond successfully.
* Expose health information to other Nexus modules.
* Log health state transitions.
* Support manual health checks.

---

# `createHealthChecker(config, logger, options)`

This is the main exported function:

```js
createHealthChecker(config, logger, options)
```

It uses health-check configuration such as:

```text
intervalMs
timeoutMs
unhealthyThreshold
path
```

Defaults are:

```text
intervalMs          → 5000 ms
timeoutMs           → 2000 ms
unhealthyThreshold  → 2
health path         → /health
```

Optional `options` can override these values.

---

# Backend Status

Each backend maintains a status object containing:

```text
healthy
failures
lastCheck
lastError
responseTimeMs
```

The statuses are stored in:

```js
const statusMap = new Map();
```

This provides a central health state for all configured backends.

---

# Health Check Flow

For each backend, `checkBackendHealth()` sends an HTTP request to its health endpoint.

```text
Backend URL
    │
    ▼
/health
    │
    ▼
HTTP Request
    │
    ├── 2xx response → Healthy
    ├── Non-2xx       → Failure
    ├── Timeout       → Failure
    └── Request error → Failure
```

A successful `2xx` response marks the backend healthy.

Timeouts and request errors count as failures.

---

# Failure Threshold

A backend is not immediately marked unhealthy after one failure.

Instead, consecutive failures are tracked:

```text
Failure 1 → still healthy
Failure 2 → unhealthy
```

The exact threshold comes from:

```text
unhealthyThreshold
```

When the threshold is reached, the backend becomes unhealthy and a warning is logged.

When a previously unhealthy backend succeeds again, its failure count is reset and it becomes healthy.

---

# Checking All Backends

`checkAllBackends()` checks all unique backend URLs.

Checks are performed concurrently in batches of **5** to avoid overwhelming the system.

```text
Backend 1 ─┐
Backend 2  │
Backend 3  ├── Batch of 5
Backend 4  │
Backend 5 ─┘
       │
       ▼
Next batch
```

It returns a map containing:

```text
backend URL → healthy status
```

---

# Lifecycle

## `start()`

Starts health monitoring.

It:

1. Initializes backend statuses.
2. Performs an immediate health check.
3. Starts periodic checks using `setInterval()`.

```text
start()
  │
  ├── Initial check
  │
  └── Periodic checks
```

It also prevents the checker from being started multiple times.

---

## `stop()`

Stops periodic health checks and cancels pending requests/timeouts.

This ensures that the health checker does not continue running after shutdown.

---

# Status API

The module exposes several ways to access health information.

### `getBackendStatus(url)`

Returns detailed status for one backend.

### `isBackendHealthy(url)`

Returns:

```text
true / false
```

### `getStatus()`

Returns the complete internal `Map`.

### `getStatusAsObject()`

Returns health information as a normal object, useful for JSON serialization.

### `getHealthyBackends()`

Returns only healthy backend URLs.

### `getUnhealthyBackends()`

Returns only unhealthy backend URLs.

---

# Manual Controls

The checker also supports manual operations:

```text
forceCheck()
forceCheckBackend(url)
resetBackend(url)
```

These are useful for administration, testing, or recovery workflows.

---

# Integration With Nexus

The health checker is mainly consumed by other Nexus components.

### `server.js`

Creates and starts the health checker:

```js
const healthChecker = createHealthChecker(config, logger);
healthChecker.start();
```

### `loadbalancer.js`

Uses health status to avoid sending traffic to unhealthy backends.

### `dashboard.js`

Can display backend health information.

### `logger.js`

Receives structured health transition logs.

### `metrics.js`

Can potentially track health-check failures in a future enhancement.

---

# Overall Architecture

```text
                 Nexus Gateway
                       │
                       ▼
                healthcheck.js
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Probe       Track Status    Log
          │            │
          ▼            ▼
      Backends     Health Map
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
        Load Balancer        Dashboard
        skip unhealthy       show status
```

---

# Summary

`healthcheck.js` is the **backend health monitoring component of Nexus Gateway**.

Its core responsibilities are:

1. Probe backend health endpoints.
2. Track consecutive failures.
3. Mark backends healthy/unhealthy.
4. Automatically restore healthy backends.
5. Provide health status to the load balancer and dashboard.
6. Run checks periodically.
7. Support manual checks and clean shutdown.

In short:

```text
Probe Backends
      ↓
Evaluate Response
      ↓
Track Failures
      ↓
Healthy / Unhealthy
      ↓
Load Balancer Uses Status
```

This prevents Nexus from continuously routing traffic to failed or unreachable backend servers.
