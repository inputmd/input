import type { Context, MiddlewareHandler } from 'hono';
import type { RateLimitEntry } from './types';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;
const CLEANUP_INTERVAL = 100;

const rateLimitWindows = new Map<string, RateLimitEntry>();
let checkCount = 0;

function getClientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return 'unknown';
}

function lazyCleanup(): void {
  checkCount++;
  if (checkCount % CLEANUP_INTERVAL !== 0) return;
  const now = Date.now();
  for (const [ip, entry] of rateLimitWindows) {
    if (now >= entry.resetAtMs) rateLimitWindows.delete(ip);
  }
}

function checkRateLimit(c: Context): Response | null {
  lazyCleanup();
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

  return null;
}

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const limited = checkRateLimit(c);
  if (limited) return limited;
  await next();
};
