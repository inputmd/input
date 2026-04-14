import type http from 'node:http';
import { Transform } from 'node:stream';
import { UPSTREAM_PROXY_SESSION_HEADER, UPSTREAM_PROXY_USER_AGENT_HEADER } from '../shared/upstream_proxy.ts';
import {
  UPSTREAM_PROXY_MAX_CONCURRENT_ANON,
  UPSTREAM_PROXY_MAX_CONCURRENT_AUTH,
  UPSTREAM_PROXY_MAX_CONCURRENT_WEBCONTAINER_ANON,
  UPSTREAM_PROXY_MAX_COOKIE_BYTES_PER_SESSION,
  UPSTREAM_PROXY_MAX_COOKIE_VALUE_BYTES,
  UPSTREAM_PROXY_MAX_COOKIES_PER_HOST,
  UPSTREAM_PROXY_MAX_HOSTS_PER_SESSION,
  UPSTREAM_PROXY_MAX_SESSIONS,
  UPSTREAM_PROXY_SESSION_ID_MAX_LENGTH,
} from './config.ts';
import { ClientError } from './errors.ts';
import { getClientIp } from './rate_limit.ts';

// Hosts used by Pi's built-in provider registry and OAuth flows that need to be
// routed through the local upstream proxy from inside WebContainers.
export const UPSTREAM_PROXY_ALLOWED_HOSTS = new Set([
  'accounts.google.com',
  'ai-gateway.vercel.sh',
  'api.anthropic.com',
  'api.cerebras.ai',
  'api.github.com',
  'api.groq.com',
  'api.individual.githubcopilot.com',
  'api.kimi.com',
  'api.minimax.io',
  'api.minimaxi.com',
  'api.mistral.ai',
  'api.openai.com',
  'api.x.ai',
  'api.z.ai',
  'auth.openai.com',
  'autopush-cloudcode-pa.sandbox.googleapis.com',
  'chatgpt.com',
  'claude.ai',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
  'downloads.claude.ai',
  'generativelanguage.googleapis.com',
  'github.com',
  'mcp-proxy.anthropic.com',
  'opencode.ai',
  'oauth2.googleapis.com',
  'openrouter.ai',
  'platform.claude.com',
  'router.huggingface.co',
  'www.googleapis.com',
]);
export const UPSTREAM_PROXY_ALLOWED_HOST_PATTERNS = ['*.openai.azure.com', '*-aiplatform.googleapis.com'];
const UPSTREAM_PROXY_SESSION_TTL_MS = 30 * 60 * 1000;
const UPSTREAM_PROXY_COOKIE_JAR_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const UPSTREAM_PROXY_COOKIE_ESTIMATED_OVERHEAD_BYTES = 64;
const UPSTREAM_PROXY_REQUEST_BODY_TOO_LARGE_MESSAGE = 'Upstream proxy request body too large';
const UPSTREAM_PROXY_RESPONSE_BODY_TOO_LARGE_MESSAGE = 'Upstream proxy response body too large';

export const UPSTREAM_PROXY_STRIPPED_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'dnt',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'sec-gpc',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  UPSTREAM_PROXY_SESSION_HEADER,
  UPSTREAM_PROXY_USER_AGENT_HEADER,
]);

export const UPSTREAM_PROXY_STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

interface UpstreamProxyCookie {
  createdAtMs: number;
  domain: string | null;
  expiresAtMs: number | null;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: string | null;
  secure: boolean;
  value: string;
}

interface UpstreamProxySessionHostJar {
  cookies: Map<string, UpstreamProxyCookie>;
  updatedAtMs: number;
}

interface UpstreamProxySessionJar {
  hosts: Map<string, UpstreamProxySessionHostJar>;
  updatedAtMs: number;
}

export interface UpstreamProxyCookieJarLimits {
  maxSessions: number;
  maxHostsPerSession: number;
  maxCookiesPerHost: number;
  maxCookieBytesPerSession: number;
  maxCookieValueBytes: number;
}

