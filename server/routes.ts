import http from 'node:http';
import { GITHUB_CLIENT_ID, GITHUB_FETCH_TIMEOUT_MS, GITHUB_TOKEN } from './config';
import { checkRateLimit } from './rate_limit';
import { createSessionToken, requireSession } from './session';
import { ClientError } from './errors';
import { json, readJson, requireEnv, requireString } from './http_helpers';
import { createAppJwt, encodePathPreserveSlashes, githubFetchWithInstallationToken } from './github_client';
import { getGistCacheEntry, isFresh, markRevalidated, setGistCacheEntry } from './gist_cache';
import type { Session } from './types';

// --- Types ---

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  pathname: string;
  match: RegExpMatchArray;
}

type RouteHandler = (ctx: RouteContext) => Promise<void>;

interface RouteDef {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

// --- Auth helpers ---

function requireAuthSession(ctx: RouteContext): Session {
  const session = requireSession(ctx.req);
  if (!session) throw new ClientError('Unauthorized', 401);
  return session;
}

function requireMatchedInstallation(ctx: RouteContext, session: Session, matchIndex: number): string {
  const installationId = ctx.match[matchIndex];
  if (session.installationId !== installationId) {
    throw new ClientError('Forbidden', 403);
  }
  return installationId;
}

// --- Handlers ---

async function handleHealth(ctx: RouteContext): Promise<void> {
  json(ctx.res, 200, { ok: true });
}

async function handleInstallUrl(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const slug = requireEnv('GITHUB_APP_SLUG');
  const state = ctx.url.searchParams.get('state');
  const installUrl = new URL(`https://github.com/apps/${slug}/installations/new`);
  if (state) installUrl.searchParams.set('state', state);
  json(ctx.res, 200, { url: installUrl.toString() });
}

async function handleCreateSession(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const body = await readJson(ctx.req);
  const installationId = body?.installationId;
  if (!installationId || typeof installationId !== 'string') {
    json(ctx.res, 400, { error: 'installationId is required' });
    return;
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
    json(ctx.res, 403, { error: 'Invalid installation' });
    return;
  }

  const token = createSessionToken(installationId);
  json(ctx.res, 200, { token, installationId });
}

async function handleListRepos(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const installationId = requireMatchedInstallation(ctx, session, 1);

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

  json(ctx.res, 200, { total_count: allRepos.length, repositories: allRepos });
}

async function handleGetContents(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];

  const pathParam = ctx.url.searchParams.get('path') ?? '';
  const ref = ctx.url.searchParams.get('ref');
  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
  const ghUrl = ref ? `${ghPath}?ref=${encodeURIComponent(ref)}` : ghPath;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghUrl);
  json(ctx.res, 200, await ghRes.json());
}

async function handlePutContents(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];

  const body = await readJson(ctx.req);
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
  json(ctx.res, 200, await ghRes.json());
}

async function handleDeleteContents(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];

  const body = await readJson(ctx.req);
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
  json(ctx.res, 200, await ghRes.json());
}

async function handleGetGist(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const gistId = ctx.match[1];
  const cached = getGistCacheEntry(gistId);
  const now = Date.now();

  if (cached && isFresh(cached, now)) {
    ctx.res.setHeader('X-Cache', 'hit');
    json(ctx.res, 200, cached.data);
    return;
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
      ctx.res.setHeader('X-Cache', 'revalidated');
      json(ctx.res, 200, cached.data);
      return;
    }

    if (!ghRes.ok) {
      if (cached) {
        ctx.res.setHeader('X-Cache', 'stale');
        json(ctx.res, 200, cached.data);
        return;
      }
      json(ctx.res, ghRes.status === 404 ? 404 : 502, {
        error: ghRes.status === 404 ? 'Gist not found' : 'GitHub API error',
      });
      return;
    }

    const data: unknown = await ghRes.json();
    const etag = ghRes.headers.get('etag');
    setGistCacheEntry(gistId, data, etag, now);

    ctx.res.setHeader('X-Cache', 'miss');
    json(ctx.res, 200, data);
  } catch (err) {
    if (cached) {
      ctx.res.setHeader('X-Cache', 'stale');
      json(ctx.res, 200, cached.data);
      return;
    }
    throw err;
  }
}

async function handleDeviceFlowCode(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  if (!GITHUB_CLIENT_ID) {
    json(ctx.res, 503, { error: 'OAuth not configured' });
    return;
  }

  const ghRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'gist' }),
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });

  if (!ghRes.ok) {
    json(ctx.res, 502, { error: 'Failed to initiate device flow' });
    return;
  }

  json(ctx.res, 200, await ghRes.json());
}

async function handleDeviceFlowToken(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  if (!GITHUB_CLIENT_ID) {
    json(ctx.res, 503, { error: 'OAuth not configured' });
    return;
  }

  const body = await readJson(ctx.req);
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
    json(ctx.res, 502, { error: 'Failed to poll for token' });
    return;
  }

  json(ctx.res, 200, await ghRes.json());
}

// --- Route table ---

const CONTENTS_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/;

const routes: RouteDef[] = [
  { method: 'GET',    pattern: /^\/api\/github-app\/health$/,                                          handler: handleHealth },
  { method: 'GET',    pattern: /^\/api\/github-app\/install-url$/,                                     handler: handleInstallUrl },
  { method: 'POST',   pattern: /^\/api\/github-app\/sessions$/,                                        handler: handleCreateSession },
  { method: 'GET',    pattern: /^\/api\/github-app\/installations\/([^/]+)\/repositories$/,             handler: handleListRepos },
  { method: 'GET',    pattern: CONTENTS_PATTERN,                                                       handler: handleGetContents },
  { method: 'PUT',    pattern: CONTENTS_PATTERN,                                                       handler: handlePutContents },
  { method: 'DELETE', pattern: CONTENTS_PATTERN,                                                       handler: handleDeleteContents },
  { method: 'GET',    pattern: /^\/api\/gists\/([a-f0-9]+)$/i,                                         handler: handleGetGist },
  { method: 'POST',   pattern: /^\/api\/device-flow\/code$/,                                           handler: handleDeviceFlowCode },
  { method: 'POST',   pattern: /^\/api\/device-flow\/token$/,                                          handler: handleDeviceFlowToken },
];

// --- Dispatcher ---

export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
): Promise<boolean> {
  for (const route of routes) {
    const match = pathname.match(route.pattern);
    if (!match) continue;

    if (req.method !== route.method) {
      // Pattern matched but method didn't — check if any other route matches
      // the same pattern with the right method before returning 405.
      const hasMethodMatch = routes.some(
        r => r.method === req.method && pathname.match(r.pattern),
      );
      if (!hasMethodMatch) {
        json(res, 405, { error: 'Method not allowed' });
        return true;
      }
      continue;
    }

    await route.handler({ req, res, url, pathname, match });
    return true;
  }

  return false;
}
