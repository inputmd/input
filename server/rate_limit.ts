import type http from 'node:http';
import { UPSTREAM_PROXY_RATE_LIMIT_AUTHENTICATED_MAX, UPSTREAM_PROXY_RATE_LIMIT_MAX } from './config.ts';
import { json } from './http_helpers.ts';
import type { RateLimitEntry } from './types.ts';

const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_AUTHENTICATED_MAX = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;

// TODO: In-memory store — does not survive server restarts. Acceptable for a
// single-instance deployment: a restart briefly resets all rate limit windows,
// but they refill within one RATE_LIMIT_WINDOW_MS (60s). If the app ever scales
// to multiple instances, this should move to a shared store (e.g. Redis).
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

// Trusts the first address in X-Forwarded-For, which is set by the reverse
// proxy (Fly.io / Cloudflare). This is safe because Fly terminates external
// connections and overwrites the header before forwarding to the app. If the
// server were ever exposed directly to the internet without a trusted proxy,
// clients could spoof this header to bypass rate limits.
export function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

function setRateLimitHeaders(
  res: http.ServerResponse,
  max: number,
  remaining: number,
  resetAtMs: number,
  headerPrefix = 'X-Input-RateLimit',
): void {
  res.setHeader(`${headerPrefix}-Limit`, String(max));
  res.setHeader(`${headerPrefix}-Remaining`, String(Math.max(0, remaining)));
  res.setHeader(`${headerPrefix}-Reset`, String(Math.floor(resetAtMs / 1000)));
}

function checkLimit(key: string, max: number, res: http.ServerResponse, headerPrefix = 'X-Input-RateLimit'): boolean {
  const now = Date.now();
  let entry = rateLimitWindows.get(key);

  if (!entry || now >= entry.resetAtMs) {
    if (!entry && rateLimitWindows.size >= MAX_RATE_LIMIT_ENTRIES) {
      setRateLimitHeaders(res, max, 0, now + RATE_LIMIT_WINDOW_MS, headerPrefix);
      json(res, 429, { error: 'Too many requests' });
      return false;
    }
    entry = { count: 0, resetAtMs: now + RATE_LIMIT_WINDOW_MS };
    rateLimitWindows.set(key, entry);
  }

  entry.count++;
  if (entry.count > max) {
    const retryAfter = Math.ceil((entry.resetAtMs - now) / 1000);
    setRateLimitHeaders(res, max, 0, entry.resetAtMs, headerPrefix);
    res.setHeader('Retry-After', String(retryAfter));
    json(res, 429, { error: 'Too many requests' });
    return false;
  }

  setRateLimitHeaders(res, max, max - entry.count, entry.resetAtMs, headerPrefix);
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

export function checkUpstreamProxyRateLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: number | null,
): boolean {
  if (userId !== null) {
    return checkLimit(
      `proxy:user:${userId}`,
      UPSTREAM_PROXY_RATE_LIMIT_AUTHENTICATED_MAX,
      res,
      'X-Input-Upstream-Proxy-RateLimit',
    );
  }
  return checkLimit(
    `proxy:ip:${getClientIp(req)}`,
    UPSTREAM_PROXY_RATE_LIMIT_MAX,
    res,
    'X-Input-Upstream-Proxy-RateLimit',
  );
}
