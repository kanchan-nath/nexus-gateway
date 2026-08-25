import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const PACKAGE_NAME = 'nexus-gateway';
const PACKAGE_VERSION = '1.0.0';

function parseArgs(argv) {
    const args = argv.slice(2);
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
                i++;
            }
            continue;
        }

        if (result.command === null && !arg.startsWith('-')) {
            result.command = arg;
        }
    }

    return result;
}

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

    if (remaining === 0) {
        process.exit(exitCode);
    }

    setTimeout(() => {
        console.error('Force exit after timeout');
        process.exit(exitCode);
    }, 5000);
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) {
        printHelp();
        process.exit(0);
    }

    if (args.version) {
        console.log(PACKAGE_VERSION);
        process.exit(0);
    }

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

    const configPath = path.resolve(process.cwd(), args.configPath);

    let config;

    try {
        config = loadConfig(configPath);
    } catch (err) {
        console.error(`Error loading config: ${err.message}`);
        process.exit(1);
    }

    const servers = [];

    if (config.listen.http != null) {
        try {
            const server = createServer(config);
            const port = config.listen.http;

            server.listen(port, () => {
                server.logger.info(`Nexus listening on http://localhost:${port}`);
            });

            servers.push(server);

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

    if (config.listen.https != null) {
        try {
            const { createTLSServer } = await import('./tls.js');
            const httpServer = servers[0];
            const httpsServer = createTLSServer(config, httpServer?.logger, httpServer);

            httpsServer.listen(config.listen.https, () => {
                httpsServer.logger.info(`Nexus listening on https://localhost:${config.listen.https}`);
            });

            servers.push(httpsServer);

            if (servers.length === 1) {
                const logger = httpsServer.logger;
                process.on('SIGINT', () => shutdown(servers, logger, 0));
                process.on('SIGTERM', () => shutdown(servers, logger, 0));
            }
        } catch (err) {
            console.error(`Failed to start HTTPS server: ${err.message}`);
            process.exit(1);
        }
    }

    if (servers.length === 0) {
        console.error('No servers configured to listen (need http or https)');
        process.exit(1);
    }

    console.log(`Nexus v${PACKAGE_VERSION} running. Press Ctrl+C to stop.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});