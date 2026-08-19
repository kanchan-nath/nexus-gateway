/**
 * src/logger.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Zero-dependency structured logger for Nexus. Replaces the inline
 *   `logRequest()` placeholder that currently lives in src/server.js.
 *   Uses only `console` + `Date` — this is one of the STDLIB.md entries
 *   (Normally: winston/pino -> Instead: console + Date).
 *
 *   Owner: Saikat
 *   Status: DONE — this file is complete and ready to use.
 *
 * WHO NEEDS TO DO WHAT, AND WHEN
 *   - Ashish (server.js): server.js has ALREADY been updated (by Saikat,
 *     as agreed) to import createLogger() and use it in place of the old
 *     inline logRequest(). No action needed from Ashish unless the log
 *     format itself needs to change — ping Saikat first if so, don't
 *     silently re-add an inline logger in server.js.
 *   - Kanchan (router.js/loadbalancer.js/healthcheck.js/wal.js) and
 *     Ashish (ratelimiter.js/auth.js/tls.js): if you want logging inside
 *     your own module (e.g. "backend marked unhealthy", "rate limit hit
 *     for IP X"), import { createLogger } from './logger.js', call
 *     createLogger(config) once at module init, and use .info()/.debug()/
 *     .error(). Do NOT console.log() directly in new code — keeps output
 *     consistent and keeps the STDLIB.md story honest.
 *   - Biyas (dashboard.js): no dependency on logger.js, only on metrics.js.
 *
 * LOG LEVEL BEHAVIOR
 *   config.logging.level is one of: 'debug' | 'info' | 'error'
 *   (config.js defaults this to 'info' if not set in nexus.config.json).
 *   A message is printed only if its own level is >= the configured
 *   level, using the priority order debug < info < error. So:
 *     - level: 'debug' -> everything prints (debug, info, error)
 *     - level: 'info'  -> info + error print, debug is suppressed
 *     - level: 'error' -> only error prints (quiet mode for demo runs)
 * -----------------------------------------------------------------------
 */

const LEVEL_PRIORITY = Object.freeze({
    debug: 0,
    info: 1,
    error: 2,
});

const VALID_LEVELS = Object.keys(LEVEL_PRIORITY);

function isValidLevel(level) {
    return VALID_LEVELS.includes(level);
}

/**
 * Format a single log line consistently:
 *   [2026-08-17T10:00:00.000Z] INFO  message text here
 * Level column is padded so lines stay aligned in a terminal.
 */
function formatLine(level, message) {
    const timestamp = new Date().toISOString();
    const levelTag = level.toUpperCase().padEnd(5, ' ');
    return `[${timestamp}] ${levelTag} ${message}`;
}

/**
 * Pick the console method that matches the semantic level, so errors
 * go to stderr (console.error) and everything else goes to stdout.
 */
function writeLine(level, message) {
    const line = formatLine(level, message);
    if (level === 'error') {
        console.error(line);
    } else {
        console.log(line);
    }
}

/**
 * Create a logger bound to a specific config's logging.level.
 * Falls back to 'info' if config/config.logging/config.logging.level is
 * missing or invalid, so this is always safe to call even with a partial
 * or not-yet-validated config (e.g. before config.js's applyDefaults runs).
 */
export function createLogger(config) {
    const configuredLevel =
        config && config.logging && isValidLevel(config.logging.level)
            ? config.logging.level
            : 'info';

    function log(level, message) {
        if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel]) {
            writeLine(level, message);
        }
    }

    return {
        // Current effective level, exposed mainly for tests/debugging.
        level: configuredLevel,

        debug(message) {
            log('debug', message);
        },

        info(message) {
            log('info', message);
        },

        error(message) {
            log('error', message);
        },
        warn(message) {
            log('info', message);
        },

        /**
         * Request-line logger — the direct replacement for the old
         * inline logRequest(req, statusCode, startTime) in server.js.
         * Same signature and same call sites, so wiring it in is a
         * one-line change per call site.
         *
         * Log level auto-escalates to 'error' for 5xx responses so
         * server errors are visible even when level is 'info', and
         * stay visible even if someone later sets level to 'error'.
         */
        logRequest(req, statusCode, startTime) {
            const durationMs = Date.now() - startTime;
            const message = `${req.method} ${req.url} -> ${statusCode} ${durationMs}ms`;
            const level = statusCode >= 500 ? 'error' : 'info';
            log(level, message);
        },
    };
}

/**
 * Default, unconfigured logger (level: 'info') for quick use in scripts,
 * examples, or anywhere a full config object isn't available yet
 * (e.g. examples/backend-echo.js). Prefer createLogger(config) inside
 * the actual gateway pipeline so the configured log level is respected.
 */
export const logger = createLogger(null);
