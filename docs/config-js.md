# Configuration Loader & Validator

## Overview

This file is responsible for **loading, validating, modifying, and applying defaults to the Nexus Gateway configuration**.

The configuration is expected to be stored in a JSON file, typically:

```text
nexus.config.json
```

Instead of allowing the rest of the application to directly use raw configuration data, this module provides a controlled flow:

```text
nexus.config.json
       │
       ▼
   Read File
       │
       ▼
   Parse JSON
       │
       ▼
Environment Overrides
       │
       ▼
 Validate Configuration
       │
       ▼
   Apply Defaults
       │
       ▼
 Valid Configuration
```

This makes configuration errors easier to detect early and keeps sensitive values such as API keys and HMAC secrets out of the configuration file when environment variables are used.

---

## Purpose

The main responsibilities of this file are:

* Read `nexus.config.json` from disk.
* Detect missing or unreadable configuration files.
* Parse and detect invalid JSON.
* Override sensitive configuration values using environment variables.
* Validate the structure and values of the configuration.
* Provide meaningful configuration errors.
* Apply default values for optional settings.
* Return a ready-to-use configuration object to the rest of Nexus Gateway.

---

## Main Components

### 1. `VALID_STRATEGIES`

```js
const VALID_STRATEGIES = [
    'round-robin',
    'least-connections',
    'weighted'
];
```

This defines the load-balancing strategies supported by Nexus Gateway.

If the configuration specifies a strategy that is not in this list, configuration validation fails.

Supported strategies:

| Strategy            | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `round-robin`       | Distribute requests sequentially across backends    |
| `least-connections` | Prefer the backend with fewer active connections    |
| `weighted`          | Distribute requests according to configured weights |

---

# `ConfigError`

```js
export class ConfigError extends Error
```

`ConfigError` is a custom error class used specifically for configuration-related problems.

Instead of throwing generic JavaScript errors, the module throws:

```js
new ConfigError(...)
```

This allows the application to distinguish configuration failures from other runtime errors.

The error name is explicitly set to:

```text
ConfigError
```

Example:

```text
ConfigError: config file not found: /path/to/nexus.config.json
```

---

# `loadConfig(configPath)`

## Purpose

`loadConfig()` is the main public function of this module.

It loads the configuration file and runs the complete configuration-processing pipeline.

### Processing Flow

```text
configPath
    │
    ▼
Resolve absolute path
    │
    ▼
Read configuration file
    │
    ├── File missing → ConfigError
    └── Read failure → ConfigError
    │
    ▼
Parse JSON
    │
    └── Invalid JSON → ConfigError
    │
    ▼
Apply environment overrides
    │
    ▼
Validate configuration
    │
    └── Invalid configuration → ConfigError
    │
    ▼
Apply default values
    │
    ▼
Return configuration
```

### Important Order

The function intentionally performs:

```js
applyEnvOverrides(config);
validateConfig(config);
applyDefaults(config);
```

This means environment variables are applied **before validation**.

This is important because an environment variable may provide a required value that was not present in the JSON file.

---

# Environment Variable Overrides

Sensitive configuration values can be supplied through environment variables instead of being stored directly in `nexus.config.json`.

This is especially useful because configuration files may be committed to Git.

## `NEXUS_API_KEYS`

```text
NEXUS_API_KEYS
```

This environment variable contains a comma-separated list of API keys.

Example:

```text
NEXUS_API_KEYS=key-one,key-two,key-three
```

It is converted into:

```js
[
    'key-one',
    'key-two',
    'key-three'
]
```

Whitespace is removed and empty values are ignored.

The resulting value replaces:

```js
config.auth.apiKeys
```

---

## `NEXUS_HMAC_SECRET`

```text
NEXUS_HMAC_SECRET
```

This overrides:

```js
config.auth.hmac.secret
```

Example:

```text
NEXUS_HMAC_SECRET=my-secret-value
```

This prevents the HMAC secret from needing to exist inside the configuration file.

---

# `validateConfig(config)`

## Purpose

`validateConfig()` ensures that the configuration has the expected structure and valid values.

