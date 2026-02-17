import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url) });

// --- Config ---

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET not set — using random ephemeral secret. Sessions will not survive server restarts.');
}

// --- Types ---

interface Session {
  installationId: string;
}

interface TokenCacheRecord {
  token: string;
  expires_at: string;
  expiresAtMs: number;
}

interface RateLimitEntry {
  count: number;
  resetAtMs: number;
}

// --- Session tokens (HMAC-SHA256) ---

function createSessionToken(installationId: string): string {
  const payload = JSON.stringify({
    sub: String(installationId),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function validateSessionToken(token: string): Session | null {
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

function requireSession(req: http.IncomingMessage): Session | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return validateSessionToken(auth.slice(7));
}

// --- HTTP helpers ---

function json(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function base64url(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function requireString(body: Record<string, unknown> | null, key: string): string {
  const v = body?.[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} is required`);
  return v;
}

// --- GitHub App JWT ---

async function getAppPrivateKeyPem(): Promise<string> {
  const keyInline = process.env.GITHUB_APP_PRIVATE_KEY;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (keyInline?.trim()) return keyInline;
  if (keyPath?.trim()) {
    return await readFile(keyPath, 'utf8');
  }
  throw new Error('Missing GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH');
}

async function createAppJwt(): Promise<string> {
  const appId = requireEnv('GITHUB_APP_ID');
  const privateKeyPem = await getAppPrivateKeyPem();
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);

  return `${signingInput}.${base64url(signature)}`;
}

// --- Installation token cache ---

const installationTokenCache = new Map<string, TokenCacheRecord>();
const MAX_TOKEN_CACHE_SIZE = 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of installationTokenCache) {
    if (record.expiresAtMs <= now) installationTokenCache.delete(key);
  }
}, 5 * 60 * 1000).unref();

// --- Rate limiter ---

const rateLimitWindows = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;
function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  let entry = rateLimitWindows.get(ip);
  if (!entry || now >= entry.resetAtMs) {
    if (!entry && rateLimitWindows.size >= MAX_RATE_LIMIT_ENTRIES) {
      json(res, 429, { error: 'Too many requests' });
      return false;
    }
    entry = { count: 0, resetAtMs: now + RATE_LIMIT_WINDOW_MS };
    rateLimitWindows.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetAtMs - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    json(res, 429, { error: 'Too many requests' });
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitWindows) {
    if (now >= entry.resetAtMs) rateLimitWindows.delete(ip);
  }
}, 2 * 60 * 1000).unref();

// --- GitHub API helpers ---

const GITHUB_FETCH_TIMEOUT_MS = 15_000;

function cacheKey(installationId: string, repositoryIds?: number[]): string {
  if (!repositoryIds?.length) return `${installationId}:all`;
  return `${installationId}:${repositoryIds.map((n) => String(n)).sort().join(',')}`;
}

async function getInstallationToken(installationId: string, repositoryIds?: number[]): Promise<TokenCacheRecord> {
  const key = cacheKey(installationId, repositoryIds);
  const cached = installationTokenCache.get(key);
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached;

  const jwt = await createAppJwt();
  const url = `https://api.github.com/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${jwt}`,
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(repositoryIds?.length ? { repository_ids: repositoryIds } : {}),
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Failed to mint installation token: ${res.status} ${res.statusText}`, body);
    throw new Error(`GitHub API error: ${res.status}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  const expiresAtMs = Date.parse(data.expires_at);
  const record: TokenCacheRecord = { token: data.token, expires_at: data.expires_at, expiresAtMs };
  if (installationTokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
    const oldest = installationTokenCache.keys().next().value;
    if (oldest !== undefined) installationTokenCache.delete(oldest);
  }
  installationTokenCache.set(key, record);
  return record;
}

async function githubFetchWithInstallationToken(installationId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const tokenRec = await getInstallationToken(installationId);
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${tokenRec.token}`,
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers as Record<string, string> ?? {}),
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`GitHub API error on ${path}: ${res.status} ${res.statusText}`, body);
    throw new Error(`GitHub API error: ${res.status}`);
  }
  return res;
}

function encodePathPreserveSlashes(path: string): string {
  return String(path)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// --- Static file serving (production) ---

const DIST_DIR = path.resolve(new URL('../dist', import.meta.url).pathname);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<boolean> {
  const safePath = path.normalize(decodeURIComponent(pathname));
  const filePath = path.join(DIST_DIR, safePath);
  if (!filePath.startsWith(DIST_DIR)) return false;

  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const ext = path.extname(filePath);
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      ...(ext !== '.html' ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}),
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// --- CORS ---

const ALLOWED_ORIGINS = new Set([
  'https://input.md',
  'http://localhost:5173',
  'http://localhost:5174',
]);

function corsify(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

// --- Request handler ---

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    corsify(req, res);
    if (req.method === 'OPTIONS') return res.end();

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/api/github-app/health') {
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/github-app/install-url' && req.method === 'GET') {
      if (!checkRateLimit(req, res)) return;
      const slug = requireEnv('GITHUB_APP_SLUG');
      const state = url.searchParams.get('state');
      const installUrl = new URL(`https://github.com/apps/${slug}/installations/new`);
      if (state) installUrl.searchParams.set('state', state);
      return json(res, 200, { url: installUrl.toString() });
    }

    // Session creation: verify installation with GitHub, issue signed token
    if (pathname === '/api/github-app/sessions' && req.method === 'POST') {
      if (!checkRateLimit(req, res)) return;
      const body = await readJson(req);
      const installationId = body?.installationId;
      if (!installationId || typeof installationId !== 'string') {
        return json(res, 400, { error: 'installationId is required' });
      }
      const jwt = await createAppJwt();
      const ghRes = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}`, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${jwt}`,
          'User-Agent': 'input-github-app-auth-server',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });
      if (!ghRes.ok) {
        return json(res, 403, { error: 'Invalid installation' });
      }
      const token = createSessionToken(installationId as string);
      return json(res, 200, { token, installationId });
    }

    // All /installations/ routes require a valid session
    if (pathname.startsWith('/api/github-app/installations/')) {
      if (!checkRateLimit(req, res)) return;
      const session = requireSession(req);
      if (!session) return json(res, 401, { error: 'Unauthorized' });
    }

    const repoListMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repositories$/);
    if (repoListMatch && req.method === 'GET') {
      const session = requireSession(req)!;
      const installationId = repoListMatch[1];
      if (session.installationId !== installationId) return json(res, 403, { error: 'Forbidden' });
      const allRepos: unknown[] = [];
      const MAX_PAGES = 50;
      let page = 1;
      while (page <= MAX_PAGES) {
        const ghRes = await githubFetchWithInstallationToken(installationId, `/installation/repositories?per_page=100&page=${page}`);
        const data = (await ghRes.json()) as { total_count: number; repositories?: unknown[] };
        allRepos.push(...(data.repositories ?? []));
        if (allRepos.length >= data.total_count || (data.repositories ?? []).length < 100) break;
        page++;
      }
      return json(res, 200, { total_count: allRepos.length, repositories: allRepos });
    }

    // Repo Contents API proxy
    const contentsMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/);
    if (contentsMatch) {
      const session = requireSession(req)!;
      const installationId = contentsMatch[1];
      if (session.installationId !== installationId) return json(res, 403, { error: 'Forbidden' });
      const owner = contentsMatch[2];
      const repo = contentsMatch[3];

      if (req.method === 'GET') {
        const pathParam = url.searchParams.get('path') ?? '';
        const ref = url.searchParams.get('ref');
        const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
        const ghUrl = ref ? `${ghPath}?ref=${encodeURIComponent(ref)}` : ghPath;
        const ghRes = await githubFetchWithInstallationToken(installationId, ghUrl);
        const data: unknown = await ghRes.json();
        return json(res, 200, data);
      }

      if (req.method === 'PUT') {
        const body = await readJson(req);
        const pathParam = requireString(body, 'path');
        const message = requireString(body, 'message');
        const content = requireString(body, 'content');
        const sha = typeof body?.sha === 'string' ? body.sha : undefined;
        const branch = typeof body?.branch === 'string' ? body.branch : undefined;
        const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
        const ghRes = await githubFetchWithInstallationToken(installationId, ghPath, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, content, sha, branch }),
        });
        const data: unknown = await ghRes.json();
        return json(res, 200, data);
      }

      if (req.method === 'DELETE') {
        const body = await readJson(req);
        const pathParam = requireString(body, 'path');
        const message = requireString(body, 'message');
        const sha = requireString(body, 'sha');
        const branch = typeof body?.branch === 'string' ? body.branch : undefined;
        const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
        const ghRes = await githubFetchWithInstallationToken(installationId, ghPath, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sha, branch }),
        });
        const data: unknown = await ghRes.json();
        return json(res, 200, data);
      }

      return json(res, 405, { error: 'Method not allowed' });
    }

    // --- Device Flow proxy (OAuth gist auth) ---

    if (pathname === '/api/device-flow/code' && req.method === 'POST') {
      if (!checkRateLimit(req, res)) return;
      if (!GITHUB_CLIENT_ID) return json(res, 503, { error: 'OAuth not configured' });

      const ghRes = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'gist' }),
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });
      if (!ghRes.ok) return json(res, 502, { error: 'Failed to initiate device flow' });
      const data = await ghRes.json() as Record<string, unknown>;
      return json(res, 200, data);
    }

    if (pathname === '/api/device-flow/token' && req.method === 'POST') {
      if (!checkRateLimit(req, res)) return;
      if (!GITHUB_CLIENT_ID) return json(res, 503, { error: 'OAuth not configured' });

      const body = await readJson(req);
      const deviceCode = requireString(body, 'device_code');

      const ghRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });
      if (!ghRes.ok) return json(res, 502, { error: 'Failed to poll for token' });
      const data = await ghRes.json() as Record<string, unknown>;
      return json(res, 200, data);
    }

    // Static files / SPA fallback
    if (req.method === 'GET') {
      if (await serveStatic(res, pathname)) return;
      if (await serveStatic(res, '/index.html')) return;
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    const safe = /^(Request body too large|Invalid JSON body|GitHub API error: \d+|\w+ is required)$/.test(msg);
    if (!safe) {
      console.error('Unhandled server error:', err);
    }
    return json(res, safe ? 400 : 500, { error: safe ? msg : 'Internal server error' });
  }
});

server.listen(PORT, () => {
  const configured = Boolean(
    process.env.GITHUB_APP_ID &&
    (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH) &&
    process.env.GITHUB_APP_SLUG,
  );
  console.log(`GitHub App auth server listening on http://localhost:${PORT} (configured=${configured})`);
});

function gracefulShutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
