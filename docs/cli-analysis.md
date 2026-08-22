# `src/cli.js` — Code Analysis

## 1. Overview

`src/cli.js` is the **command-line interface and application entrypoint** of Nexus.

It is responsible for:

- Parsing CLI arguments.
- Supporting `--help` and `--version`.
- Validating the `start` command.
- Resolving the configuration file path.
- Loading configuration through `config.js`.
- Creating and starting the HTTP server through `server.js`.
- Creating and starting HTTPS through `tls.js` when configured.
- Handling `SIGINT` and `SIGTERM`.
- Gracefully shutting down all running servers.
- Returning appropriate process exit codes.

Example:

```bash
node src/cli.js start --config ./nexus.config.json
```

The file follows Nexus's **zero-dependency philosophy** by manually parsing `process.argv` instead of using libraries such as `yargs` or `commander`.

---

## 2. Position in Nexus Architecture

```text
Terminal
   |
   v
src/cli.js
   |
   +---- config.js
   |       |
   |       v
   |   Nexus Config
   |
   +---- server.js
   |       |
   |       +---- router
   |       +---- load balancer
   |       +---- health checker
   |       +---- rate limiter
   |       +---- authentication
   |       +---- metrics
   |       +---- WAL
   |       +---- dashboard
   |
   +---- tls.js
           |
           v
        HTTPS
```

`cli.js` is primarily an **orchestrator**. It does not implement routing, authentication, rate limiting, load balancing, or proxy forwarding itself.

---

# 3. Imports

The file imports Node.js built-ins and Nexus modules:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
```

### Important application imports

### `loadConfig()`

```js
import { loadConfig } from './config.js';
```

Loads and validates Nexus configuration.

### `createServer()`

```js
import { createServer } from './server.js';
```

Creates the Nexus HTTP server and its shared request-processing context.

### Unused imports

In the supplied implementation:

```js
fs
fileURLToPath
```

are not used.

They can be removed unless they are intended for upcoming functionality.

---

# 4. Package Metadata

```js
const PACKAGE_NAME = 'nexus-gateway';
const PACKAGE_VERSION = '1.0.0';
```

These constants provide the application name and version without importing `package.json`.

They are used by:

- `--help`
- `--version`
- startup messages

---

# 5. `parseArgs(argv)`

```js
function parseArgs(argv)
```

This function manually parses command-line arguments.

Node exposes CLI arguments through:

```js
process.argv
```

The first two entries are normally:

```text
argv[0] → Node executable
argv[1] → script path
```

Therefore:

```js
const args = argv.slice(2);
```

extracts only arguments supplied by the user.

---

# 6. Parsed Argument Object

The parser initializes:

```js
const result = {
    command: null,
    configPath: null,
    help: false,
    version: false,
};
```

So the parser normalizes CLI input into:

```text
command
configPath
help
version
```

For:

```bash
node src/cli.js start --config ./nexus.config.json
```

the conceptual result is:

```js
{
    command: 'start',
    configPath: './nexus.config.json',
    help: false,
    version: false
}
```

---

# 7. Help Flag

The parser supports:

```bash
--help
```

and:

```bash
-h
```

using:

```js
if (arg === '--help' || arg === '-h') {
    result.help = true;
    continue;
}
```

This allows both long and short CLI syntax.

---

# 8. Version Flag

Supported forms:

```bash
--version
-v
```

The parser sets:

```js
result.version = true;
```

The main function later prints the version and exits successfully.

---

# 9. Config Flag

Supported forms:

```bash
--config <path>
```

and:

```bash
-c <path>
```

The parser consumes the next argument as the configuration path:

```js
result.configPath = args[i + 1];
i++;
```

Example:

```bash
node src/cli.js start -c ./my-config.json
```

results in:

```js
configPath: './my-config.json'
```

---

# 10. Command Detection

The first non-flag argument becomes the command:

```js
if (result.command === null && !arg.startsWith('-')) {
    result.command = arg;
}
```

Currently the supported command is:

```text
start
```

Therefore:

```bash
node src/cli.js start
```

produces:

```js
command: 'start'
```

---

# 11. `printHelp()`

```js
function printHelp()
```

Displays the CLI's usage instructions.

It documents:

- application name
- version
- usage
- available options
- examples
- authentication-related environment variables

Example:

```bash
node src/cli.js start --config ./nexus.config.json
```

---

# 12. Environment Variables

The help output documents:

```text
NEXUS_API_KEYS
NEXUS_HMAC_SECRET
```

These values are not parsed directly by `cli.js`.

Instead, the flow is:

```text
cli.js
   |
   v
loadConfig()
   |
   v
