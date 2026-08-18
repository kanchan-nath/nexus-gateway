/**
 * test/logger.test.js
 * -----------------------------------------------------------------------
 * Tests for src/logger.js using Node's built-in `node:test` + `node:assert`
 * — zero-dependency test runner, no Jest/Mocha. Run with:
 *
 *   node --test
 *
 * Owner: Saikat
 * Status: DONE — real tests against a real, finished module.
 * -----------------------------------------------------------------------
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, logger as defaultLogger } from '../src/logger.js';

// -------------------------------------------------------------------------
// Small helper: temporarily replace console.log/console.error so we can
// capture what the logger actually printed, then restore the originals.
// No mocking library needed — just plain function swapping.
// -------------------------------------------------------------------------
let captured;
let originalLog;
let originalError;

beforeEach(() => {
    captured = { log: [], error: [] };
    originalLog = console.log;
    originalError = console.error;
    console.log = (line) => captured.log.push(line);
    console.error = (line) => captured.error.push(line);
});

afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
});

describe('createLogger - level filtering', () => {
    test('defaults to "info" level when config is missing/invalid', () => {
        const log = createLogger(null);
        assert.equal(log.level, 'info');
    });

    test('defaults to "info" level when config.logging.level is invalid', () => {
        const log = createLogger({ logging: { level: 'not-a-real-level' } });
        assert.equal(log.level, 'info');
    });

    test('"info" level: prints info and error, suppresses debug', () => {
        const log = createLogger({ logging: { level: 'info' } });
        log.debug('should be suppressed');
        log.info('should print');
        log.error('should also print');

        assert.equal(captured.log.length, 1);
        assert.match(captured.log[0], /INFO\s+should print/);
        assert.equal(captured.error.length, 1);
        assert.match(captured.error[0], /ERROR\s+should also print/);
    });

    test('"debug" level: prints everything', () => {
        const log = createLogger({ logging: { level: 'debug' } });
        log.debug('debug line');
        log.info('info line');
        log.error('error line');

        assert.equal(captured.log.length, 2); // debug + info both go to console.log
        assert.equal(captured.error.length, 1);
    });

    test('"error" level: suppresses debug and info, only error prints', () => {
        const log = createLogger({ logging: { level: 'error' } });
        log.debug('suppressed');
        log.info('also suppressed');
        log.error('prints');

        assert.equal(captured.log.length, 0);
        assert.equal(captured.error.length, 1);
    });
});

describe('createLogger - line format', () => {
    test('log lines include an ISO timestamp and padded level tag', () => {
        const log = createLogger({ logging: { level: 'info' } });
        log.info('hello world');

        const line = captured.log[0];
        // e.g. "[2026-08-17T15:23:57.774Z] INFO  hello world"
        assert.match(
            line,
            /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO\s{2}hello world$/
        );
    });
});

describe('createLogger - logRequest', () => {
    test('formats method, url, status, and duration', () => {
        const log = createLogger({ logging: { level: 'info' } });
        const fakeReq = { method: 'GET', url: '/api/widgets' };
        const startTime = Date.now() - 42; // pretend the request took ~42ms

        log.logRequest(fakeReq, 200, startTime);

        assert.equal(captured.log.length, 1);
        assert.match(captured.log[0], /GET \/api\/widgets -> 200 \d+ms/);
    });

    test('uses "info" level for 2xx/3xx/4xx status codes', () => {
        const log = createLogger({ logging: { level: 'info' } });
        const fakeReq = { method: 'GET', url: '/x' };

        log.logRequest(fakeReq, 200, Date.now());
        log.logRequest(fakeReq, 404, Date.now());

        assert.equal(captured.log.length, 2);
        assert.equal(captured.error.length, 0);
    });

    test('escalates to "error" level for 5xx status codes', () => {
        const log = createLogger({ logging: { level: 'info' } });
        const fakeReq = { method: 'GET', url: '/x' };

        log.logRequest(fakeReq, 502, Date.now());

        assert.equal(captured.log.length, 0);
        assert.equal(captured.error.length, 1);
        assert.match(captured.error[0], /-> 502/);
    });

    test('5xx requests still print even when level is "error" (never fully silenced)', () => {
        const log = createLogger({ logging: { level: 'error' } });
        const fakeReq = { method: 'POST', url: '/y' };

        log.logRequest(fakeReq, 503, Date.now());

        assert.equal(captured.error.length, 1);
    });
});

describe('default logger export', () => {
    test('is usable without any config (level defaults to info)', () => {
        assert.equal(defaultLogger.level, 'info');
        defaultLogger.info('works standalone');
        assert.equal(captured.log.length, 1);
    });
});
