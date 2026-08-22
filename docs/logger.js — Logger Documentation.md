# `logger.js`

## Purpose

`logger.js` provides a centralized, zero-dependency logging system for Nexus.

It replaces the temporary inline logging logic in `server.js` and provides consistent logging through:

* `debug`
* `info`
* `error`
* `warn`

It uses only Node.js built-in `console` and `Date` functionality, avoiding external logging libraries such as Winston or Pino.

## Context

Instead of implementing logging separately inside different modules, Nexus uses this module as a common logging layer.

```text id="w2l6a0"
Nexus Modules
     ↓
 createLogger()
     ↓
 logger.debug()
 logger.info()
 logger.error()
     ↓
 Console Output
```

This keeps log formatting and log-level behavior consistent throughout the application.

## Log Levels

The logger supports three configured levels:

```text id="j3f9cs"
debug < info < error
```

The configured level determines which messages are displayed.

| Configured Level | Output                 |
| ---------------- | ---------------------- |
| `debug`          | Debug, info, and error |
| `info`           | Info and error         |
| `error`          | Error only             |

If the configured level is missing or invalid, the logger defaults to `info`.

## Log Format

Each log message follows a consistent format:

```text id="4x8q5d"
[2026-08-17T10:00:00.000Z] INFO  Server started
```

It contains:

* ISO timestamp
* Uppercase log level
* Log message

Error messages use `console.error()`, while other messages use `console.log()`.

## Main Functions

### `createLogger(config)`

Creates a logger using the configured `logging.level`.

It safely falls back to `info` when the configuration is missing or invalid.

### `debug(message)`

Logs a debug-level message.

It is shown only when the configured level is `debug`.

### `info(message)`

Logs a normal informational message.

### `error(message)`

Logs an error-level message.

Errors are always displayed when the configured level is `debug`, `info`, or `error`.

### `warn(message)`

Provides a warning-style API but currently uses the `info` log level internally.

### `logRequest(req, statusCode, startTime)`

Logs information about a completed HTTP request.

Example:

```text id="w5v2rp"
GET /api/users → 200 15ms
```

The request duration is calculated using:

```text id="q7r1me"
Date.now() - startTime
```

Responses with status codes `500` or higher are automatically logged at the `error` level.

## Default Logger

The module also exports a default `logger` instance.

It uses the default `info` level and is useful in scripts or places where a full configuration object is not available.

For the main Nexus gateway, `createLogger(config)` should be preferred so the configured logging level is respected.

## Integration

### `server.js`

`server.js` uses `createLogger()` instead of maintaining its own inline request logger.

This keeps request logging centralized and consistent.

### Other Modules

Modules such as:

* `router.js`
* `loadbalancer.js`
* `healthcheck.js`
* `wal.js`
* `ratelimiter.js`
* `auth.js`
* `tls.js`

can use the same logger when they need to report important events.

New code should use this logger instead of directly calling `console.log()`.

## Overall Summary

`logger.js` is the **central logging layer** of Nexus.

Its main flow is:

```text id="z2h4ky"
Configuration
     ↓
logging.level
     ↓
createLogger()
     ↓
Log Level Filtering
     ↓
Formatted Console Output
```

It provides consistent, configurable, and dependency-free logging across the Nexus gateway.