config.js
   |
   v
environment overrides
```

This keeps configuration logic centralized in `config.js`.

---

# 13. `shutdown(servers, logger, exitCode)`

```js
function shutdown(servers, logger, exitCode = 0)
```

This function performs graceful application shutdown.

It receives:

- all running servers
- a logger
- desired process exit code

The design supports multiple listeners, for example:

```text
HTTP
+
HTTPS
```

---

# 14. Shutdown Algorithm

The function counts active servers:

```js
let remaining = 0;
```

For each listening server:

```js
remaining++;
```

Then:

```js
server.close(() => {
    remaining--;

    if (remaining === 0) {
        process.exit(exitCode);
    }
});
```

The process exits only after all active servers have closed.

---

# 15. Why Multiple Servers Matter

Nexus can potentially run:

```text
HTTP server
HTTPS server
```

simultaneously.

Therefore shutdown cannot simply close one server.

The `servers` array allows the CLI to coordinate the entire process.

---

# 16. Forced Shutdown Safety Net

The function includes:

```js
setTimeout(() => {
    console.error('Force exit after timeout');
    process.exit(exitCode);
}, 5000);
```

This prevents the process from hanging indefinitely.

Normal shutdown gets approximately:

```text
5 seconds
```

before a forced exit.

---

# 17. `main()`

```js
async function main()
```

This is the main application lifecycle function.

Its overall sequence is:

```text
Parse arguments
      ↓
Handle help/version
      ↓
Validate command
      ↓
Validate config path
      ↓
Load configuration
      ↓
Start HTTP if configured
      ↓
Start HTTPS if configured
      ↓
Register shutdown handling
      ↓
Keep process alive
```

---

# 18. Help Handling

```js
if (args.help) {
    printHelp();
    process.exit(0);
}
```

Exit code `0` means successful execution.

The application does not start Nexus when help is requested.

---

# 19. Version Handling

```js
if (args.version) {
    console.log(PACKAGE_VERSION);
    process.exit(0);
}
```

The current version is:

```text
1.0.0
```

and the process exits successfully.

---

# 20. Command Validation

Only:

```text
start
```

is currently supported.

If the user executes:

```bash
node src/cli.js something
```

the CLI reports an unknown command and exits with:

```text
1
```

---

# 21. Configuration Validation

The `start` command requires:

```bash
--config <path>
```

If the path is missing:

```js
if (!args.configPath)
```

the program exits with code `1`.

This prevents Nexus from starting without configuration.

---

# 22. Resolving the Config Path

```js
const configPath = path.resolve(
    process.cwd(),
    args.configPath
);
```

The supplied path is converted into an absolute path.

Importantly, resolution is based on:

```js
process.cwd()
```

which is the directory from which the command was executed.

---

# 23. Loading Configuration

```js
config = loadConfig(configPath);
```

`config.js` is responsible for the actual configuration processing.

It can handle things such as:

- reading configuration
- validation
- defaults
- environment overrides
- authentication configuration

If configuration loading fails:

```js
console.error(`Error loading config: ${err.message}`);
process.exit(1);
```

Nexus refuses to start with invalid configuration.

---

# 24. Server Collection

```js
const servers = [];
```

This stores all active listeners.

Potential state:

```text
servers[0] → HTTP
servers[1] → HTTPS
```

The same array is later passed to `shutdown()`.

---

# 25. HTTP Server Creation

HTTP is started only if:

```js
config.listen.http != null
```

Then:

```js
const server = createServer(config);
```

is called.

`createServer()` belongs to `server.js` and constructs the complete Nexus request pipeline.

---

# 26. Starting HTTP

The CLI calls:

```js
server.listen(port, () => {
    server.logger.info(
        `Nexus listening on http://localhost:${port}`
    );
});
```

This illustrates a clean separation of responsibilities:

```text
server.js
    ↓
creates server

cli.js
    ↓
starts server
```

`createServer()` itself does not automatically start listening.

---

# 27. Registering HTTP

After creation:

```js
servers.push(server);
```

stores the server for later shutdown.

---

# 28. Signal Handling

The CLI handles:

```text
SIGINT
SIGTERM
```

### SIGINT

Usually generated by:

```text
Ctrl+C
```

### SIGTERM

Commonly used by:

- process managers
- containers
- deployment systems
- operating systems

Both signals trigger:

```js
shutdown(servers, logger, 0)
```

---

# 29. HTTP Startup Error Handling

HTTP startup is wrapped in:

```js
try/catch
```

If it fails:

```text
Failed to start HTTP server: <reason>
```

is printed and the process exits with code `1`.

---

# 30. HTTPS Startup

HTTPS is optional:

```js
if (config.listen.https != null)
```

When enabled, the CLI dynamically imports:

```js
const { createTLSServer } =
    await import('./tls.js');
