import crypto from 'node:crypto';

const HMAC_ALGORITHM = 'sha256';

function safeStringCompare(a, b) {
    const bufA = crypto.createHash(HMAC_ALGORITHM).update(String(a)).digest();
    const bufB = crypto.createHash(HMAC_ALGORITHM).update(String(b)).digest();
    return crypto.timingSafeEqual(bufA, bufB);
}

export function checkApiKey(req, config) {
    const providedKey = req.headers['x-api-key'];
    if (!providedKey || typeof providedKey !== 'string') return false;

    const validKeys = config.auth.apiKeys || [];
    return validKeys.some((validKey) => safeStringCompare(providedKey, validKey));
}

export function createToken(payload, config, expiresInSeconds = 3600) {
    const secret = config.auth?.hmac?.secret;
    if (!secret) {
        throw new Error('createToken: config.auth.hmac.secret is not set (see NEXUS_HMAC_SECRET)');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const fullPayload = {
        ...payload,
        iat: nowSeconds,
        exp: nowSeconds + expiresInSeconds,
    };

    const payloadB64 = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
    const signature = crypto.createHmac(HMAC_ALGORITHM, secret).update(payloadB64).digest();
    const signatureB64 = signature.toString('base64url');

    return `${payloadB64}.${signatureB64}`;
}

export function verifyToken(token, config) {
    const secret = config.auth?.hmac?.secret;
    if (!secret || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, signatureB64] = parts;

    const expectedSignature = crypto.createHmac(HMAC_ALGORITHM, secret).update(payloadB64).digest();
    let providedSignature;

    try {
        providedSignature = Buffer.from(signatureB64, 'base64url');
    } catch {
        return null;
    }

    if (providedSignature.length !== expectedSignature.length) return null;
    if (!crypto.timingSafeEqual(providedSignature, expectedSignature)) return null;

    let payload;

    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && nowSeconds > payload.exp) {
        return null;
    }

    return payload;
}

export function authenticate(req, config) {
    if (!config.auth?.required) {
        return { authenticated: true, method: 'none' };
    }

    if (checkApiKey(req, config)) {
        return { authenticated: true, method: 'apiKey' };
    }

    if (config.auth.hmac?.enabled) {
        const authHeader = req.headers['authorization'];

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.slice('Bearer '.length);
            const payload = verifyToken(token, config);

            if (payload) {
                return { authenticated: true, method: 'hmac', payload };
            }
        }
    }

    return {
        authenticated: false,
        method: null,
        reason: 'missing or invalid credentials (expected X-API-Key or Authorization: Bearer <token>)',
    };
}