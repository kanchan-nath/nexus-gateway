/**
 * test/metrics.test.js
 * -----------------------------------------------------------------------
 * Tests for src/metrics.js using Node's built-in `node:test` + `node:assert`
 * — zero-dependency test runner, no Jest/Mocha. Run with:
 *
 *   node --test
 *
 * Owner: Saikat
 * Status: DONE — real tests against a real, finished module.
 * -----------------------------------------------------------------------
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from '../src/metrics.js';

// -------------------------------------------------------------------------
// Minimal fake http.ServerResponse — handleMetricsRoute() only needs
// writeHead() and end(), so we stub just those two rather than pulling
// in a real server/socket for a unit test.
// -------------------------------------------------------------------------
function makeFakeRes() {
    return {
        statusCode: null,
        headers: null,
        body: null,
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(body) {
            this.body = body;
        },
    };
}

describe('createMetrics - basic counting', () => {
    test('starts at zero with no requests recorded', () => {
        const metrics = createMetrics();
        const snapshot = metrics.getSnapshot();

        assert.equal(snapshot.totalRequests, 0);
        assert.equal(snapshot.errorCount, 0);
        assert.equal(snapshot.errorRate, 0);
        assert.equal(snapshot.avgLatencyMs, 0);
        assert.deepEqual(snapshot.perBackend, {});
        assert.deepEqual(snapshot.perRoute, {});
    });

    test('totalRequests increments once per recordRequest call', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/api', backend: 'b1', statusCode: 200, durationMs: 10 });
        metrics.recordRequest({ route: '/api', backend: 'b1', statusCode: 200, durationMs: 10 });

        assert.equal(metrics.getSnapshot().totalRequests, 2);
    });

    test('statusCode >= 400 counts as an error (both 4xx and 5xx)', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/a', backend: 'b1', statusCode: 200, durationMs: 5 });
        metrics.recordRequest({ route: '/a', backend: 'b1', statusCode: 404, durationMs: 5 });
        metrics.recordRequest({ route: '/a', backend: 'b1', statusCode: 502, durationMs: 5 });

        const snapshot = metrics.getSnapshot();
        assert.equal(snapshot.totalRequests, 3);
        assert.equal(snapshot.errorCount, 2);
        assert.equal(snapshot.errorRate, round(2 / 3));
    });

    test('statusCode < 400 never counts as an error', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/a', backend: 'b1', statusCode: 200, durationMs: 5 });
        metrics.recordRequest({ route: '/a', backend: 'b1', statusCode: 301, durationMs: 5 });
        metrics.recordRequest({ route: '/a', backend: 'b1', statusCode: 399, durationMs: 5 });

        assert.equal(metrics.getSnapshot().errorCount, 0);
    });
});

describe('createMetrics - rolling window average latency', () => {
    test('averages all samples while under the window size', () => {
        const metrics = createMetrics({ rollingWindowSize: 5 });
        metrics.recordRequest({ statusCode: 200, durationMs: 10 });
        metrics.recordRequest({ statusCode: 200, durationMs: 20 });

        assert.equal(metrics.getSnapshot().avgLatencyMs, 15);
        assert.equal(metrics.getSnapshot().rollingWindowSamples, 2);
    });

    test('drops the oldest sample once the window is full', () => {
        const metrics = createMetrics({ rollingWindowSize: 3 });
        metrics.recordRequest({ statusCode: 200, durationMs: 10 }); // will be evicted
        metrics.recordRequest({ statusCode: 200, durationMs: 20 });
        metrics.recordRequest({ statusCode: 200, durationMs: 30 });
        metrics.recordRequest({ statusCode: 200, durationMs: 40 }); // evicts the 10

        const snapshot = metrics.getSnapshot();
        assert.equal(snapshot.rollingWindowSamples, 3);
        // Average of 20, 30, 40 = 30 (the 10 must be gone)
        assert.equal(snapshot.avgLatencyMs, 30);
    });

    test('defaults to a window size of 100 when not specified', () => {
        const metrics = createMetrics();
        for (let i = 0; i < 150; i++) {
            metrics.recordRequest({ statusCode: 200, durationMs: 1 });
        }
        assert.equal(metrics.getSnapshot().rollingWindowSamples, 100);
    });
});

describe('createMetrics - per-backend and per-route breakdown', () => {
    test('tracks requests/errors/avgLatency separately per backend', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/api', backend: 'http://b1', statusCode: 200, durationMs: 10 });
        metrics.recordRequest({ route: '/api', backend: 'http://b1', statusCode: 500, durationMs: 30 });
        metrics.recordRequest({ route: '/api', backend: 'http://b2', statusCode: 200, durationMs: 100 });

        const { perBackend } = metrics.getSnapshot();
        assert.equal(perBackend['http://b1'].requests, 2);
        assert.equal(perBackend['http://b1'].errors, 1);
        assert.equal(perBackend['http://b1'].avgLatencyMs, 20); // (10+30)/2
        assert.equal(perBackend['http://b2'].requests, 1);
        assert.equal(perBackend['http://b2'].errors, 0);
    });

    test('tracks requests/errors/avgLatency separately per route', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/api', backend: 'b1', statusCode: 200, durationMs: 10 });
        metrics.recordRequest({ route: '/auth', backend: 'b1', statusCode: 404, durationMs: 5 });

        const { perRoute } = metrics.getSnapshot();
        assert.equal(perRoute['/api'].requests, 1);
        assert.equal(perRoute['/auth'].requests, 1);
        assert.equal(perRoute['/auth'].errors, 1);
    });

    test('requests without a route/backend (e.g. unmatched 404) are still counted globally but not attributed', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: null, backend: null, statusCode: 404, durationMs: 3 });

        const snapshot = metrics.getSnapshot();
        assert.equal(snapshot.totalRequests, 1);
        assert.deepEqual(snapshot.perBackend, {});
        assert.deepEqual(snapshot.perRoute, {});
    });
});

describe('createMetrics - handleMetricsRoute', () => {
    test('responds 200 with a JSON body matching getSnapshot()', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/api', backend: 'b1', statusCode: 200, durationMs: 10 });

        const res = makeFakeRes();
        metrics.handleMetricsRoute({}, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'application/json');

        const parsed = JSON.parse(res.body);
        assert.equal(parsed.totalRequests, 1);
        assert.ok(parsed.perBackend['b1']);
    });
});

describe('createMetrics - reset', () => {
    test('clears all counters back to zero', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/api', backend: 'b1', statusCode: 500, durationMs: 50 });
        assert.equal(metrics.getSnapshot().totalRequests, 1);

        metrics.reset();

        const snapshot = metrics.getSnapshot();
        assert.equal(snapshot.totalRequests, 0);
        assert.equal(snapshot.errorCount, 0);
        assert.equal(snapshot.avgLatencyMs, 0);
        assert.deepEqual(snapshot.perBackend, {});
        assert.deepEqual(snapshot.perRoute, {});
    });
});

describe('createMetrics - instance isolation', () => {
    test('two instances never share state', () => {
        const a = createMetrics();
        const b = createMetrics();

        a.recordRequest({ route: '/a', backend: 'b1', statusCode: 200, durationMs: 5 });

        assert.equal(a.getSnapshot().totalRequests, 1);
        assert.equal(b.getSnapshot().totalRequests, 0);
    });
});

function round(n) {
    return Math.round(n * 100) / 100;
}
