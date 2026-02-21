import crypto from 'node:crypto';
import type http from 'node:http';
import { SESSION_SECRET, SESSION_TTL_SECONDS } from './config';
import type { Session } from './types';

export function createSessionToken(installationId: string): string {
  const payload = JSON.stringify({
    sub: String(installationId),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function validateSessionToken(token: string): Session | null {
  const dot = token.indexOf('.');
  if (dot === -1) return null;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');

  if (sigBuf.length !== Buffer.byteLength(expectedBuf)) return null;
  if (!crypto.timingSafeEqual(sigBuf, Buffer.from(expectedBuf))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };

    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return { installationId: payload.sub };
  } catch {
    return null;
  }
}

export function requireSession(req: http.IncomingMessage): Session | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return validateSessionToken(auth.slice(7));
}
