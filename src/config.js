import fs from 'node:fs';
import path from 'node:path';

const VALID_STRATEGIES = ['round-robin', 'least-connections', 'weighted'];

export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

/**
 * Load and validate nexus.config.json from disk.
 * Throws ConfigError on missing file, bad JSON, or invalid shape.
 */
export function loadConfig(configPath) {
    const resolvedPath = path.resolve(configPath);

    let raw;
    try {
        raw = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new ConfigError(`config file not found: ${resolvedPath}`);
        }
        throw new ConfigError(`failed to read config file: ${err.message}`);
    }

    let config;
    try {
        config = JSON.parse(raw);
    } catch (err) {
        throw new ConfigError(`invalid JSON in config file: ${err.message}`);
    }

    applyEnvOverrides(config);
    validateConfig(config);
    applyDefaults(config);

    return config;
}

/**
 * Sensitive values (API keys, HMAC secret) can be overridden via env vars
 * so they never have to live in nexus.config.json / git history.
 *   NEXUS_API_KEYS    - comma-separated list, overrides auth.apiKeys
 *   NEXUS_HMAC_SECRET - overrides auth.hmac.secret
 */
function applyEnvOverrides(config) {
    if (process.env.NEXUS_API_KEYS) {
        config.auth = config.auth || {};
        config.auth.apiKeys = process.env.NEXUS_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
    }
    if (process.env.NEXUS_HMAC_SECRET) {
        config.auth = config.auth || {};
        config.auth.hmac = config.auth.hmac || {};
        config.auth.hmac.secret = process.env.NEXUS_HMAC_SECRET;
    }
}

function validateConfig(config) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new ConfigError('config root must be a JSON object');
    }

    // listen
    if (!config.listen || typeof config.listen !== 'object') {
        throw new ConfigError('config.listen is required (e.g. { "http": 8080 })');
    }
    if (config.listen.http == null && config.listen.https == null) {
        throw new ConfigError('config.listen must define at least one of "http" or "https"');
    }
    if (
        config.listen.http != null &&
        config.listen.https != null &&
        config.listen.http === config.listen.https
    ) {
        throw new ConfigError(
            `config.listen.http and config.listen.https cannot use the same port (${config.listen.http})`
        );
    }

    // backends
    if (!config.backends || typeof config.backends !== 'object' || Array.isArray(config.backends)) {
        throw new ConfigError('config.backends is required and must be an object mapping path -> [urls]');
    }
    const routes = Object.keys(config.backends);
    if (routes.length === 0) {
        throw new ConfigError('config.backends must define at least one route');
    }
    for (const route of routes) {
        const pool = config.backends[route];
        if (!Array.isArray(pool)) {
            throw new ConfigError(`config.backends["${route}"] must be an array of backend URLs`);
        }
        for (const url of pool) {
            if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
                throw new ConfigError(`config.backends["${route}"] contains invalid URL: ${url}`);
            }
        }
    }

    // loadBalancing
    if (config.loadBalancing != null && !VALID_STRATEGIES.includes(config.loadBalancing)) {
        throw new ConfigError(
            `config.loadBalancing must be one of ${VALID_STRATEGIES.join(', ')}, got "${config.loadBalancing}"`
        );
    }

    // tls (only required if https listen is set)
    if (config.listen.https != null) {
        if (!config.tls || typeof config.tls !== 'object') {
            throw new ConfigError('config.tls is required when config.listen.https is set');
        }
        if (!config.tls.cert || !config.tls.key) {
            throw new ConfigError('config.tls.cert and config.tls.key are required when config.listen.https is set');
        }
    }

    // rateLimit
    if (config.rateLimit != null) {
        if (typeof config.rateLimit.windowMs !== 'number' || config.rateLimit.windowMs <= 0) {
            throw new ConfigError('config.rateLimit.windowMs must be a positive number');
        }
        if (typeof config.rateLimit.max !== 'number' || config.rateLimit.max <= 0) {
            throw new ConfigError('config.rateLimit.max must be a positive number');
        }
    }

    // auth
    if (config.auth != null) {
        if (
            config.auth.required &&
            !(Array.isArray(config.auth.apiKeys) && config.auth.apiKeys.length > 0) &&
            !(config.auth.hmac && config.auth.hmac.enabled)
        ) {
            throw new ConfigError('config.auth.required is true but no apiKeys array or hmac.enabled auth method is configured');
        }
    }
}

function applyDefaults(config) {
    if (config.loadBalancing == null) config.loadBalancing = 'round-robin';

    config.healthCheck = Object.assign(
        { path: '/health', intervalMs: 5000, timeoutMs: 2000, unhealthyThreshold: 2 },
        config.healthCheck || {}
    );

    config.rateLimit = Object.assign(
        { windowMs: 1000, max: 20 },
        config.rateLimit || {}
    );

    config.auth = Object.assign(
        { required: false, apiKeys: [] },
        config.auth || {}
    );
    config.auth.hmac = Object.assign({ enabled: false, secret: '' }, config.auth.hmac || {});

    config.wal = Object.assign({ enabled: true, path: './wal.log' }, config.wal || {});

    config.metrics = Object.assign({ path: '/nexus/metrics' }, config.metrics || {});

    config.dashboard = Object.assign(
        { path: '/nexus/dashboard/stream', pushIntervalMs: 1000 },
        config.dashboard || {}
    );

    config.logging = Object.assign({ level: 'info' }, config.logging || {});
}