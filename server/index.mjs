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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  return JSON.parse(raw);
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
    throw new Error(`Failed to mint installation token: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
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
    throw new Error(`${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
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

function corsify(req, res) {
  const origin = req.headers.origin ?? '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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

    if (pathname === '/api/github-app/debug/installation-token' && req.method === 'POST') {
      const body = await readJson(req);
      const installationId = body?.installationId;
      const repositoryIds = body?.repositoryIds;
      if (!installationId) return json(res, 400, { error: 'installationId is required' });
      const token = await getInstallationToken(installationId, repositoryIds);
      return json(res, 200, token);
    }

    const repoListMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repositories$/);
    if (repoListMatch && req.method === 'GET') {
      const installationId = repoListMatch[1];
      const ghRes = await githubFetchWithInstallationToken(installationId, '/installation/repositories');
      const data = await ghRes.json();
      return json(res, 200, data);
    }

    // Repo Contents API proxy (read)
    const contentsGetMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/);
    if (contentsGetMatch && req.method === 'GET') {
      const installationId = contentsGetMatch[1];
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
      const installationId = contentsPutMatch[1];
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
      const installationId = contentsDelMatch[1];
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
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return json(res, 500, { error: msg });
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
