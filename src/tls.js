/**
 * src/tls.js
 * -----------------------------------------------------------------------
 * PURPOSE
 *   TLS termination for Nexus. Loads (or, if missing, generates) a
 *   self-signed certificate and starts an `https.createServer` that
 *   shares the SAME request pipeline (routing, load balancing, rate
 *   limiting, auth, WAL, metrics) as the plain HTTP listener in
 *   server.js — TLS is purely a transport-layer wrapper here, not a
 *   second copy of the gateway logic.
 *
 *   Owner: Ashish
 *   Zero-dep substitution: `node:tls` / `node:https` replace TLS
 *   middleware libraries.
 *
 * DESIGN DECISION — why this shells out to `openssl` for cert generation
 *   Node's built-in `crypto` module can do the underlying RSA key-pair
 *   math (`generateKeyPairSync`), but it does NOT include an X.509
 *   certificate encoder — building a valid DER/ASN.1 self-signed
 *   certificate by hand in pure JS is a genuinely hard, error-prone
 *   problem (it's exactly why packages like `selfsigned` or `mkcert`
 *   exist). The build plan explicitly calls this out and sanctions the
 *   pragmatic path: generate the cert ONCE via a system `openssl`
 *   command (a system tool, not an npm dependency — doesn't touch
 *   package.json, doesn't affect the "empty dependencies" proof), and
 *   have Nexus itself only ever LOAD and SERVE that cert at runtime
 *   using `node:tls`/`node:https`/`node:fs`. That's what this file does.
 *
 *   If `openssl` isn't installed on the machine, we fail with a clear
 *   error containing the exact command to run manually — we do not
 *   attempt a hand-rolled ASN.1 fallback, since a broken/invalid
 *   certificate is worse than a clear setup instruction.
 *
 * WHAT THIS FILE DOES
 *   - ensureCertExists(config, logger)  -> generates cert+key via openssl
 *     if the files configured at config.tls.cert/config.tls.key don't
 *     already exist on disk. Safe to call multiple times (no-op if the
 *     files are already there).
 *   - loadTlsOptions(config)            -> reads cert+key into memory
 *   - createTLSServer(config, logger, sharedContext?) -> returns an
 *     https.Server, matching the call shape cli.js already expects.
 *
 *   To share the exact same routing/rate-limit/auth/WAL/metrics pipeline
 *   as the HTTP listener (recommended whenever both are running in the
 *   same process), this imports `createRequestContext` from server.js —
 *   NOT circular: server.js never imports anything from this file.
 *
 * -----------------------------------------------------------------------
 * FUTURE INTEGRATION — what still needs to change elsewhere
 * -----------------------------------------------------------------------
 *   1. cli.js (owner: Kanchan) — THIS IS THE IMPORTANT ONE:
 *        cli.js currently has a commented-out block that (if uncommented
 *        exactly as written today) would call:
 *            createTLSServer(config, servers[0]?.logger)
 *        That still WORKS (2-arg calls are supported — see
 *        `sharedContext` default below) but it means the HTTPS listener
 *        builds its OWN independent healthChecker/wal/rateLimiter —
 *        i.e. TWO health-check pollers hitting your backends, and two
 *        WAL writers potentially racing on the same wal.log file, since
 *        nexus.config.json configures both 8080 AND 8443.
 *
 *        The better fix (small, contained to cli.js): after creating the
 *        HTTP server, pass the WHOLE server object as the third
 *        argument — it already carries `.logger`, `.metrics`,
 *        `.loadBalancer`, `.healthChecker`, `.wal`, `.rateLimiter`,
 *        `.requestHandler` as properties (see server.js's
 *        createServer()), which is exactly the shape this file's
 *        `sharedContext` parameter expects:
 *
 *            if (config.listen.https != null) {
 *              const { createTLSServer } = await import('./tls.js');
 *              const httpServer = servers[0]; // already created above
 *              const httpsServer = createTLSServer(config, httpServer?.logger, httpServer);
 *              httpsServer.listen(config.listen.https, () => {
 *                httpsServer.logger.info(`Nexus listening on https://localhost:${config.listen.https}`);
 *              });
 *              servers.push(httpsServer); // so graceful shutdown covers it too
 *            }
 *
 *        If only HTTPS is configured (no HTTP port at all), calling
 *        createTLSServer(config, logger) with no third argument is
 *        fine — this file builds its own full context in that case,
 *        since there's nothing else to share it with.
 *
 *   2. build.sh (Ashish's other Phase 4 file):
 *        For a clean `git clone` + `./build.sh` to work with zero manual
 *        steps, build.sh should either (a) call `ensureCertExists()`
 *        ahead of time (e.g. via a tiny `node -e` one-liner importing
 *        this file), or (b) simply let cli.js's normal startup path
 *        trigger it lazily on first run — either is fine, just make sure
 *        the openssl-not-found error path is documented in README.md so
 *        judges running the demo aren't stuck.
 *
 *   3. README.md (owner: Biyas + Saikat):
 *        Document that self-signed cert generation requires `openssl` on
 *        PATH (a system tool). Worth a one-line callout in the
 *        "dependency proof" section: this is NOT an npm dependency and
 *        does not appear in package.json.
 *
 *   4. STDLIB.md (owner: Saikat):
 *        Add an entry along the lines of: "Normally: selfsigned / mkcert
 *        (npm) -> Instead: one-time system `openssl` call (dev/boot-time
 *        only) + node:tls/node:https to load and serve the cert at
 *        runtime."
 *
 *   5. .gitignore (whoever owns repo hygiene):
 *        Make sure the generated cert/key directory (default
 *        `./certs/`) is gitignored — self-signed or not, private keys
 *        shouldn't be committed.
 * -----------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createRequestContext } from './server.js';

const CERT_VALID_DAYS = 365;
const CERT_SUBJECT = '/CN=localhost';

// -------------------------------------------------------------------------
// Check whether the `openssl` binary is available on PATH before we try
// to shell out to it — lets us fail with a clean, actionable error
// instead of a raw ENOENT stack trace.
// -------------------------------------------------------------------------
function isOpensslAvailable() {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Generate a self-signed RSA-2048 certificate + private key via a
 * one-time `openssl req` call. This is the "dev-time system tool" step
 * called out in the header comment — it runs once (only when the cert
 * files don't already exist), and Nexus never invokes openssl again
 * after that; every later boot just loads the files from disk.
 *
 * @param {string} certPath
 * @param {string} keyPath
 * @param {object} [logger] - optional, falls back to console
 */
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

    // Make sure the parent directory (e.g. ./certs/) exists before openssl
    // tries to write into it.
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });

    const log = (logger.info || logger.log || console.log).bind(logger.info ? logger : console);
    log(`tls: generating self-signed certificate (valid ${CERT_VALID_DAYS} days)...`);

    execFileSync('openssl', [
        'req', '-x509',
        '-newkey', 'rsa:2048',
        '-nodes', // no passphrase — Nexus needs to read the key unattended at boot
        '-keyout', keyPath,
        '-out', certPath,
        '-days', String(CERT_VALID_DAYS),
        '-subj', CERT_SUBJECT,
    ], { stdio: 'pipe' });

    log(`tls: certificate written to ${certPath}, key written to ${keyPath}`);
}