const DEFAULT_UPSTREAM_PROXY_COOKIE_JAR_LIMITS: UpstreamProxyCookieJarLimits = {
  maxSessions: UPSTREAM_PROXY_MAX_SESSIONS,
  maxHostsPerSession: UPSTREAM_PROXY_MAX_HOSTS_PER_SESSION,
  maxCookiesPerHost: UPSTREAM_PROXY_MAX_COOKIES_PER_HOST,
  maxCookieBytesPerSession: UPSTREAM_PROXY_MAX_COOKIE_BYTES_PER_SESSION,
  maxCookieValueBytes: UPSTREAM_PROXY_MAX_COOKIE_VALUE_BYTES,
};

const upstreamProxyCookieJars = new Map<string, UpstreamProxySessionJar>();
const upstreamProxyInflightRequests = new Map<string, number>();
let upstreamProxyCookieJarCleanupStarted = false;

function normalizeProxyTargetHost(rawHost: string): string {
  const normalized = rawHost.trim().toLowerCase();
  if (!normalized) throw new ClientError('Missing upstream host segment', 400);
  if (!isAllowedUpstreamProxyHost(normalized)) throw new ClientError('Upstream host not allowed', 403);
  return normalized;
}

function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  if (!hostname || !pattern) return false;
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
  return new RegExp(`^${escapedPattern}$`, 'i').test(hostname);
}

function isAllowedUpstreamProxyHost(hostname: string): boolean {
  if (UPSTREAM_PROXY_ALLOWED_HOSTS.has(hostname)) return true;
  return UPSTREAM_PROXY_ALLOWED_HOST_PATTERNS.some((pattern) => hostnameMatchesPattern(hostname, pattern));
}

function normalizeProxySessionId(rawSessionId: string | string[] | undefined): string | null {
  if (typeof rawSessionId !== 'string') return null;
  const normalized = rawSessionId.trim();
  if (!normalized || normalized.length > UPSTREAM_PROXY_SESSION_ID_MAX_LENGTH) return null;
  return normalized;
}

function resolveUpstreamProxyCookieJarLimits(
  overrides?: Partial<UpstreamProxyCookieJarLimits>,
): UpstreamProxyCookieJarLimits {
  return {
    maxSessions: Math.max(1, overrides?.maxSessions ?? DEFAULT_UPSTREAM_PROXY_COOKIE_JAR_LIMITS.maxSessions),
    maxHostsPerSession: Math.max(
      1,
      overrides?.maxHostsPerSession ?? DEFAULT_UPSTREAM_PROXY_COOKIE_JAR_LIMITS.maxHostsPerSession,
    ),
    maxCookiesPerHost: Math.max(
      1,
      overrides?.maxCookiesPerHost ?? DEFAULT_UPSTREAM_PROXY_COOKIE_JAR_LIMITS.maxCookiesPerHost,
    ),
    maxCookieBytesPerSession: Math.max(
      1,
      overrides?.maxCookieBytesPerSession ?? DEFAULT_UPSTREAM_PROXY_COOKIE_JAR_LIMITS.maxCookieBytesPerSession,
    ),
    maxCookieValueBytes: Math.max(
      1,
      overrides?.maxCookieValueBytes ?? DEFAULT_UPSTREAM_PROXY_COOKIE_JAR_LIMITS.maxCookieValueBytes,
    ),
  };
}

function parseSetCookieHeader(
  setCookie: string,
  nowMs: number,
  limits: UpstreamProxyCookieJarLimits,
): UpstreamProxyCookie | null {
  const parts = setCookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const [nameValue, ...attributes] = parts;
  const equalsIndex = nameValue.indexOf('=');
  if (equalsIndex <= 0) return null;

  const name = nameValue.slice(0, equalsIndex).trim();
  if (!name) return null;

  let domain: string | null = null;
  let path = '/';
  let expiresAtMs: number | null = null;
  let httpOnly = false;
  let sameSite: string | null = null;
  let secure = false;
  for (const attribute of attributes) {
    const separatorIndex = attribute.indexOf('=');
    const attributeName =
      separatorIndex === -1 ? attribute.trim().toLowerCase() : attribute.slice(0, separatorIndex).trim().toLowerCase();
    const attributeValue = separatorIndex === -1 ? '' : attribute.slice(separatorIndex + 1).trim();

    if (attributeName === 'domain') {
      domain = attributeValue ? attributeValue.toLowerCase() : null;
      continue;
    }
    if (attributeName === 'path' && attributeValue.startsWith('/')) {
      path = attributeValue;
      continue;
    }
    if (attributeName === 'max-age') {
      const maxAgeSeconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(maxAgeSeconds)) {
        expiresAtMs = maxAgeSeconds <= 0 ? nowMs - 1 : nowMs + maxAgeSeconds * 1000;
      }
      continue;
    }
    if (attributeName === 'expires') {
      const expiresAt = Date.parse(attributeValue);
      if (Number.isFinite(expiresAt)) {
        expiresAtMs = expiresAt;
      }
      continue;
    }
    if (attributeName === 'httponly') {
      httpOnly = true;
      continue;
    }
    if (attributeName === 'samesite') {
      sameSite = attributeValue || null;
      continue;
    }
    if (attributeName === 'secure') {
      secure = true;
    }
  }

  const value = nameValue.slice(equalsIndex + 1);
  if (Buffer.byteLength(value) > limits.maxCookieValueBytes) return null;

  return {
    createdAtMs: nowMs,
    domain,
    expiresAtMs,
    httpOnly,
    name,
    path,
    sameSite,
    secure,
    value,
  };
}

