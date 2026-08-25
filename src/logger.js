const LEVEL_PRIORITY = Object.freeze({
    debug: 0,
    info: 1,
    error: 2,
});

const VALID_LEVELS = Object.keys(LEVEL_PRIORITY);

function isValidLevel(level) {
    return VALID_LEVELS.includes(level);
}

function formatLine(level, message) {
    const timestamp = new Date().toISOString();
    const levelTag = level.toUpperCase().padEnd(5, ' ');
    return `[${timestamp}] ${levelTag} ${message}`;
}

function writeLine(level, message) {
    const line = formatLine(level, message);
    if (level === 'error') {
        console.error(line);
    } else {
        console.log(line);
    }
}

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

        logRequest(req, statusCode, startTime) {
            const durationMs = Date.now() - startTime;
            const message = `${req.method} ${req.url} -> ${statusCode} ${durationMs}ms`;
            const level = statusCode >= 500 ? 'error' : 'info';
            log(level, message);
        },
    };
}

export const logger = createLogger(null);