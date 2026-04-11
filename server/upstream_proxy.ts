import type http from 'node:http';
import { UPSTREAM_PROXY_SESSION_HEADER, UPSTREAM_PROXY_USER_AGENT_HEADER } from '../shared/upstream_proxy.ts';
import { ClientError } from './errors.ts';

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

const upstreamProxyCookieJars = new Map<string, Map<string, UpstreamProxySessionHostJar>>();

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
  return normalized ? normalized : null;
}

function parseSetCookieHeader(setCookie: string, nowMs: number): UpstreamProxyCookie | null {
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

  return {
    createdAtMs: nowMs,
    domain,
    expiresAtMs,
    httpOnly,
    name,
    path,
    sameSite,
    secure,
    value: nameValue.slice(equalsIndex + 1),
  };
}

function getUpstreamProxyJar(sessionId: string, host: string): UpstreamProxySessionHostJar {
  let sessionJars = upstreamProxyCookieJars.get(sessionId);
  if (!sessionJars) {
    sessionJars = new Map();
    upstreamProxyCookieJars.set(sessionId, sessionJars);
  }
  let hostJar = sessionJars.get(host);
  if (!hostJar) {
    hostJar = {
      cookies: new Map(),
      updatedAtMs: Date.now(),
    };
    sessionJars.set(host, hostJar);
  }
  hostJar.updatedAtMs = Date.now();
  return hostJar;
}

function deleteExpiredUpstreamProxyCookies(jar: UpstreamProxySessionHostJar, nowMs: number): void {
  for (const [key, cookie] of jar.cookies) {
    if (cookie.expiresAtMs !== null && cookie.expiresAtMs <= nowMs) {
      jar.cookies.delete(key);
    }
  }
}

function pruneUpstreamProxyCookieJars(nowMs: number): void {
  for (const [sessionId, sessionJars] of upstreamProxyCookieJars) {
    for (const [host, jar] of sessionJars) {
      deleteExpiredUpstreamProxyCookies(jar, nowMs);
      if (jar.cookies.size === 0 && nowMs - jar.updatedAtMs > UPSTREAM_PROXY_SESSION_TTL_MS) {
        sessionJars.delete(host);
      }
    }
    if (sessionJars.size === 0) {
      upstreamProxyCookieJars.delete(sessionId);
    }
  }
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
): void {
  pruneUpstreamProxyCookieJars(nowMs);
  if (!sessionId) return;
  const setCookieHeaders = getUpstreamProxyResponseSetCookieHeaders(headers);
  if (setCookieHeaders.length === 0) return;

  const jar = getUpstreamProxyJar(sessionId, targetHost);
  deleteExpiredUpstreamProxyCookies(jar, nowMs);

  for (const setCookie of setCookieHeaders) {
    const parsedCookie = parseSetCookieHeader(setCookie, nowMs);
    if (!parsedCookie) continue;
    const cookieKey = `${parsedCookie.name};${parsedCookie.path}`;
    if (parsedCookie.expiresAtMs !== null && parsedCookie.expiresAtMs <= nowMs) {
      jar.cookies.delete(cookieKey);
      continue;
    }
    jar.cookies.set(cookieKey, parsedCookie);
  }
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
  const sessionJars = upstreamProxyCookieJars.get(sessionId);
  const jar = sessionJars?.get(targetHost);
  if (!jar) return;

  deleteExpiredUpstreamProxyCookies(jar, nowMs);
  const matchingCookies = [...jar.cookies.values()]
    .filter((cookie) => pathMatchesCookiePath(requestPath, cookie.path))
    .sort((left, right) => right.path.length - left.path.length || left.createdAtMs - right.createdAtMs);
  if (matchingCookies.length === 0) return;

  headers.set('cookie', matchingCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
}

export function copyUpstreamProxyResponseHeaders(upstream: Response, res: http.ServerResponse): void {
  upstream.headers.forEach((value, name) => {
    if (UPSTREAM_PROXY_STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
    res.setHeader(name, value);
  });
}