If something is invalid, it immediately throws a `ConfigError`.

The validation covers several major areas.

---

## 1. Root Configuration

The configuration must be a JSON object.

Invalid examples include:

```json
[]
```

```json
"config"
```

```json
null
```

The expected structure is:

```json
{
    "listen": {},
    "backends": {}
}
```

---

# 2. Listen Configuration

The `listen` section defines the ports on which Nexus Gateway should listen.

Example:

```json
{
    "listen": {
        "http": 8080
    }
}
```

At least one of these must exist:

```text
http
https
```

Both can be configured:

```json
{
    "listen": {
        "http": 8080,
        "https": 8443
    }
}
```

However, HTTP and HTTPS cannot use the same port.

Invalid:

```json
{
    "listen": {
        "http": 8080,
        "https": 8080
    }
}
```

---

# 3. Backend Configuration

The `backends` section defines the backend servers to which Nexus Gateway can forward requests.

Conceptually:

```text
route → backend URLs
```

Example:

```json
{
    "backends": {
        "/api": [
            "http://localhost:8001",
            "http://localhost:8002"
        ]
    }
}
```

Each route must map to an array of backend URLs.

At least one route must exist.

Each backend URL must use:

```text
http://
```

or:

```text
https://
```

This prevents malformed backend addresses from reaching the routing layer.

---

# 4. Load-Balancing Strategy

The optional `loadBalancing` property controls how requests are distributed between backend servers.

Allowed values:

```text
round-robin
least-connections
weighted
```

Example:

```json
{
    "loadBalancing": "round-robin"
}
```

If an unsupported strategy is supplied, a `ConfigError` is thrown.

---

# 5. TLS Configuration

TLS configuration is required when HTTPS listening is enabled.

For example:

```json
{
    "listen": {
        "https": 8443
    },
    "tls": {
        "cert": "./cert.pem",
        "key": "./key.pem"
    }
}
```

Both values are required:

```text
tls.cert
tls.key
```

This ensures that HTTPS cannot be enabled without the necessary certificate and private key configuration.

---

# 6. Rate Limiting

The optional `rateLimit` configuration controls request rate limiting.

Example:

```json
{
    "rateLimit": {
        "windowMs": 1000,
        "max": 20
    }
}
```

Validation requires:

```text
windowMs > 0
max > 0
```

Both values must be numbers.

Conceptually:

```text
windowMs
   │
   ▼
Time window for rate limiting

max
   │
   ▼
Maximum allowed requests in that window
```

---

# 7. Authentication Configuration

The `auth` section controls whether requests must be authenticated.

Example:

```json
{
    "auth": {
        "required": true,
        "apiKeys": [
            "example-key"
        ]
    }
}
```

If:

```text
auth.required = true
```

then at least one authentication method must be configured.

The supported methods checked here are:

* API keys
* HMAC authentication

Therefore, this configuration is invalid:

```json
{
    "auth": {
        "required": true,
        "apiKeys": [],
        "hmac": {
            "enabled": false
        }
    }
}
```

because authentication is required but no authentication mechanism is enabled.

---

# `applyDefaults(config)`

## Purpose

After validation succeeds, `applyDefaults()` fills in optional configuration values that were not explicitly provided.

This allows users to keep `nexus.config.json` relatively small.

For example, the user does not necessarily need to specify:

```json
{
    "loadBalancing": "round-robin"
}
```

because `round-robin` is automatically applied.

---

## Default Configuration

### Load Balancing

```text
round-robin
```

Default:

```js
config.loadBalancing = 'round-robin';
```

---

### Health Checks

Default:

```json
{
    "path": "/health",
    "intervalMs": 5000,
    "timeoutMs": 2000,
    "unhealthyThreshold": 2
}
```

This provides Nexus Gateway with a standard backend health-check configuration.

---

### Rate Limiting

Default:

```json
{
    "windowMs": 1000,
    "max": 20
}
```

This means the gateway defaults to a 1-second rate-limit window with a maximum of 20 requests.

---

### Authentication

Default:

```json
{
    "required": false,
    "apiKeys": []
}
```

HMAC defaults to:

