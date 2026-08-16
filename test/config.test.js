import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, ConfigError } from '../src/config.js';

const REAL_CONFIG = path.resolve('./nexus.config.json');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-config-test-'));

// write a temp JSON fixture, return its path
function fixture(name, contentObjOrString) {
    const p = path.join(TMP_DIR, name);
    const body = typeof contentObjOrString === 'string' ? contentObjOrString : JSON.stringify(contentObjOrString);
    fs.writeFileSync(p, body, 'utf8');
    return p;
}

function baseConfig(overrides = {}) {
    return Object.assign(
        {
            listen: { http: 8080 },
            backends: { '/api': ['http://localhost:4001'] }
        },
        overrides
    );
}

describe('nexus.config.json (real project file)', () => {
    test('1. valid full config loads with no throw', () => {
        const config = loadConfig(REAL_CONFIG);
        assert.equal(config.listen.http, 8080);
        assert.equal(config.listen.https, 8443);
        assert.ok(Array.isArray(config.backends['/api']));
    });
});

after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

describe('config.js — validateConfig()', () => {
    test('2. missing file path throws ConfigError "not found"', () => {
        assert.throws(
            () => loadConfig(path.join(TMP_DIR, 'does-not-exist.json')),
            (err) => err instanceof ConfigError && /not found/.test(err.message)
        );
    });

    test('3. malformed JSON throws ConfigError "invalid JSON"', () => {
        const p = fixture('bad.json', '{ "listen": { "http": 8080 }, }'); // trailing comma
        assert.throws(
            () => loadConfig(p),
            (err) => err instanceof ConfigError && /invalid JSON/.test(err.message)
        );
    });

    test('4. missing listen key throws', () => {
        const p = fixture('no-listen.json', { backends: { '/api': ['http://localhost:4001'] } });
        assert.throws(() => loadConfig(p), ConfigError);
    });

    test('5. listen.http === listen.https same port throws', () => {
        const p = fixture('port-clash.json', baseConfig({ listen: { http: 8080, https: 8080 } }));
        assert.throws(
            () => loadConfig(p),
            (err) => err instanceof ConfigError && /same port/.test(err.message)
        );
    });

    test('6. missing backends key throws', () => {
        const p = fixture('no-backends.json', { listen: { http: 8080 } });
        assert.throws(() => loadConfig(p), ConfigError);
    });

    test('7. empty backends pool array passes (route exists, empty pool is a runtime concern)', () => {
        const p = fixture('empty-pool.json', baseConfig({ backends: { '/api': [] } }));
        const config = loadConfig(p);
        assert.deepEqual(config.backends['/api'], []);
    });

    test('8. invalid URL scheme in backends throws', () => {
        const p = fixture('bad-url.json', baseConfig({ backends: { '/api': ['ftp://bad'] } }));
        assert.throws(
            () => loadConfig(p),
            (err) => err instanceof ConfigError && /invalid URL/.test(err.message)
        );
    });

    test('9. bogus loadBalancing strategy throws', () => {
        const p = fixture('bad-lb.json', baseConfig({ loadBalancing: 'bogus-strategy' }));
        assert.throws(
            () => loadConfig(p),
            (err) => err instanceof ConfigError && /loadBalancing/.test(err.message)
        );
    });

    test('10. omitted loadBalancing defaults to round-robin', () => {
        const p = fixture('no-lb.json', baseConfig());
        const config = loadConfig(p);
        assert.equal(config.loadBalancing, 'round-robin');
    });

    test('11. listen.https set without tls block throws', () => {
        const p = fixture('https-no-tls.json', baseConfig({ listen: { https: 8443 } }));
        assert.throws(
            () => loadConfig(p),
            (err) => err instanceof ConfigError && /tls/.test(err.message)
        );
    });

    test('12. negative rateLimit.max throws', () => {
        const p = fixture('bad-ratelimit.json', baseConfig({ rateLimit: { windowMs: 1000, max: -5 } }));
        assert.throws(
            () => loadConfig(p),
            (err) => err instanceof ConfigError && /rateLimit/.test(err.message)
        );
    });

    test('13. auth.required true with no apiKeys and no hmac throws', () => {
        const p = fixture('bad-auth.json', baseConfig({ auth: { required: true } }));
        assert.throws(
            () => loadConfig(p),
            (err) => err instanceof ConfigError && /auth/.test(err.message)
        );
    });

    test('14. minimal config gets full defaults for optional sections', () => {
        const p = fixture('minimal.json', baseConfig());
        const config = loadConfig(p);
        assert.equal(config.healthCheck.path, '/health');
        assert.equal(config.wal.enabled, true);
        assert.equal(config.metrics.path, '/nexus/metrics');
        assert.equal(config.dashboard.pushIntervalMs, 1000);
        assert.equal(config.logging.level, 'info');
    });
});

describe('config.js — env var overrides', () => {
    const p = fixture('env-test.json', baseConfig({ auth: { required: true, apiKeys: ['json-key'] } }));

    test('15. NEXUS_API_KEYS overrides JSON apiKeys', () => {
        process.env.NEXUS_API_KEYS = 'key1, key2';
        try {
            const config = loadConfig(p);
            assert.deepEqual(config.auth.apiKeys, ['key1', 'key2']);
        } finally {
            delete process.env.NEXUS_API_KEYS;
        }
    });

    test('16. empty NEXUS_API_KEYS does not override', () => {
        process.env.NEXUS_API_KEYS = '';
        try {
            const config = loadConfig(p);
            assert.deepEqual(config.auth.apiKeys, ['json-key']);
        } finally {
            delete process.env.NEXUS_API_KEYS;
        }
    });

    test('17. NEXUS_HMAC_SECRET overrides secret even when hmac.enabled is false', () => {
        process.env.NEXUS_HMAC_SECRET = 'super-secret';
        try {
            const config = loadConfig(p);
            assert.equal(config.auth.hmac.secret, 'super-secret');
            assert.equal(config.auth.hmac.enabled, false);
        } finally {
            delete process.env.NEXUS_HMAC_SECRET;
        }
    });
});

describe('config.js — zero-dependency compliance', () => {
    test('18. source imports only node: builtins, no third-party packages', () => {
        const src = fs.readFileSync(path.resolve('./src/config.js'), 'utf8');
        const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
        for (const imp of imports) {
            assert.ok(imp.startsWith('node:'), `non-stdlib import found: ${imp}`);
        }
    });
});