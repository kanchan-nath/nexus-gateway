/**
 * src/wal.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Write-Ahead Log (WAL) for Nexus. Records every request before it's
 *   forwarded to a backend, providing durability and audit trail.
 *
 *   Owner: Kanchan
 *   Zero-dep substitution: `fs.createWriteStream` + `fs.appendFileSync`
 *   replace durability/queue libraries like Bull, better-queue, or
 *   winston-daily-rotate-file.
 *
 * WHAT THIS FILE DOES
 *   - Appends request entries to a log file (newline-delimited JSON)
 *   - Batches writes for performance (configurable batch size/interval)
 *   - Provides replay functionality to read back logged requests
 *   - Handles log rotation (size-based or manual)
 *   - Preserves request order for audit/replay
 *
 * HOW IT FITS IN THE SYSTEM
 *   server.js calls wal.append() before forwarding each request.
 *   The WAL can be replayed for recovery or audit purposes.
 *   Log entries include request metadata (method, url, headers, body, etc.)
 *
 * -----------------------------------------------------------------------
 * INTEGRATION CHECKLIST — what needs to change elsewhere
 * -----------------------------------------------------------------------
 *   1. server.js (Ashish):
 *        - Import and create WAL writer at startup:
 *            import { createWal } from './wal.js';
 *            const wal = createWal(config, logger);
 *        - In the request handler, BEFORE forwarding:
 *            await wal.append(req, route, backend);
 *        - The 'finish' event should include the response status in
 *          the WAL entry (update the entry after response completes)
 *
 *   2. config.js (Kanchan - already done):
 *        - Already has WAL config: enabled, path
 *        - Default: wal.enabled = true, wal.path = './wal.log'
 *
 *   3. cli.js (Kanchan):
 *        - Could add a `replay` command to replay the WAL
 *
 *   4. logger.js (Saikat - already done):
 *        - WAL uses logger for logging WAL operations
 *
 *   5. dashboard.js (Biyas - future):
 *        - Could display recent WAL entries
 * -----------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

/**
 * Create a Write-Ahead Log writer.
 *
 * @param {object} config - Full Nexus config (uses wal section)
 * @param {object} logger - Logger instance from logger.js
 * @param {object} [options] - Optional overrides
 * @param {boolean} [options.enabled] - Enable/disable WAL (overrides config)
 * @param {string} [options.path] - Log file path (overrides config)
 * @param {number} [options.batchSize=10] - Max entries to buffer before writing
 * @param {number} [options.flushIntervalMs=1000] - Max time to buffer before writing
 * @param {number} [options.maxFileSizeMB=10] - Rotate log file when it exceeds this size
 * @param {number} [options.maxFiles=5] - Keep this many rotated log files
 * @returns {object} WAL API
 */
