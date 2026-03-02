import { getConnInfo } from '@hono/node-server/conninfo';
import { createMiddleware } from 'hono/factory';
import type { RateLimitEntry } from './types';

const RATE_LIMIT_MAX = 30;
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

function getClientIp(c: Parameters<Parameters<typeof createMiddleware>[0]>[0]): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  const info = getConnInfo(c);
  return info.remote.address || 'unknown';
}

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  const ip = getClientIp(c);
  const now = Date.now();
  let entry = rateLimitWindows.get(ip);

  if (!entry || now >= entry.resetAtMs) {
    if (!entry && rateLimitWindows.size >= MAX_RATE_LIMIT_ENTRIES) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    entry = { count: 0, resetAtMs: now + RATE_LIMIT_WINDOW_MS };
    rateLimitWindows.set(ip, entry);
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetAtMs - now) / 1000);
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'Too many requests' }, 429);
  }

  await next();
});
