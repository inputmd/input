import type http from 'node:http';
import { json } from './http_helpers';
import type { RateLimitEntry } from './types';

const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_AUTHENTICATED_MAX = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;

const rateLimitWindows = new Map<string, RateLimitEntry>();

export function startRateLimitCleanup(): void {
  setInterval(
    () => {
      const now = Date.now();
      for (const [ip, entry] of rateLimitWindows) {
        if (now >= entry.resetAtMs) rateLimitWindows.delete(ip);
      }
    },
    2 * 60 * 1000,
  ).unref();
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkLimit(key: string, max: number, res: http.ServerResponse): boolean {
  const now = Date.now();
  let entry = rateLimitWindows.get(key);

  if (!entry || now >= entry.resetAtMs) {
    if (!entry && rateLimitWindows.size >= MAX_RATE_LIMIT_ENTRIES) {
      json(res, 429, { error: 'Too many requests' });
      return false;
    }
    entry = { count: 0, resetAtMs: now + RATE_LIMIT_WINDOW_MS };
    rateLimitWindows.set(key, entry);
  }

  entry.count++;
  if (entry.count > max) {
    const retryAfter = Math.ceil((entry.resetAtMs - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    json(res, 429, { error: 'Too many requests' });
    return false;
  }

  return true;
}

export function checkRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  return checkLimit(`ip:${getClientIp(req)}`, RATE_LIMIT_MAX, res);
}

export function checkRateLimitAuthenticated(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: number,
): boolean {
  return checkLimit(`user:${userId}`, RATE_LIMIT_AUTHENTICATED_MAX, res);
}