function estimateUpstreamProxyCookieBytes(cookie: UpstreamProxyCookie): number {
  return (
    Buffer.byteLength(cookie.name) +
    Buffer.byteLength(cookie.value) +
    Buffer.byteLength(cookie.path) +
    Buffer.byteLength(cookie.domain ?? '') +
    UPSTREAM_PROXY_COOKIE_ESTIMATED_OVERHEAD_BYTES
  );
}

function estimateUpstreamProxySessionCookieBytes(sessionJar: UpstreamProxySessionJar): number {
  let totalBytes = 0;
  for (const hostJar of sessionJar.hosts.values()) {
    for (const cookie of hostJar.cookies.values()) {
      totalBytes += estimateUpstreamProxyCookieBytes(cookie);
    }
  }
  return totalBytes;
}

function evictOldestUpstreamProxySession(): boolean {
  let oldestSessionId: string | null = null;
  let oldestUpdatedAtMs = Number.POSITIVE_INFINITY;
  for (const [sessionId, sessionJar] of upstreamProxyCookieJars) {
    if (sessionJar.updatedAtMs >= oldestUpdatedAtMs) continue;
    oldestSessionId = sessionId;
    oldestUpdatedAtMs = sessionJar.updatedAtMs;
  }
  if (!oldestSessionId) return false;
  upstreamProxyCookieJars.delete(oldestSessionId);
  return true;
}

function evictOldestUpstreamProxyHost(sessionJar: UpstreamProxySessionJar): boolean {
  let oldestHost: string | null = null;
  let oldestUpdatedAtMs = Number.POSITIVE_INFINITY;
  for (const [host, hostJar] of sessionJar.hosts) {
    if (hostJar.updatedAtMs >= oldestUpdatedAtMs) continue;
    oldestHost = host;
    oldestUpdatedAtMs = hostJar.updatedAtMs;
  }
  if (!oldestHost) return false;
  sessionJar.hosts.delete(oldestHost);
  return true;
}

function evictOldestUpstreamProxyCookieInHost(jar: UpstreamProxySessionHostJar): boolean {
  let oldestCookieKey: string | null = null;
  let oldestCreatedAtMs = Number.POSITIVE_INFINITY;
  for (const [cookieKey, cookie] of jar.cookies) {
    if (cookie.createdAtMs >= oldestCreatedAtMs) continue;
    oldestCookieKey = cookieKey;
    oldestCreatedAtMs = cookie.createdAtMs;
  }
  if (!oldestCookieKey) return false;
  jar.cookies.delete(oldestCookieKey);
  return true;
}

function evictOldestUpstreamProxyCookieInSession(sessionJar: UpstreamProxySessionJar): boolean {
  let oldestHostJar: UpstreamProxySessionHostJar | null = null;
  let oldestCookieKey: string | null = null;
  let oldestCreatedAtMs = Number.POSITIVE_INFINITY;
  for (const hostJar of sessionJar.hosts.values()) {
    for (const [cookieKey, cookie] of hostJar.cookies) {
      if (cookie.createdAtMs >= oldestCreatedAtMs) continue;
      oldestHostJar = hostJar;
      oldestCookieKey = cookieKey;
      oldestCreatedAtMs = cookie.createdAtMs;
    }
  }
  if (!oldestHostJar || !oldestCookieKey) return false;
  oldestHostJar.cookies.delete(oldestCookieKey);
  return true;
}