```

This means TLS support is loaded only when HTTPS is actually configured.

---

# 31. Shared Context Between HTTP and HTTPS

The CLI obtains:

```js
const httpServer = servers[0];
```

and passes it to:

```js
createTLSServer(
    config,
    httpServer?.logger,
    httpServer
);
```

The purpose is to reuse the existing Nexus context.

Conceptually:

```text
             Shared Context
                   |
        +----------+----------+
        |                     |
       HTTP                 HTTPS
        |                     |
        +---------------------+
```

This can keep shared components such as:

- logger
- metrics
- load balancer
- health checker
- WAL
- rate limiter
- request handler

consistent across both protocols.

---

# 32. Why Context Reuse Is Important

Creating separate contexts could result in:

```text
HTTP  → health checker A
HTTPS → health checker B
```

or:

```text
HTTP  → metrics A
HTTPS → metrics B
```

or:

```text
HTTP  → rate limiter A
HTTPS → rate limiter B
```

That can cause inconsistent state and duplicate background work.

Reusing the context avoids unnecessary duplication.

---

# 33. Starting HTTPS

The HTTPS server is started with:

```js
httpsServer.listen(
    config.listen.https,
    () => {
        httpsServer.logger.info(
            `Nexus listening on https://localhost:${config.listen.https}`
        );
    }
);
```

It is then added to:

```js
servers
```

for coordinated shutdown.

---

# 34. HTTPS Startup Errors

HTTPS creation is also protected by `try/catch`.

Failures produce:

```text
Failed to start HTTPS server: <reason>
```

and exit code `1`.

---

# 35. No Servers Configured

After attempting HTTP and HTTPS startup:

```js
if (servers.length === 0)
```

means neither listener was configured.

The CLI exits with:

```text
No servers configured to listen (need http or https)
```

and exit code `1`.

This prevents a process from appearing to run successfully while serving nothing.

---

# 36. Successful Startup

Once at least one server is listening:

```js
console.log(
    `Nexus v${PACKAGE_VERSION} running. Press Ctrl+C to stop.`
);
```

The Node.js event loop stays alive because the server listener is active.

---

# 37. Top-Level Error Handling

At the bottom:

```js
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
```

handles unexpected asynchronous failures.

There are therefore two layers of error handling:

```text
Expected operation-specific errors
            ↓
        try/catch

Unexpected async errors
            ↓
       main().catch()
```

---

# 38. Exit Code Reference

| Situation | Exit Code |
|---|---:|
| `--help` | `0` |
| `--version` | `0` |
| Successful shutdown | `0` |
| Unknown command | `1` |
| Missing config | `1` |
| Config loading failure | `1` |
| HTTP startup failure | `1` |
| HTTPS startup failure | `1` |
| No configured listener | `1` |

This is useful for:

- shell scripts
- CI/CD
- Docker
- process managers
- automated monitoring

---

# 39. Complete Startup Flow

```text
node src/cli.js start --config ./nexus.config.json
                     |
                     v
                parseArgs()
                     |
                     v
              command = start?
                 /                         NO            YES
               |              |
             exit 1           v
                        config path?
                            |
                            v
                       loadConfig()
                            |
                            v
                     Config valid?
                       /                            NO         YES
                     |           |
                   exit 1        v
                           HTTP configured?
                               |
                               v
                          createServer()
                               |
                               v
                           listen()
                               |
                               v
                         HTTPS configured?
                            /                                 NO         YES
                          |           |
                          |       import tls.js
                          |           |
                          |       reuse context
                          |           |
                          |       HTTPS listen
                          +-----+-----+
                                |
                                v
                       servers.length > 0?
                           /                                    NO             YES
                         |               |
                       exit 1            v
                                  Nexus running
```

---

# 40. Complete Shutdown Flow

```text
Ctrl+C / SIGINT
       |
       v
   shutdown()
       |
       v
Close HTTP
       |
       v
Close HTTPS
       |
       v
Wait for all callbacks
       |
       v
 process.exit(0)
```

If something hangs:

```text
5 seconds
    ↓
Force exit
```

---

# 41. Separation of Responsibilities

`cli.js` does **not** implement:

- request routing
- authentication
- rate limiting
- load balancing
- backend health checking
- reverse proxy forwarding
- metrics implementation
- WAL implementation

Instead:

```text
cli.js
  → application lifecycle

server.js
  → request pipeline

config.js
  → configuration

tls.js
  → HTTPS/TLS

