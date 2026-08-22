# `logger.js`

## Purpose

`logger.js` Nexus ka **centralized structured logger** hai.

Ye `server.js` ke old inline `logRequest()` logic ko replace karta hai aur bina kisi external logging library ke:

- `debug`
- `info`
- `error`
- `warn`

messages handle karta hai.

Isme sirf JavaScript ka built-in `console` aur `Date` use hota hai.

## Context

Nexus me logging ko alag module me rakhne ka purpose hai ki har component same log format aur log-level rules follow kare.

```text
server.js / other modules
          ↓
     logger.js
          ↓
     console output
```

Isse different files me manually `console.log()` likhne ki zarurat nahi padti.

## Log Levels

Logger 3 levels support karta hai:

```text
debug < info < error
```

Configured level ke according output filter hota hai.

| Config Level | Output |
|---|---|
| `debug` | debug + info + error |
| `info` | info + error |
| `error` | error only |

Agar configuration missing ya invalid ho, default level `info` use hota hai.

## Log Format

Har log line ka format:

```text
[2026-08-17T10:00:00.000Z] INFO  message text here
```

Isme:

- Timestamp → `Date().toISOString()`
- Level → uppercase aur aligned
- Message → actual log information

`error` messages `console.error()` ke through stderr par jaate hain, jabki baaki messages `console.log()` use karte hain.

## Main Functions

### `createLogger(config)`

Configuration ke `logging.level` ke according logger instance create karta hai.

Example:

```text
createLogger(config)
       ↓
configured level
       ↓
debug / info / error filtering
```

### `debug(message)`

Debug-level message print karta hai.

### `info(message)`

Normal informational message print karta hai.

### `error(message)`

Error-level message print karta hai.

### `warn(message)`

Warning ko currently `info` level ke equivalent treat karta hai.

### `logRequest(req, statusCode, startTime)`

HTTP request ka summary log karta hai.

Example:

```text
GET /api -> 200 15ms
```

Ye automatically request duration calculate karta hai:

```text
Date.now() - startTime
```

Agar status code `500` ya usse higher hai, request ko automatically `error` level par log karta hai.

## Default Logger

File ek default:

```text
logger
```

export bhi karti hai.

Ye `info` level par configured hota hai aur un places ke liye useful hai jahan complete config available nahi hai.

Actual Nexus gateway pipeline me preferably `createLogger(config)` use karna chahiye.

## Integration

### `server.js`

`server.js` logger ko import karke existing request logging ke liye use karta hai.

Isse old inline `logRequest()` implementation ki zarurat nahi rahti.

### Other Modules

`router.js`, `loadbalancer.js`, `healthcheck.js`, `wal.js`, `ratelimiter.js`, `auth.js`, aur `tls.js` jaise modules bhi zarurat padne par same logger use kar sakte hain.

New code me direct `console.log()` avoid karna chahiye, taaki poore project ka logging behavior consistent rahe.

## Overall Summary

`logger.js` Nexus ka **central logging layer** hai.

Iska main flow:

```text
Config
  ↓
logging.level
  ↓
createLogger()
  ↓
debug / info / error
  ↓
Level filtering
  ↓
Formatted console output
```

Overall, ye file logging ko `server.js` se separate karke **consistent, configurable aur zero-dependency logging system** provide karti hai.