function deleteExpiredUpstreamProxyCookies(jar: UpstreamProxySessionHostJar, nowMs: number): void {
  for (const [key, cookie] of jar.cookies) {
    if (cookie.expiresAtMs !== null && cookie.expiresAtMs <= nowMs) {
      jar.cookies.delete(key);
    }
  }
}

function removeEmptyUpstreamProxyHosts(sessionJar: UpstreamProxySessionJar): void {
  for (const [host, jar] of sessionJar.hosts) {
    if (jar.cookies.size === 0) {
      sessionJar.hosts.delete(host);
    }
  }
}

function enforceUpstreamProxyCookieJarLimits(
  sessionId: string,
  sessionJar: UpstreamProxySessionJar,
  limits: UpstreamProxyCookieJarLimits,
): void {
  while (sessionJar.hosts.size > limits.maxHostsPerSession) {
    if (!evictOldestUpstreamProxyHost(sessionJar)) break;
  }

  for (const jar of sessionJar.hosts.values()) {
    while (jar.cookies.size > limits.maxCookiesPerHost) {
      if (!evictOldestUpstreamProxyCookieInHost(jar)) break;
    }
  }

  removeEmptyUpstreamProxyHosts(sessionJar);

  while (estimateUpstreamProxySessionCookieBytes(sessionJar) > limits.maxCookieBytesPerSession) {
    if (!evictOldestUpstreamProxyCookieInSession(sessionJar)) break;
    removeEmptyUpstreamProxyHosts(sessionJar);
  }

  if (sessionJar.hosts.size === 0) {
    upstreamProxyCookieJars.delete(sessionId);
  }
}

function getOrCreateUpstreamProxySessionJar(
  sessionId: string,
  nowMs: number,
  limits: UpstreamProxyCookieJarLimits,
): UpstreamProxySessionJar {
  let sessionJar = upstreamProxyCookieJars.get(sessionId);
  if (!sessionJar) {
    while (upstreamProxyCookieJars.size >= limits.maxSessions) {
      if (!evictOldestUpstreamProxySession()) break;
    }
    sessionJar = {
      hosts: new Map(),
      updatedAtMs: nowMs,
    };
    upstreamProxyCookieJars.set(sessionId, sessionJar);
  }
  sessionJar.updatedAtMs = nowMs;
  return sessionJar;
}

function getUpstreamProxyJar(
  sessionId: string,
  host: string,
  nowMs: number,
  limits: UpstreamProxyCookieJarLimits,
): { sessionJar: UpstreamProxySessionJar; hostJar: UpstreamProxySessionHostJar } {
  const sessionJar = getOrCreateUpstreamProxySessionJar(sessionId, nowMs, limits);
  let hostJar = sessionJar.hosts.get(host);
  if (!hostJar) {
    while (sessionJar.hosts.size >= limits.maxHostsPerSession) {
      if (!evictOldestUpstreamProxyHost(sessionJar)) break;
    }
    hostJar = {
      cookies: new Map(),
      updatedAtMs: nowMs,
    };
    sessionJar.hosts.set(host, hostJar);
  }
  hostJar.updatedAtMs = nowMs;
  sessionJar.updatedAtMs = nowMs;
  return { sessionJar, hostJar };
}

function pruneUpstreamProxyCookieJars(nowMs: number, limits = DEFAULT_UPSTREAM_PROXY_COOKIE_JAR_LIMITS): void {
  for (const [sessionId, sessionJar] of upstreamProxyCookieJars) {
    if (nowMs - sessionJar.updatedAtMs > UPSTREAM_PROXY_SESSION_TTL_MS) {
      upstreamProxyCookieJars.delete(sessionId);
      continue;
    }
    for (const [host, jar] of sessionJar.hosts) {
      deleteExpiredUpstreamProxyCookies(jar, nowMs);
      if (jar.cookies.size === 0) {
        sessionJar.hosts.delete(host);
      }
    }
    if (sessionJar.hosts.size === 0) {
      upstreamProxyCookieJars.delete(sessionId);
      continue;
    }
    enforceUpstreamProxyCookieJarLimits(sessionId, sessionJar, limits);
  }
  while (upstreamProxyCookieJars.size > limits.maxSessions) {
    if (!evictOldestUpstreamProxySession()) break;
  }
}