specialized modules
  → individual gateway features
```

This is a clean separation of concerns.

---

# 42. Strengths of the Implementation

## Zero dependency

Manual `process.argv` parsing avoids a CLI framework.

## Simple entrypoint

There is one clear startup command:

```bash
node src/cli.js start --config <path>
```

## Configuration driven

Ports and behavior come from the Nexus configuration.

## HTTP + HTTPS

The same CLI can manage either or both listeners.

## Graceful shutdown

SIGINT and SIGTERM are explicitly handled.

## Shared server context

HTTP and HTTPS can use the same internal Nexus state.

## Meaningful exit codes

Startup failures return non-zero status.

---

# 43. Potential Improvements

## 43.1 Remove unused imports

The current implementation contains:

```js
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
```

but they are unused.

Unless future functionality requires them, they should be removed.

---

## 43.2 Better missing-value error

Currently:

```bash
node src/cli.js start --config
```

eventually becomes a generic missing-config error.

A more precise CLI could report:

```text
Error: --config requires a path
```

---

## 43.3 Reject unknown options

Unknown options are currently not explicitly rejected.

For example:

```bash
node src/cli.js start --random-option
```

could be silently ignored.

A stricter parser could return:

```text
Error: Unknown option --random-option
```

---

## 43.4 Simplify signal registration

Signal handlers are currently registered inside the HTTP/HTTPS startup branches.

A cleaner design could register them once after all configured servers have been created.

For example:

```text
create all servers
      ↓
register SIGINT/SIGTERM once
      ↓
start application
```

This makes lifecycle management easier to reason about.

---

## 43.5 HTTPS-only startup consideration

The code uses:

```js
const httpServer = servers[0];
```

when creating HTTPS.

If Nexus is configured for HTTPS only, `servers[0]` may not represent an HTTP server.

A more robust architecture would create a shared request context independently of the HTTP listener, then pass that context to both HTTP and HTTPS.

That would match the architecture already described in `server.js`.

---

# 44. Recommended Testing

The CLI should ideally have tests for:

### Argument parsing

```text
start
--config
-c
--help
-h
--version
-v
```

### Invalid command

```bash
node src/cli.js invalid
```

Expected exit code:

```text
1
```

### Missing config

```bash
node src/cli.js start
```

Expected exit code:

```text
1
```

### Valid configuration

Verify that the configured listener starts successfully.

### HTTP startup

Verify:

```js
createServer(config)
server.listen(...)
```

### HTTPS startup

Verify that:

```js
createTLSServer()
```

is called only when HTTPS is configured.

### Signals

Verify:

```text
SIGINT → graceful shutdown
SIGTERM → graceful shutdown
```

### Multiple servers

Test:

```text
HTTP only
HTTPS only
HTTP + HTTPS
```

### Shutdown timeout

Verify that a hanging server eventually triggers the five-second safety exit.

---

# 45. Relationship With Other Nexus Modules

| Module | Responsibility |
|---|---|
| `config.js` | Loads and validates configuration |
| `server.js` | Builds the request pipeline |
| `tls.js` | Creates HTTPS/TLS server |
| `router.js` | Determines backend route |
| `loadbalancer.js` | Selects backend |
| `healthcheck.js` | Monitors backend health |
| `ratelimiter.js` | Applies per-client rate limits |
| `auth.js` | Performs authentication |
| `metrics.js` | Collects request metrics |
| `wal.js` | Provides write-ahead logging |
| `dashboard.js` | Provides dashboard functionality |

`cli.js` coordinates these modules during application startup and shutdown.

---

# 46. Quick Reference

| Function | Purpose |
|---|---|
| `parseArgs()` | Parses command-line arguments |
| `printHelp()` | Displays CLI help |
| `shutdown()` | Gracefully stops servers |
| `main()` | Orchestrates application startup |

---

# 47. Final Summary

`src/cli.js` is the **top-level launcher and lifecycle manager for Nexus**.

Its responsibility can be summarized as:

```text
CLI arguments
      ↓
Load configuration
      ↓
Create servers
      ↓
Start HTTP / HTTPS
      ↓
Run Nexus
      ↓
Receive shutdown signal
      ↓
Gracefully close servers
```

The file follows the project's zero-dependency philosophy while maintaining a clean separation between:

- CLI concerns
- configuration
- server creation
- TLS
- request processing

Its most important architectural feature is the ability to reuse the same Nexus context between HTTP and HTTPS, preventing duplicate stateful components such as health checkers, metrics, WAL handling, load balancing, and rate limiting.

Overall, `cli.js` acts as the **application lifecycle manager and command-line interface** for the Nexus gateway.
