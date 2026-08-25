import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createRequestContext } from './server.js';

const CERT_VALID_DAYS = 365;
const CERT_SUBJECT = '/CN=localhost';

function isOpensslAvailable() {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function generateSelfSignedCert(certPath, keyPath, logger = console) {
    if (!isOpensslAvailable()) {
        const manualCommand =
            `openssl req -x509 -newkey rsa:2048 -nodes ` +
            `-keyout "${keyPath}" -out "${certPath}" ` +
            `-days ${CERT_VALID_DAYS} -subj "${CERT_SUBJECT}"`;

        throw new Error(
            `tls.js: "openssl" was not found on PATH, so a self-signed certificate ` +
            `could not be generated automatically.\n` +
            `Install openssl, or run this command manually once, then restart Nexus:\n\n` +
            `  ${manualCommand}\n`
        );
    }

    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });

    const log = (logger.info || logger.log || console.log).bind(logger.info ? logger : console);
    log(`tls: generating self-signed certificate (valid ${CERT_VALID_DAYS} days)...`);

    execFileSync('openssl', [
        'req', '-x509',
        '-newkey', 'rsa:2048',
        '-nodes',
        '-keyout', keyPath,
        '-out', certPath,
        '-days', String(CERT_VALID_DAYS),
        '-subj', CERT_SUBJECT,
    ], { stdio: 'pipe' });

    log(`tls: certificate written to ${certPath}, key written to ${keyPath}`);
}

export function ensureCertExists(config, logger = console) {
    const certPath = path.resolve(config.tls.cert);
    const keyPath = path.resolve(config.tls.key);

    const certExists = fs.existsSync(certPath);
    const keyExists = fs.existsSync(keyPath);

    if (certExists && keyExists) {
        return;
    }

    if (certExists !== keyExists) {
        throw new Error(
            `tls.js: found ${certExists ? certPath : keyPath} but not ` +
            `${certExists ? keyPath : certPath}. Remove the leftover file or ` +
            `provide both, then restart Nexus.`
        );
    }

    generateSelfSignedCert(certPath, keyPath, logger);
}

export function loadTlsOptions(config) {
    const certPath = path.resolve(config.tls.cert);
    const keyPath = path.resolve(config.tls.key);

    return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
    };
}

export function createTLSServer(config, logger = console, sharedContext = null) {
    ensureCertExists(config, logger);
    const tlsOptions = loadTlsOptions(config);

    let ctx = sharedContext;
    if (!ctx) {
        logger.warn?.(
            'tls: no shared context provided — building an independent request ' +
            'pipeline for HTTPS. If an HTTP listener is also running in this ' +
            'process, see the FUTURE INTEGRATION note in tls.js to share one ' +
            'context instead (avoids duplicate health-checker/WAL instances).'
        );
        ctx = createRequestContext(config);
    }

    const server = https.createServer(tlsOptions, ctx.requestHandler);

    server.logger = ctx.logger;
    server.metrics = ctx.metrics;
    server.loadBalancer = ctx.loadBalancer;
    server.healthChecker = ctx.healthChecker;
    server.wal = ctx.wal;
    server.rateLimiter = ctx.rateLimiter;
    server.requestHandler = ctx.requestHandler;

    return server;
}