export function startUpstreamProxyCookieJarCleanup(): void {
  if (upstreamProxyCookieJarCleanupStarted) return;
  upstreamProxyCookieJarCleanupStarted = true;
  setInterval(() => pruneUpstreamProxyCookieJars(Date.now()), UPSTREAM_PROXY_COOKIE_JAR_CLEANUP_INTERVAL_MS).unref();
}

function pathMatchesCookiePath(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === '/') return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (requestPath.length === cookiePath.length) return true;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

export function buildUpstreamProxyUrl(pathname: string, search = ''): URL {
  const subPath = pathname.replace(/^\/api\/upstream-proxy\/?/, '');
  if (!subPath) throw new ClientError('Missing upstream host segment', 400);
  const slashIndex = subPath.indexOf('/');
  const rawHost = decodeURIComponent(slashIndex === -1 ? subPath : subPath.slice(0, slashIndex));
  const targetHost = normalizeProxyTargetHost(rawHost);
  const restPath = slashIndex === -1 ? '/' : subPath.slice(slashIndex);
  return new URL(`https://${targetHost}${restPath}${search}`);
}

export function buildUpstreamProxyRequestHeaders(headers: http.IncomingHttpHeaders): Headers {
  const nextHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const normalizedName = name.toLowerCase();
    if (UPSTREAM_PROXY_STRIPPED_REQUEST_HEADERS.has(normalizedName)) continue;
    if (normalizedName.startsWith('sec-')) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        nextHeaders.append(name, item);
      }
      continue;
    }
    nextHeaders.set(name, value);
  }
  return nextHeaders;
}

export function getUpstreamProxySessionId(headers: http.IncomingHttpHeaders): string | null {
  return normalizeProxySessionId(headers[UPSTREAM_PROXY_SESSION_HEADER]);
}

export function readUpstreamProxyContentLength(value: string | string[] | null | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function upstreamProxyBodyTooLargeMessage(bodyLabel: 'request' | 'response'): string {
  return bodyLabel === 'request'
    ? UPSTREAM_PROXY_REQUEST_BODY_TOO_LARGE_MESSAGE
    : UPSTREAM_PROXY_RESPONSE_BODY_TOO_LARGE_MESSAGE;
}

export function assertUpstreamProxyContentLengthWithinLimit(
  value: string | string[] | null | undefined,
  maxBytes: number,
  bodyLabel: 'request' | 'response',
): void {
  const contentLength = readUpstreamProxyContentLength(value);
  if (contentLength !== null && contentLength > maxBytes) {
    throw new ClientError(upstreamProxyBodyTooLargeMessage(bodyLabel), 413);
  }
}

export function createUpstreamProxyBodyLimitTransform(maxBytes: number, bodyLabel: 'request' | 'response'): Transform {
  let totalBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        callback(new ClientError(upstreamProxyBodyTooLargeMessage(bodyLabel), 413));
        return;
      }
      callback(null, buffer);
    },
  });
}

export function getUpstreamProxyForwardedUserAgent(headers: http.IncomingHttpHeaders): string | null {
  const rawUserAgent = headers[UPSTREAM_PROXY_USER_AGENT_HEADER];
  if (typeof rawUserAgent !== 'string') return null;
  const normalized = rawUserAgent.trim();
  return normalized ? normalized : null;
}

export function getUpstreamProxyResponseSetCookieHeaders(headers: Headers): string[] {
  const typedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof typedHeaders.getSetCookie === 'function') {
    return typedHeaders.getSetCookie();
  }
  const fallbackValue = headers.get('set-cookie');
  return fallbackValue ? [fallbackValue] : [];
}

