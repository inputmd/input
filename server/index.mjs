import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function loadDotEnv() {
  try {
    const raw = await readFile(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (process.env[key] == null) process.env[key] = value;
    }
  } catch {
    // optional
  }
}

await loadDotEnv();

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);

// Session secret for HMAC-signing session tokens
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

if (!process.env.SESSION_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('WARNING: SESSION_SECRET not set — using random ephemeral secret. Sessions will not survive server restarts.');
}

function createSessionToken(installationId) {
  const payload = JSON.stringify({
    sub: String(installationId),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function validateSessionToken(token) {
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return { installationId: payload.sub };
  } catch {
    return null;
  }
}

function requireSession(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return validateSessionToken(auth.slice(7));
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function text(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(data);
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function getAppPrivateKeyPem() {
  const keyInline = process.env.GITHUB_APP_PRIVATE_KEY;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (keyInline?.trim()) return keyInline;
  if (keyPath?.trim()) {
    return await readFile(keyPath, 'utf8');
  }
  throw new Error('Missing GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH');
}

async function createAppJwt() {
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

const installationTokenCache = new Map();

// Evict expired tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of installationTokenCache) {
    if (record.expiresAtMs <= now) installationTokenCache.delete(key);
  }
}, 5 * 60 * 1000).unref();

// Rate limiter: per-IP sliding window
const rateLimitWindows = new Map(); // ip -> { count, resetAtMs }
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(req, res) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null)
    || req.socket.remoteAddress
    || 'unknown';
  const now = Date.now();
  let entry = rateLimitWindows.get(ip);
  if (!entry || now >= entry.resetAtMs) {
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

// Evict stale rate-limit entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitWindows) {
    if (now >= entry.resetAtMs) rateLimitWindows.delete(ip);
  }
}, 2 * 60 * 1000).unref();

function cacheKey(installationId, repositoryIds) {
  if (!repositoryIds?.length) return `${installationId}:all`;
  return `${installationId}:${repositoryIds.map((n) => String(n)).sort().join(',')}`;
}

async function getInstallationToken(installationId, repositoryIds) {
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
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.error(`Failed to mint installation token: ${res.status} ${res.statusText}`, body);
    throw new Error(`GitHub API error: ${res.status}`);
  }
  const data = await res.json();
  const expiresAtMs = Date.parse(data.expires_at);
  const record = { token: data.token, expires_at: data.expires_at, expiresAtMs };
  installationTokenCache.set(key, record);
  return record;
}

async function githubFetchWithInstallationToken(installationId, path, init = {}) {
  const tokenRec = await getInstallationToken(installationId);
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${tokenRec.token}`,
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.error(`GitHub API error on ${path}: ${res.status} ${res.statusText}`, body);
    throw new Error(`GitHub API error: ${res.status}`);
  }
  return res;
}

function encodePathPreserveSlashes(path) {
  return String(path)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function requireString(body, key) {
  const v = body?.[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} is required`);
  return v;
}

const ALLOWED_ORIGINS = new Set([
  'http://input.md',
  'https://input.md',
  'http://localhost:5173',
  'http://localhost:5174',
]);

function corsify(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

const server = http.createServer(async (req, res) => {
  try {
    corsify(req, res);
    if (req.method === 'OPTIONS') return res.end();

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/api/github-app/health') {
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/github-app/install-url' && req.method === 'GET') {
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
      // Verify installation exists by calling GitHub API
      const jwt = await createAppJwt();
      const ghRes = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}`, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${jwt}`,
          'User-Agent': 'input-github-app-auth-server',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!ghRes.ok) {
        return json(res, 403, { error: 'Invalid installation' });
      }
      const token = createSessionToken(installationId);
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
      const session = requireSession(req);
      const installationId = repoListMatch[1];
      if (session.installationId !== installationId) return json(res, 403, { error: 'Forbidden' });
      const allRepos = [];
      let page = 1;
      while (true) {
        const ghRes = await githubFetchWithInstallationToken(installationId, `/installation/repositories?per_page=100&page=${page}`);
        const data = await ghRes.json();
        allRepos.push(...(data.repositories ?? []));
        if (allRepos.length >= data.total_count || (data.repositories ?? []).length < 100) break;
        page++;
      }
      return json(res, 200, { total_count: allRepos.length, repositories: allRepos });
    }

    // Repo Contents API proxy (read)
    const contentsGetMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/);
    if (contentsGetMatch && req.method === 'GET') {
      const session = requireSession(req);
      const installationId = contentsGetMatch[1];
      if (session.installationId !== installationId) return json(res, 403, { error: 'Forbidden' });
      const owner = contentsGetMatch[2];
      const repo = contentsGetMatch[3];
      const pathParam = url.searchParams.get('path') ?? '';
      const ref = url.searchParams.get('ref');

      const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
      const ghUrl = ref ? `${ghPath}?ref=${encodeURIComponent(ref)}` : ghPath;
      const ghRes = await githubFetchWithInstallationToken(installationId, ghUrl);
      const data = await ghRes.json();
      return json(res, 200, data);
    }

    // Repo Contents API proxy (write/update)
    const contentsPutMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/);
    if (contentsPutMatch && req.method === 'PUT') {
      const session = requireSession(req);
      const installationId = contentsPutMatch[1];
      if (session.installationId !== installationId) return json(res, 403, { error: 'Forbidden' });
      const owner = contentsPutMatch[2];
      const repo = contentsPutMatch[3];
      const body = await readJson(req);

      const pathParam = requireString(body, 'path');
      const message = requireString(body, 'message');
      const content = requireString(body, 'content'); // base64
      const sha = typeof body?.sha === 'string' ? body.sha : undefined;
      const branch = typeof body?.branch === 'string' ? body.branch : undefined;

      const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
      const ghRes = await githubFetchWithInstallationToken(installationId, ghPath, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content, sha, branch }),
      });
      const data = await ghRes.json();
      return json(res, 200, data);
    }

    // Repo Contents API proxy (delete)
    const contentsDelMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/);
    if (contentsDelMatch && req.method === 'DELETE') {
      const session = requireSession(req);
      const installationId = contentsDelMatch[1];
      if (session.installationId !== installationId) return json(res, 403, { error: 'Forbidden' });
      const owner = contentsDelMatch[2];
      const repo = contentsDelMatch[3];
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
      const data = await ghRes.json();
      return json(res, 200, data);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    const safe = /^(Request body too large|Invalid JSON body|GitHub API error: \d+|\w+ is required)$/.test(msg);
    if (!safe) {
      // eslint-disable-next-line no-console
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
  // eslint-disable-next-line no-console
  console.log(`GitHub App auth server listening on http://localhost:${PORT} (configured=${configured})`);
});