/**
 * Make sure config.tls.cert / config.tls.key exist on disk, generating
 * a self-signed pair via openssl if they don't. Safe to call on every
 * boot — it's a no-op once the files are present, exactly like the plan
 * document's "self-signed cert gen at boot" requirement.
 *
 * @param {object} config - full Nexus config (uses config.tls.cert/.key)
 * @param {object} [logger]
 */
export function ensureCertExists(config, logger = console) {
    const certPath = path.resolve(config.tls.cert);
    const keyPath = path.resolve(config.tls.key);

    const certExists = fs.existsSync(certPath);
    const keyExists = fs.existsSync(keyPath);

    if (certExists && keyExists) {
        return; // already there — nothing to do
    }

    if (certExists !== keyExists) {
        // One exists but not the other — almost certainly a half-finished
        // manual setup. Refuse to silently overwrite; fail loudly instead.
        throw new Error(
            `tls.js: found ${certExists ? certPath : keyPath} but not ` +
            `${certExists ? keyPath : certPath}. Remove the leftover file or ` +
            `provide both, then restart Nexus.`
        );
    }

    generateSelfSignedCert(certPath, keyPath, logger);
}

/**
 * Read the certificate + key files into memory, ready to pass as
 * `https.createServer(tlsOptions, ...)`'s first argument.
 *
 * @param {object} config
 * @returns {{ cert: Buffer, key: Buffer }}
 */
export function loadTlsOptions(config) {
    const certPath = path.resolve(config.tls.cert);
    const keyPath = path.resolve(config.tls.key);

    return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
    };
}

/**
 * Create (but do not start) the Nexus HTTPS server.
 *
 * @param {object} config
 * @param {object} [logger] - used for the cert-generation log line, and
 *   as the fallback logger if no sharedContext is given (in which case
 *   a fresh context is built and THIS logger is discarded in favor of
 *   the one createRequestContext() constructs — see note below).
 * @param {object} [sharedContext] - a context object as returned by
 *   server.js's createServer()/createRequestContext() — i.e. an object
 *   with `.requestHandler`, `.logger`, `.metrics`, `.loadBalancer`,
 *   `.healthChecker`, `.wal`, `.rateLimiter`. STRONGLY preferred when
 *   both HTTP and HTTPS are running in the same process (see FUTURE
 *   INTEGRATION note #1 above) so backends only get health-checked once
 *   and the WAL only has one writer. If omitted, this function builds
 *   its own full context via createRequestContext(config) — correct for
 *   HTTPS-only setups; if an HTTP server is ALSO running in the same
 *   process without sharing context, you'll get duplicate background
 *   workers (still functionally correct, just wasteful — fix per note #1).
 * @returns {https.Server}
 */
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

    // Mirror the same properties server.js's createServer() attaches, so
    // code written against one works against the other (cli.js does
    // `server.logger.info(...)` after either kind of server starts).
    server.logger = ctx.logger;
    server.metrics = ctx.metrics;
    server.loadBalancer = ctx.loadBalancer;
    server.healthChecker = ctx.healthChecker;
    server.wal = ctx.wal;
    server.rateLimiter = ctx.rateLimiter;
    server.requestHandler = ctx.requestHandler;

    return server;
}