export function storeUpstreamProxyResponseCookies(
  sessionId: string | null,
  targetHost: string,
  headers: Headers,
  nowMs = Date.now(),
  limitOverrides?: Partial<UpstreamProxyCookieJarLimits>,
): void {
  const limits = resolveUpstreamProxyCookieJarLimits(limitOverrides);
  pruneUpstreamProxyCookieJars(nowMs, limits);
  if (!sessionId) return;
  const setCookieHeaders = getUpstreamProxyResponseSetCookieHeaders(headers);
  if (setCookieHeaders.length === 0) return;

  const { sessionJar, hostJar } = getUpstreamProxyJar(sessionId, targetHost, nowMs, limits);
  deleteExpiredUpstreamProxyCookies(hostJar, nowMs);

  for (const setCookie of setCookieHeaders) {
    const parsedCookie = parseSetCookieHeader(setCookie, nowMs, limits);
    if (!parsedCookie) continue;
    const cookieKey = `${parsedCookie.name};${parsedCookie.path}`;
    if (parsedCookie.expiresAtMs !== null && parsedCookie.expiresAtMs <= nowMs) {
      hostJar.cookies.delete(cookieKey);
      continue;
    }
    hostJar.cookies.set(cookieKey, parsedCookie);
  }

  hostJar.updatedAtMs = nowMs;
  sessionJar.updatedAtMs = nowMs;
  enforceUpstreamProxyCookieJarLimits(sessionId, sessionJar, limits);
}

export function attachUpstreamProxyCookies(
  headers: Headers,
  sessionId: string | null,
  targetHost: string,
  requestPath: string,
  nowMs = Date.now(),
): void {
  pruneUpstreamProxyCookieJars(nowMs);
  if (!sessionId) return;
  const sessionJar = upstreamProxyCookieJars.get(sessionId);
  const jar = sessionJar?.hosts.get(targetHost);
  if (!jar) return;

  deleteExpiredUpstreamProxyCookies(jar, nowMs);
  if (jar.cookies.size === 0) {
    sessionJar?.hosts.delete(targetHost);
    if (sessionJar && sessionJar.hosts.size === 0) upstreamProxyCookieJars.delete(sessionId);
    return;
  }

  jar.updatedAtMs = nowMs;
  if (sessionJar) sessionJar.updatedAtMs = nowMs;

  const matchingCookies = [...jar.cookies.values()]
    .filter((cookie) => pathMatchesCookiePath(requestPath, cookie.path))
    .sort((left, right) => right.path.length - left.path.length || left.createdAtMs - right.createdAtMs);
  if (matchingCookies.length === 0) return;

  headers.set('cookie', matchingCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
}

function resolveUpstreamProxyConcurrencyBucket(
  req: http.IncomingMessage,
  userId: number | null,
): { key: string; maxConcurrent: number } {
  if (userId !== null) {
    return {
      key: `user:${userId}`,
      maxConcurrent: UPSTREAM_PROXY_MAX_CONCURRENT_AUTH,
    };
  }

  const proxySessionId = getUpstreamProxySessionId(req.headers);
  if (proxySessionId) {
    return {
      key: `webcontainer-session:${proxySessionId}`,
      maxConcurrent: UPSTREAM_PROXY_MAX_CONCURRENT_WEBCONTAINER_ANON,
    };
  }

  return {
    key: `ip:${getClientIp(req)}`,
    maxConcurrent: UPSTREAM_PROXY_MAX_CONCURRENT_ANON,
  };
}

export function acquireUpstreamProxyConcurrency(req: http.IncomingMessage, userId: number | null): () => void {
  const { key, maxConcurrent } = resolveUpstreamProxyConcurrencyBucket(req, userId);
  const inflight = upstreamProxyInflightRequests.get(key) ?? 0;
  if (inflight >= maxConcurrent) {
    throw new ClientError('Too many concurrent upstream proxy requests', 429);
  }
  upstreamProxyInflightRequests.set(key, inflight + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (upstreamProxyInflightRequests.get(key) ?? 1) - 1;
    if (next <= 0) {
      upstreamProxyInflightRequests.delete(key);
      return;
    }
    upstreamProxyInflightRequests.set(key, next);
  };
}

export function resetUpstreamProxyStateForTests(): void {
  upstreamProxyCookieJars.clear();
  upstreamProxyInflightRequests.clear();
}

export function copyUpstreamProxyResponseHeaders(upstream: Response, res: http.ServerResponse): void {
  upstream.headers.forEach((value, name) => {
    if (UPSTREAM_PROXY_STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
    res.setHeader(name, value);
  });
}
