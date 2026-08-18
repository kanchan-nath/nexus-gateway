/**
 * src/cli.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   Command-line interface for Nexus. Provides a single entrypoint:
 *     node src/cli.js start --config <path>
 *
 *   It parses process.argv manually (no yargs/commander), loads the
 *   configuration, starts the HTTP/HTTPS server(s), and keeps the
 *   process alive. This is the main entrypoint for running Nexus in
 *   production/demo mode.
 *
 *   Owner: Kanchan
 *   Zero-dep substitution: `process.argv` manual parsing replaces
 *   yargs/commander. `node:http` + `node:https` + `node:tls` replace
 *   express/HTTPS libraries.
 *
 * WHAT THIS FILE DOES
 *   - Parses CLI flags: --config, --help, --version
 *   - Loads config via loadConfig() from config.js
 *   - Creates HTTP server (and HTTPS server if configured)
 *   - Starts both servers on their respective ports
 *   - Handles graceful shutdown (SIGINT, SIGTERM)
 *   - Exits with appropriate code on error
 *
 * -----------------------------------------------------------------------
 * FUTURE INTEGRATION — what still needs to change elsewhere
 * -----------------------------------------------------------------------
 *   This file is the top-level entrypoint. It expects:
 *     1. config.js -> loadConfig() to be fully implemented (done)
 *     2. server.js -> createServer() to accept config and return
 *        an http.Server instance (done)
 *     3. tls.js -> createTLSServer() to be implemented (Phase 3)
 *        - Currently TLS is stubbed; once tls.js lands, uncomment
 *          the HTTPS server creation block below.
 *
 *   No other files need to change for this file to work.
 * -----------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

// -------------------------------------------------------------------------
// Package metadata (kept inline so we don't need to import package.json)
// -------------------------------------------------------------------------
const PACKAGE_NAME = 'nexus-gateway';
const PACKAGE_VERSION = '1.0.0';

// -------------------------------------------------------------------------
// CLI argument parsing (manual, zero-dependency)
// -------------------------------------------------------------------------

/**
 * Parse command-line arguments. Returns an object with:
 *   - command: string (e.g. 'start')
 *   - configPath: string | null
 *   - help: boolean
 *   - version: boolean
 */
function parseArgs(argv) {
    const args = argv.slice(2); // remove node and script path
    const result = {
        command: null,
        configPath: null,
        help: false,
        version: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--help' || arg === '-h') {
            result.help = true;
            continue;
        }

        if (arg === '--version' || arg === '-v') {
            result.version = true;
            continue;
        }

        if (arg === '--config' || arg === '-c') {
            if (i + 1 < args.length) {
                result.configPath = args[i + 1];
                i++; // skip the value
            }
            continue;
        }

        // If it's not a flag, treat it as the command
        if (result.command === null && !arg.startsWith('-')) {
            result.command = arg;
        }
    }

    return result;
}

// -------------------------------------------------------------------------
// Help text
// -------------------------------------------------------------------------

function printHelp() {
    console.log(`
${PACKAGE_NAME} v${PACKAGE_VERSION}

A zero-dependency reverse proxy / API gateway built on Node.js stdlib.

Usage:
  node src/cli.js start --config <path>

Options:
  --config, -c <path>   Path to nexus.config.json (required)
  --help, -h            Show this help message
  --version, -v         Show version number

Examples:
  node src/cli.js start --config ./nexus.config.json
  node src/cli.js start -c ./my-config.json

Environment variables:
  NEXUS_API_KEYS        Comma-separated list, overrides auth.apiKeys
  NEXUS_HMAC_SECRET     Overrides auth.hmac.secret
`);
}

// -------------------------------------------------------------------------
// Graceful shutdown
// -------------------------------------------------------------------------

function shutdown(servers, logger, exitCode = 0) {
    if (logger) {
        logger.info('Shutting down gracefully...');
    } else {
        console.log('Shutting down gracefully...');
    }

    let remaining = 0;
    for (const server of servers) {
        if (server && server.listening) {
            remaining++;
            server.close(() => {
                remaining--;
                if (remaining === 0) {
                    process.exit(exitCode);
                }
            });
        }
    }

    // If no servers were listening, exit immediately
    if (remaining === 0) {
        process.exit(exitCode);
    }

    // Safety net: force exit after 5 seconds if something hangs
    setTimeout(() => {
        console.error('Force exit after timeout');
        process.exit(exitCode);
    }, 5000);
}

// -------------------------------------------------------------------------
// Main entrypoint
// -------------------------------------------------------------------------

function main() {
    const args = parseArgs(process.argv);

    // Handle --help / --version first (no config needed)
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    if (args.version) {
        console.log(PACKAGE_VERSION);
        process.exit(0);
    }

    // Validate: must have a command and a config path
    if (args.command !== 'start') {
        console.error(`Error: Unknown command "${args.command}"`);
        console.error('Run "node src/cli.js --help" for usage.');
        process.exit(1);
    }

    if (!args.configPath) {
        console.error('Error: --config <path> is required');
        console.error('Run "node src/cli.js --help" for usage.');
        process.exit(1);
    }

    // Resolve config path relative to current working directory
    const configPath = path.resolve(process.cwd(), args.configPath);

    let config;
    try {
        config = loadConfig(configPath);
    } catch (err) {
        console.error(`Error loading config: ${err.message}`);
        process.exit(1);
    }

    // At this point we have a valid config. Start the server(s).
    const servers = [];

    // Create the main HTTP server (always required, even if only
    // HTTPS is configured? No — if only https is set, we don't start
    // an HTTP listener. But config validation requires at least one.
    if (config.listen.http != null) {
        try {
            const server = createServer(config);
            const port = config.listen.http;
            server.listen(port, () => {
                server.logger.info(`Nexus listening on http://localhost:${port}`);
            });
            servers.push(server);

            // Attach signal handlers after first server starts
            if (servers.length === 1) {
                const logger = server.logger;
                process.on('SIGINT', () => shutdown(servers, logger, 0));
                process.on('SIGTERM', () => shutdown(servers, logger, 0));
            }
        } catch (err) {
            console.error(`Failed to start HTTP server: ${err.message}`);
            process.exit(1);
        }
    }

    // TODO (Phase 3): HTTPS server via tls.js
    // Once tls.js is implemented, uncomment this block:
    //
    // if (config.listen.https != null) {
    //   import('./tls.js').then(({ createTLSServer }) => {
    //     const server = createTLSServer(config, servers[0]?.logger);
    //     server.listen(config.listen.https, () => {
    //       server.logger.info(`Nexus listening on https://localhost:${config.listen.https}`);
    //     });
    //     servers.push(server);
    //   });
    // }

    // If no servers were started (shouldn't happen due to config validation)
    if (servers.length === 0) {
        console.error('No servers configured to listen (need http or https)');
        process.exit(1);
    }

    // Keep process alive (servers do this automatically)
    console.log(`Nexus v${PACKAGE_VERSION} running. Press Ctrl+C to stop.`);
}

// -------------------------------------------------------------------------
// Run the CLI
// -------------------------------------------------------------------------

main();