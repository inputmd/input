import http from 'node:http';
import { GITHUB_CLIENT_ID, GITHUB_FETCH_TIMEOUT_MS, GITHUB_TOKEN } from './config';
import { checkRateLimit } from './rate_limit';
import { createSessionToken, requireSession } from './session';
import { ClientError } from './errors';
import { json, readJson, requireEnv, requireString } from './http_helpers';
import { createAppJwt, encodePathPreserveSlashes, githubFetchWithInstallationToken } from './github_client';
import { getGistCacheEntry, isFresh, markRevalidated, setGistCacheEntry } from './gist_cache';

export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/github-app/health') {
    json(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/github-app/install-url' && req.method === 'GET') {
    if (!checkRateLimit(req, res)) return true;
    const slug = requireEnv('GITHUB_APP_SLUG');
    const state = url.searchParams.get('state');
    const installUrl = new URL(`https://github.com/apps/${slug}/installations/new`);
    if (state) installUrl.searchParams.set('state', state);
    json(res, 200, { url: installUrl.toString() });
    return true;
  }

  if (pathname === '/api/github-app/sessions' && req.method === 'POST') {
    if (!checkRateLimit(req, res)) return true;
    const body = await readJson(req);
    const installationId = body?.installationId;
    if (!installationId || typeof installationId !== 'string') {
      json(res, 400, { error: 'installationId is required' });
      return true;
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
      json(res, 403, { error: 'Invalid installation' });
      return true;
    }

    const token = createSessionToken(installationId);
    json(res, 200, { token, installationId });
    return true;
  }

  if (pathname.startsWith('/api/github-app/installations/')) {
    if (!checkRateLimit(req, res)) return true;
    const session = requireSession(req);
    if (!session) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
  }

  const repoListMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repositories$/);
  if (repoListMatch && req.method === 'GET') {
    const session = requireSession(req);
    if (!session) throw new ClientError('Unauthorized', 401);

    const installationId = repoListMatch[1];
    if (session.installationId !== installationId) {
      json(res, 403, { error: 'Forbidden' });
      return true;
    }

    const allRepos: unknown[] = [];
    const MAX_PAGES = 50;
    let page = 1;
    while (page <= MAX_PAGES) {
      const ghRes = await githubFetchWithInstallationToken(
        installationId,
        `/installation/repositories?per_page=100&page=${page}`,
      );
      const data = (await ghRes.json()) as { total_count: number; repositories?: unknown[] };
      allRepos.push(...(data.repositories ?? []));
      if (allRepos.length >= data.total_count || (data.repositories ?? []).length < 100) break;
      page++;
    }

    json(res, 200, { total_count: allRepos.length, repositories: allRepos });
    return true;
  }

  const contentsMatch = pathname.match(/^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/);
  if (contentsMatch) {
    const session = requireSession(req);
    if (!session) throw new ClientError('Unauthorized', 401);

    const installationId = contentsMatch[1];
    if (session.installationId !== installationId) {
      json(res, 403, { error: 'Forbidden' });
      return true;
    }

    const owner = contentsMatch[2];
    const repo = contentsMatch[3];

    if (req.method === 'GET') {
      const pathParam = url.searchParams.get('path') ?? '';
      const ref = url.searchParams.get('ref');
      const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
      const ghUrl = ref ? `${ghPath}?ref=${encodeURIComponent(ref)}` : ghPath;
      const ghRes = await githubFetchWithInstallationToken(installationId, ghUrl);
      json(res, 200, await ghRes.json());
      return true;
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
      json(res, 200, await ghRes.json());
      return true;
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
      json(res, 200, await ghRes.json());
      return true;
    }

    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const gistMatch = pathname.match(/^\/api\/gists\/([a-f0-9]+)$/i);
  if (gistMatch && req.method === 'GET') {
    if (!checkRateLimit(req, res)) return true;
    const gistId = gistMatch[1];
    const cached = getGistCacheEntry(gistId);
    const now = Date.now();

    if (cached && isFresh(cached, now)) {
      res.setHeader('X-Cache', 'hit');
      json(res, 200, cached.data);
      return true;
    }

    const ghHeaders: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (GITHUB_TOKEN) ghHeaders['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    if (cached?.etag) ghHeaders['If-None-Match'] = cached.etag;

    try {
      const ghRes = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
        headers: ghHeaders,
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });

      if (ghRes.status === 304 && cached) {
        markRevalidated(cached, now);
        res.setHeader('X-Cache', 'revalidated');
        json(res, 200, cached.data);
        return true;
      }

      if (!ghRes.ok) {
        if (cached) {
          res.setHeader('X-Cache', 'stale');
          json(res, 200, cached.data);
          return true;
        }
        json(res, ghRes.status === 404 ? 404 : 502, {
          error: ghRes.status === 404 ? 'Gist not found' : 'GitHub API error',
        });
        return true;
      }

      const data: unknown = await ghRes.json();
      const etag = ghRes.headers.get('etag');
      setGistCacheEntry(gistId, data, etag, now);

      res.setHeader('X-Cache', 'miss');
      json(res, 200, data);
      return true;
    } catch (err) {
      if (cached) {
        res.setHeader('X-Cache', 'stale');
        json(res, 200, cached.data);
        return true;
      }
      throw err;
    }
  }

  if (pathname === '/api/device-flow/code' && req.method === 'POST') {
    if (!checkRateLimit(req, res)) return true;
    if (!GITHUB_CLIENT_ID) {
      json(res, 503, { error: 'OAuth not configured' });
      return true;
    }

    const ghRes = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'gist' }),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });

    if (!ghRes.ok) {
      json(res, 502, { error: 'Failed to initiate device flow' });
      return true;
    }

    json(res, 200, await ghRes.json());
    return true;
  }

  if (pathname === '/api/device-flow/token' && req.method === 'POST') {
    if (!checkRateLimit(req, res)) return true;
    if (!GITHUB_CLIENT_ID) {
      json(res, 503, { error: 'OAuth not configured' });
      return true;
    }

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

    if (!ghRes.ok) {
      json(res, 502, { error: 'Failed to poll for token' });
      return true;
    }

    json(res, 200, await ghRes.json());
    return true;
  }

  return false;
}
