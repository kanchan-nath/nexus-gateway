# `loadbalancer.js`

## Purpose

`loadbalancer.js` Nexus ke liye **load balancing** handle karta hai. Ye decide karta hai ki kisi route ki request ko available backend servers me se **kis backend par bhejna hai**.

Ye 3 strategies support karta hai:

- **Round-robin** — backends ko turn-by-turn select karta hai.
- **Least-connections** — jis backend par sabse kam active requests hain, use select karta hai.
- **Weighted** — backend ke configured weight ke according selection karta hai.

Isme koi external load-balancing library use nahi hoti; state maintain karne ke liye JavaScript `Map` aur counters use kiye gaye hain.

## Context

Nexus ke `server.js` me request aane par backend select karna hota hai. Pehle ye logic `server.js` ke andar temporary `pickBackend()` function se handle ho raha tha.

Ye file us logic ko separate module me move karti hai aur multiple load-balancing strategies provide karti hai.

Typical flow:

```text
Client Request
      ↓
   server.js
      ↓
loadbalancer.js
      ↓
Select Strategy
      ↓
Choose Backend
      ↓
Forward Request
```

`config.js` se load-balancing strategy aur backend pool ki information milti hai.

## Simple Analysis

### 1. Route State

Har route ka state `routeState` Map me maintain hota hai.

State me mainly:

- `index` → round-robin ke liye current position
- `connections` → har backend ke active connections
- `totalWeight` → backends ke total weights

Isse different routes ka load-balancing state separately maintain hota hai.

### 2. Backend Helpers

`getBackendUrl()` backend entry se URL nikalta hai.

Backend config dono formats support kar sakta hai:

```text
"http://localhost:4001"
```

ya:

```text
{ "url": "http://localhost:4001", "weight": 3 }
```

`getBackendWeight()` weight return karta hai. Agar weight configured nahi hai, to default `1` use hota hai.

### 3. Health Check Support

`isBackendHealthy()` backend ki health check karta hai.

Agar health information available nahi hai, backend ko healthy maana jata hai.

Future me `healthcheck.js` integrate hone par unhealthy backends ko automatically skip kiya ja sakta hai.

### 4. Round-Robin

`pickRoundRobin()` healthy backends ke through sequentially cycle karta hai.

Example:

```text
Request 1 → Backend A
Request 2 → Backend B
Request 3 → Backend C
Request 4 → Backend A
```

`index` counter next backend decide karta hai.

### 5. Least-Connections

`pickLeastConnections()` har backend ke active connection count ko check karta hai.

Example:

```text
Backend A → 5 connections
Backend B → 2 connections
Backend C → 4 connections
```

Selection:

```text
Backend B
```

`incrementConnections()` aur `decrementConnections()` request lifecycle ke according counts update karte hain.

### 6. Weighted

`pickWeighted()` backend ke configured weight ke basis par selection karta hai.

Example:

```text
Backend A → weight 3
Backend B → weight 1
```

Backend A ko approximately **75%** aur Backend B ko **25%** requests milengi over a large number of requests.

Selection ke liye `Math.random()` use hota hai.

## Main Public API

### `createLoadBalancer(config, healthStatus)`

Load balancer instance create karta hai aur configured strategy validate karta hai.

### `pickBackend(route)`

Given route ke liye suitable backend return karta hai.

### `incrementConnections(route, backendUrl)`

Backend ka active connection count increase karta hai.

### `decrementConnections(route, backendUrl)`

Active connection count decrease karta hai.

### `getConnections(route, backendUrl)`

Current active connections return karta hai.

### `withConnection(route, backendUrl, fn)`

Function execute karte waqt automatically connection count manage karta hai.

```text
increment
   ↓
execute request
   ↓
decrement
```

`finally` use hone ki wajah se error aane par bhi connection count properly decrease hota hai.

### `setHealthStatus()`

Health-check information update karta hai.

### `resetRoute()` / `resetAll()`

Testing ke liye stored load-balancing state reset karte hain.

## Integration with Other Files

### `server.js`

`server.js` ko load balancer instance create karke request handling ke time `pickBackend()` use karna hai.

Least-connections ke liye request start/end par connection count bhi update karna hoga.

### `healthcheck.js`

Future health-check module healthy backends provide karega. Unhealthy backends ko load balancer automatically skip kar sakta hai.

### `config.js`

`config.js` load-balancing strategy validate karta hai:

```text
round-robin
least-connections
weighted
```

Weighted strategy ke liye backend weights configuration me provide kiye ja sakte hain.

### `metrics.js`

Is file me direct changes required nahi hain. Backend select hone ke baad `server.js` metrics record kar sakta hai.

## Overall Summary

`loadbalancer.js` Nexus ka **backend selection layer** hai.

Iska main responsibility hai:

```text
Route
 ↓
Backend Pool
 ↓
Remove unhealthy backends
 ↓
Apply configured strategy
 ↓
Select backend
```

Ye module `server.js` ko load-balancing logic se separate rakhta hai aur future me health checks aur additional strategies integrate karne ke liye structure provide karta hai.