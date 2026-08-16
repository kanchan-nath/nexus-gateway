# Changelog

All notable changes to the Nexus Reverse Proxy project will be documented in this file.

## [0.1.0] - 2026-08-16

### Added
- **Configuration System** (`config.js`)
  - Centralized JSON configuration file `nexus.config.json` for all Nexus settings
  - No code changes required to modify runtime behavior
  - Environment variable support for sensitive values (API keys, secrets)
  - Configuration validation with helpful error messages
  - Support for `--config` CLI flag to specify custom config paths

### Configuration Options Implemented

#### Core Server Settings
- **`listen`** - HTTP and HTTPS port configuration
  - `http`: 8080 (plain HTTP)
  - `https`: 8443 (TLS-encrypted HTTPS)
  
- **`tls`** - SSL/TLS certificate paths
  - `cert`: Path to certificate PEM file
  - `key`: Path to private key PEM file

#### Reverse Proxy Features
- **`backends`** - Backend server mapping
  - Path-based routing (e.g., `/api` → backend servers)
  - Support for multiple backend servers per path
  - Currently configured: `/api` routes to `localhost:4001` and `localhost:4002`

- **`loadBalancing`** - Load balancing algorithm
  - `round-robin`: Distributes requests evenly across backends (default)
  - Configurable to support additional algorithms in future

#### Health & Reliability
- **`healthCheck`** - Backend health monitoring
  - `path`: Health check endpoint (default: `/health`)
  - `intervalMs`: Check frequency (5000ms)
  - `timeoutMs`: Request timeout (2000ms)
  - `unhealthyThreshold`: Failures before marking backend dead (2)

#### Security & Authentication
- **`rateLimit`** - Rate limiting protection
  - `windowMs`: Time window in milliseconds (1000ms = 1 second)
  - `max`: Maximum requests per window (20 requests/second)

- **`auth`** - Request authentication
  - `required`: Enable/disable authentication globally
  - `apiKeys`: Simple API key authentication via `X-API-Key` header
  - `hmac`: HMAC-based request signing (bonus feature, disabled by default)
    - `enabled`: Toggle HMAC authentication
    - `secret`: HMAC signing secret

#### Data Persistence
- **`wal`** - Write-Ahead Logging
  - `enabled`: Enable request logging for durability (default: true)
  - `path`: Log file location (`./wal.log`)
  - Enables replay of requests after crash recovery

#### Monitoring & Observability
- **`metrics`** - Metrics endpoint
  - `path`: URL path for Prometheus-style metrics (`/nexus/metrics`)

- **`dashboard`** - Live dashboard streaming
  - `path`: SSE endpoint for dashboard updates (`/nexus/dashboard/stream`)
  - `pushIntervalMs`: Update frequency for dashboard (1000ms)

- **`logging`** - Logging configuration
  - `level`: Log verbosity (`info`, `debug`, `error`)


### Usage Example
```bash
# Start Nexus with default config
node src/cli.js start

# Start Nexus with custom config
node src/cli.js start --config ./my-config.json

# Verify config file parsing
node -e "console.log(require('./src/config').loadConfig('./nexus.config.json'))"