```json
{
    "enabled": false,
    "secret": ""
}
```

Therefore, authentication is disabled by default.

---

### WAL

WAL stands for **Write-Ahead Log**.

Default:

```json
{
    "enabled": true,
    "path": "./wal.log"
}
```

This means the gateway uses a WAL by default and stores it at:

```text
./wal.log
```

---

### Metrics

Default:

```json
{
    "path": "/nexus/metrics"
}
```

This defines the endpoint used for metrics.

---

### Dashboard

Default:

```json
{
    "path": "/nexus/dashboard/stream",
    "pushIntervalMs": 1000
}
```

This provides the default dashboard streaming endpoint and update interval.

---

### Logging

Default:

```json
{
    "level": "info"
}
```

The default logging level is therefore:

```text
info
```

---

# Configuration Processing Design

The module follows a simple and useful separation of responsibilities:

```text
loadConfig()
    │
    ├── File handling
    │
    ├── JSON parsing
    │
    ├── Environment overrides
    │
    ├── Validation
    │
    └── Defaults
```

Each stage has a specific responsibility.

### File Handling

Responsible for finding and reading the configuration file.

### JSON Parsing

Responsible for converting the file contents into a JavaScript object.

### Environment Overrides

Responsible for injecting sensitive/runtime-specific values.

### Validation

Responsible for rejecting invalid configuration.

### Defaults

Responsible for filling optional settings.

---

# Why This File Is Important

This file acts as the **configuration boundary of Nexus Gateway**.

Other modules should not need to repeatedly check whether:

* a port exists,
* backend URLs are valid,
* TLS configuration exists,
* the selected load-balancing strategy is supported,
* authentication is configured correctly,
* rate-limit values are valid.

Those checks are centralized here.

This gives the rest of the application a much cleaner assumption:

```text
If loadConfig() returns successfully,
the configuration has passed the module's validation rules
and has its default values applied.
```

---

# Security Context

One of the most important aspects of this file is its handling of sensitive values.

API keys and HMAC secrets can be supplied through environment variables:

```text
NEXUS_API_KEYS
NEXUS_HMAC_SECRET
```

This helps avoid storing secrets directly in:

```text
nexus.config.json
```

and therefore reduces the risk of accidentally committing credentials to Git.

A typical deployment can therefore keep configuration such as:

```json
{
    "auth": {
        "required": true
    }
}
```

while providing the actual secret values through the environment.

---

# Error Handling

Configuration errors are converted into `ConfigError` instances.

Examples of possible errors include:

```text
config file not found
failed to read config file
invalid JSON in config file
config root must be a JSON object
config.listen is required
config.backends must define at least one route
invalid backend URL
unsupported load-balancing strategy
TLS configuration missing
invalid rate-limit configuration
authentication required but no authentication method configured
```

This makes startup failures much easier to understand and debug.

---

# Context Within Nexus Gateway

This module belongs to the **startup/configuration layer** of Nexus Gateway.

A simplified architecture can be viewed as:

```text
                nexus.config.json
                       │
                       ▼
              Configuration Module
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Routing      Security     Server
          │            │            │
          ▼            ▼            ▼
      Backends      Auth/TLS     HTTP/HTTPS
```

The configuration module sits near the beginning of the application lifecycle because the gateway needs valid configuration before it can safely initialize its server, routing, authentication, health checks, metrics, and other components.

---

# Summary

This file is the **central configuration loader and validator for Nexus Gateway**.

Its core responsibilities are:

1. Load `nexus.config.json`.
2. Parse the JSON safely.
3. Override sensitive values using environment variables.
4. Validate the configuration structure.
5. Reject invalid configuration with `ConfigError`.
6. Apply sensible defaults.
7. Return a normalized configuration object for the rest of the application.

In short:

```text
Raw Configuration
        ↓
   Load + Parse
        ↓
 Environment Overrides
        ↓
     Validate
        ↓
 Apply Defaults
        ↓
Ready-to-use Nexus Configuration
```

This design keeps configuration logic centralized and prevents invalid or incomplete configuration from propagating into the rest of the Nexus Gateway.