export function createWal(config, logger, options = {}) {
    const walConfig = config.wal || {};

    // Use options if provided, otherwise fall back to config, then defaults
    const enabled = options.enabled !== undefined ? options.enabled : (walConfig.enabled !== undefined ? walConfig.enabled : true);
    const logPath = options.path || walConfig.path || './wal.log';
    const batchSize = options.batchSize || 10;
    const flushIntervalMs = options.flushIntervalMs || 1000;
    const maxFileSizeBytes = (options.maxFileSizeMB || 10) * 1024 * 1024;
    const maxFiles = options.maxFiles || 5;

    /** @type {string[]} Buffer of log entries (JSON strings) waiting to be written */
    let buffer = [];

    /** @type {fs.WriteStream|null} Write stream for the current log file */
    let writeStream = null;

    /** @type {NodeJS.Timeout|null} Flush timer */
    let flushTimer = null;

    /** @type {boolean} Is the WAL currently writing? */
    let isWriting = false;

    /** @type {Promise<void>|null} Current write promise */
    let writePromise = null;

    /** @type {number} Total entries written (for stats) */
    let totalEntriesWritten = 0;

    /** @type {number} Total bytes written (for stats) */
    let totalBytesWritten = 0;

    /** @type {number} Number of errors encountered */
    let errorCount = 0;

    /** @type {string} Current log file path (may change after rotation) */
    let currentLogPath = logPath;

    /**
     * Resolve the log file path (absolute).
     *
     * @param {string} filePath - Relative or absolute path
     * @returns {string} Absolute path
     */
    function resolvePath(filePath) {
        return path.resolve(process.cwd(), filePath);
    }

    /**
     * Ensure the directory for the log file exists.
     *
     * @param {string} filePath - Path to the log file
     */
    function ensureDirectoryExists(filePath) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Get the write stream for the current log file.
     * Creates a new stream if one doesn't exist.
     *
     * @returns {fs.WriteStream} The write stream
     */
    function getWriteStream() {
        if (writeStream) return writeStream;

        const resolvedPath = resolvePath(currentLogPath);
        ensureDirectoryExists(resolvedPath);

        // Open in append mode with auto-flush
        writeStream = fs.createWriteStream(resolvedPath, {
            flags: 'a',
            encoding: 'utf8',
            mode: 0o644,
        });

        writeStream.on('error', (err) => {
            logger.error(`WAL write stream error: ${err.message}`);
            errorCount++;
        });

        // Recreate stream if it closes unexpectedly
        writeStream.on('close', () => {
            if (enabled && !isWriting) {
                writeStream = null;
                logger.warn('WAL write stream closed, will recreate on next write');
            }
        });

        return writeStream;
    }

    /**
     * Check if the log file has exceeded the maximum size and rotate if needed.
     *
     * @returns {boolean} True if rotation occurred
     */
    function checkAndRotate() {
        if (maxFileSizeBytes <= 0) return false;

        const resolvedPath = resolvePath(currentLogPath);
        if (!fs.existsSync(resolvedPath)) return false;

        const stats = fs.statSync(resolvedPath);
        if (stats.size < maxFileSizeBytes) return false;

        // Rotate the log file
        try {
            // Close the current write stream
            if (writeStream) {
                writeStream.end();
                writeStream = null;
            }

            // Generate a timestamp for the rotated file
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rotatedPath = `${currentLogPath}.${timestamp}`;

            // Rename the current file
            fs.renameSync(resolvedPath, resolvePath(rotatedPath));
            logger.info(`WAL rotated: ${currentLogPath} -> ${rotatedPath}`);

            // Clean up old rotated files
            cleanupOldFiles();

            // Reset the write stream (will be recreated on next write)
            return true;
        } catch (err) {
            logger.error(`WAL rotation failed: ${err.message}`);
            return false;
        }
    }

    /**
     * Clean up old rotated log files.
     * Keeps only the most recent `maxFiles` files.
     */
    function cleanupOldFiles() {
        const dir = path.dirname(resolvePath(currentLogPath));
        const baseName = path.basename(currentLogPath);

        try {
            const files = fs.readdirSync(dir)
                .filter(f => f.startsWith(baseName) && f !== baseName)
                .map(f => ({
                    name: f,
                    path: path.join(dir, f),
                    mtime: fs.statSync(path.join(dir, f)).mtime.getTime()
                }))
                .sort((a, b) => b.mtime - a.mtime); // Newest first

            // Remove old files beyond maxFiles
            for (let i = maxFiles - 1; i < files.length; i++) {
                fs.unlinkSync(files[i].path);
                logger.debug(`Removed old WAL file: ${files[i].name}`);
            }
        } catch (err) {
            logger.error(`Failed to clean up old WAL files: ${err.message}`);
        }
    }

    /**
     * Flush the buffer to disk.
     *
     * @returns {Promise<void>}
     */
    async function flush() {
        if (isWriting) {
            // Wait for the current write to complete
            if (writePromise) {
                await writePromise;
            }
            return;
        }

        if (buffer.length === 0) return;

        isWriting = true;
        writePromise = (async () => {
            try {
                // Check if we need to rotate before writing
                if (maxFileSizeBytes > 0) {
                    checkAndRotate();
                }

                // Get the data to write
                const entries = buffer.slice();
                buffer = [];

                // Write to file
                const stream = getWriteStream();
                const data = entries.join('\n') + '\n';

                return new Promise((resolve, reject) => {
                    stream.write(data, (err) => {
                        if (err) {
                            errorCount++;
                            logger.error(`WAL write error: ${err.message}`);
                            reject(err);
                        } else {
                            totalEntriesWritten += entries.length;
                            totalBytesWritten += Buffer.byteLength(data, 'utf8');
                            resolve();
                        }
                    });
                });
            } catch (err) {
                errorCount++;
                logger.error(`WAL flush error: ${err.message}`);
                throw err;
            } finally {
                isWriting = false;
                writePromise = null;
            }
        })();

        await writePromise;
    }

    /**
     * Start the flush timer.
     */
    function startFlushTimer() {
        if (flushTimer) clearInterval(flushTimer);
        if (enabled && flushIntervalMs > 0) {
            flushTimer = setInterval(() => {
                if (buffer.length > 0) {
                    flush().catch((err) => {
                        logger.error(`WAL flush timer error: ${err.message}`);
                    });
                }
            }, flushIntervalMs);
        }
    }

    /**
     * Stop the flush timer.
     */
    function stopFlushTimer() {
        if (flushTimer) {
            clearInterval(flushTimer);
            flushTimer = null;
        }
    }

    /**
     * Format a request as a WAL entry.
     *
     * @param {import('node:http').IncomingMessage} req - The request object
     * @param {string} route - The matched route
     * @param {string} backend - The chosen backend URL
     * @param {number} timestamp - When the request was received
     * @param {object} [response] - Response details (optional, added later)
     * @returns {object} Formatted WAL entry
     */
    function formatEntry(req, route, backend, timestamp, response = null) {
        const entry = {
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            timestamp: new Date(timestamp).toISOString(),
            timestampMs: timestamp,
            request: {
                method: req.method,
                url: req.url,
                headers: { ...req.headers },
                // Remove sensitive headers to avoid logging secrets
                // These will be logged separately if needed
                // Note: We keep headers for debugging but redact sensitive ones
            },
            route,
            backend,
            // IP address from socket or X-Forwarded-For
            clientIp: req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown',
        };

        // Redact sensitive headers
        const sensitiveHeaders = ['authorization', 'x-api-key', 'cookie', 'set-cookie'];
        for (const header of sensitiveHeaders) {
            if (entry.request.headers[header]) {
                entry.request.headers[header] = '[REDACTED]';
            }
        }

        // Add response info if available
        if (response) {
            entry.response = {
                statusCode: response.statusCode,
                headers: { ...response.headers },
                // Redact sensitive response headers
            };
            for (const header of sensitiveHeaders) {
                if (entry.response.headers[header]) {
                    entry.response.headers[header] = '[REDACTED]';
                }
            }
        }

        return entry;
    }

    /**
     * Append a request to the WAL.
     *
     * @param {import('node:http').IncomingMessage} req - The request object
     * @param {string} route - The matched route
     * @param {string} backend - The chosen backend URL
     * @param {object} [response] - Response details (optional, added later)
     * @returns {Promise<string>} The entry ID
     */
    async function append(req, route, backend, response = null) {
        if (!enabled) {
            return null;
        }

        const timestamp = Date.now();
        const entry = formatEntry(req, route, backend, timestamp, response);
        const entryJson = JSON.stringify(entry);

        buffer.push(entryJson);

        // Flush if buffer reaches batch size
        if (buffer.length >= batchSize) {
            // Flush asynchronously (don't block the request)
            flush().catch((err) => {
                logger.error(`WAL append flush error: ${err.message}`);
            });
        }

        // Log at debug level
        logger.debug(`WAL entry appended: ${entry.id} (${req.method} ${req.url})`);

        return entry.id;
    }

    /**
     * Update a WAL entry with response information.
     * Note: This is not a true update (append-only log), but we can
     * append a second entry with the response status.
     *
     * @param {string} entryId - The entry ID to update
     * @param {import('node:http').IncomingMessage} req - The request object
     * @param {string} route - The matched route
     * @param {string} backend - The chosen backend URL
     * @param {object} response - Response details
     * @returns {Promise<string>} The updated entry ID
     */
    async function updateResponse(entryId, req, route, backend, response) {
        if (!enabled) {
            return null;
        }

        const timestamp = Date.now();
        const entry = formatEntry(req, route, backend, timestamp, response);
        entry.originalEntryId = entryId;
        entry.type = 'response';

        const entryJson = JSON.stringify(entry);
        buffer.push(entryJson);

        if (buffer.length >= batchSize) {
            flush().catch((err) => {
                logger.error(`WAL update flush error: ${err.message}`);
            });
        }

        return entry.id;
    }

    /**
     * Replay the WAL (read all entries).
     *
     * @param {object} [options] - Replay options
     * @param {string} [options.from] - Start reading from this timestamp (ISO string)
     * @param {string} [options.to] - Stop reading at this timestamp (ISO string)
     * @param {number} [options.limit] - Max number of entries to read
     * @param {boolean} [options.includeRotated] - Include rotated log files
     * @returns {Readable} Stream of WAL entries
     */
    function replay(options = {}) {
        const { from, to, limit = 0, includeRotated = false } = options;

        let files = [currentLogPath];

        if (includeRotated) {
            const dir = path.dirname(resolvePath(currentLogPath));
            const baseName = path.basename(currentLogPath);
            try {
                const allFiles = fs.readdirSync(dir)
                    .filter(f => f.startsWith(baseName))
                    .map(f => path.join(dir, f))
                    .sort();
                files = allFiles;
            } catch (err) {
                logger.error(`Failed to list WAL files: ${err.message}`);
            }
        }

        // Create a readable stream
        const stream = new Readable({
            objectMode: true,
            read() {
                // Push null to end the stream
                this.push(null);
            }
        });

        // Process files sequentially
        (async () => {
            let count = 0;
            const fromTimestamp = from ? new Date(from).getTime() : 0;
            const toTimestamp = to ? new Date(to).getTime() : Infinity;

            for (const filePath of files) {
                if (limit > 0 && count >= limit) break;

                try {
                    const resolvedPath = resolvePath(filePath);
                    if (!fs.existsSync(resolvedPath)) continue;

                    const content = fs.readFileSync(resolvedPath, 'utf8');
                    const lines = content.split('\n').filter(line => line.trim());

                    for (const line of lines) {
                        if (limit > 0 && count >= limit) break;

                        try {
                            const entry = JSON.parse(line);

                            // Filter by timestamp
                            if (entry.timestampMs) {
                                if (entry.timestampMs < fromTimestamp || entry.timestampMs > toTimestamp) {
                                    continue;
                                }
                            }

                            stream.push(entry);
                            count++;
                        } catch (parseErr) {
                            logger.error(`Failed to parse WAL entry: ${parseErr.message}`);
                        }
                    }
                } catch (err) {
                    logger.error(`Failed to read WAL file ${filePath}: ${err.message}`);
                }
            }

            stream.push(null);
        })().catch((err) => {
            logger.error(`WAL replay error: ${err.message}`);
            stream.destroy(err);
        });

        return stream;
    }

    /**
     * Get WAL statistics.
     *
     * @returns {object} Statistics about the WAL
     */
    function getStats() {
        const resolvedPath = resolvePath(currentLogPath);
        let fileSize = 0;
        let entryCount = 0;

        try {
            if (fs.existsSync(resolvedPath)) {
                const stats = fs.statSync(resolvedPath);
                fileSize = stats.size;
            }
        } catch (err) {
            logger.error(`Failed to get WAL stats: ${err.message}`);
        }

        // Count entries in current file
        try {
            if (fs.existsSync(resolvedPath)) {
                const content = fs.readFileSync(resolvedPath, 'utf8');
                entryCount = content.split('\n').filter(line => line.trim()).length;
            }
        } catch (err) {
            logger.error(`Failed to count WAL entries: ${err.message}`);
        }

        return {
            enabled,
            path: currentLogPath,
            fileSizeBytes: fileSize,
            entryCount,
            bufferSize: buffer.length,
            totalEntriesWritten,
            totalBytesWritten,
            errorCount,
            isRunning: enabled && !!writeStream,
        };
    }

    /**
     * Start the WAL writer.
     */
    function start() {
        if (!enabled) {
            logger.info('WAL is disabled');
            return;
        }

        stopFlushTimer();
        startFlushTimer();

        // Ensure the log directory exists
        ensureDirectoryExists(resolvePath(currentLogPath));

        logger.info(`WAL started: ${currentLogPath} (batch: ${batchSize}, flush: ${flushIntervalMs}ms)`);
        logger.info(`WAL max file size: ${maxFileSizeBytes / 1024 / 1024}MB, keeping ${maxFiles} files`);
    }

    /**
     * Stop the WAL writer and flush remaining entries.
     *
     * @returns {Promise<void>}
     */
    async function stop() {
        stopFlushTimer();

        // Flush any remaining entries
        if (buffer.length > 0) {
            try {
                await flush();
            } catch (err) {
                logger.error(`WAL flush on stop failed: ${err.message}`);
            }
        }

        // Close the write stream
        if (writeStream) {
            await new Promise((resolve) => {
                writeStream.end(resolve);
                writeStream = null;
            });
        }

        logger.info(`WAL stopped. Total entries: ${totalEntriesWritten}, errors: ${errorCount}`);
    }

    /**
     * Rotate the log file manually.
     *
     * @returns {Promise<boolean>} True if rotation succeeded
     */
    async function rotate() {
        if (isWriting) {
            // Wait for current write to complete
            if (writePromise) {
                await writePromise;
            }
        }

        return checkAndRotate();
    }

    /**
     * Clear the WAL (delete the log file).
     *
     * @param {boolean} [confirm=false] - Must be true to clear
     * @returns {Promise<boolean>} True if clearing succeeded
     */
    async function clear(confirm = false) {
        if (!confirm) {
            logger.warn('WAL clear called without confirmation');
            return false;
        }

        if (isWriting) {
            if (writePromise) {
                await writePromise;
            }
        }

        try {
            const resolvedPath = resolvePath(currentLogPath);
            if (fs.existsSync(resolvedPath)) {
                fs.unlinkSync(resolvedPath);
                logger.info(`WAL cleared: ${currentLogPath}`);
                return true;
            }
            return false;
        } catch (err) {
            logger.error(`Failed to clear WAL: ${err.message}`);
            return false;
        }
    }

    // Start the WAL if enabled
    if (enabled) {
        start();
    }

    return {
        // Core operations
        append,
        updateResponse,
        replay,

        // Lifecycle
        start,
        stop,
        flush,
        rotate,
        clear,

        // Status and stats
        getStats,
        getStats: getStats, // Alias for backward compatibility

        // Properties
        get enabled() { return enabled; },
        get path() { return currentLogPath; },
        get bufferSize() { return buffer.length; },
        get totalEntries() { return totalEntriesWritten; },
        get errorCount() { return errorCount; },
    };
}