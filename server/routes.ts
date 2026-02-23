import type http from 'node:http';
import { APP_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_FETCH_TIMEOUT_MS, GITHUB_TOKEN } from './config';
import { ClientError } from './errors';
import { getGistCacheEntry, isFresh, markRevalidated, setGistCacheEntry } from './gist_cache';
import { createAppJwt, encodePathPreserveSlashes, githubFetchWithInstallationToken } from './github_client';
import { json, readJson, requireEnv, requireString } from './http_helpers';
import { checkRateLimit } from './rate_limit';
import {
  clearRememberedInstallationForUser,
  consumeOAuthState,
  createOAuthState,
  createSession,
  destroySession,
  getRememberedInstallationForUser,
  getSession,
  refreshSession,
  rememberInstallationForUser,
} from './session';
import type { Session } from './types';

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

type OAuthTokenResponse = {
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GitHubApiError = {
  message?: string;
};

function redirect(res: http.ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function requestBaseUrl(req: http.IncomingMessage): string {
  const proto = req.headers['x-forwarded-proto'];
  const scheme = typeof proto === 'string' ? proto.split(',')[0].trim() : 'http';
  const host = req.headers.host ?? 'localhost';
  return `${scheme}://${host}`;
}

function oauthBaseUrl(req: http.IncomingMessage): string {
  return APP_URL || requestBaseUrl(req);
}

function normalizeReturnTo(raw: string | null): string {
  if (!raw) return '/auth';
  // Only allow same-origin relative paths.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/auth';
  return raw;
}

function requireAuthSession(ctx: RouteContext): Session {
  const session = getSession(ctx.req);
  if (!session) throw new ClientError('Unauthorized', 401);
  return session;
}

function requireMatchedInstallation(ctx: RouteContext, session: Session, matchIndex: number): string {
  const installationId = ctx.match[matchIndex];
  if (!session.installationId || session.installationId !== installationId) {
    throw new ClientError('Forbidden', 403);
  }
  return installationId;
}

async function githubFetchWithUserToken(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${session.githubAccessToken}`,
    'User-Agent': 'input-github-app-auth-server',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.headers as Record<string, string>),
  };
  const ghRes = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  return ghRes;
}

async function proxyGitHubJson(
  ctx: RouteContext,
  session: Session,
  path: string,
  init: RequestInit = {},
): Promise<void> {
  const ghRes = await githubFetchWithUserToken(session, path, init);
  const data = (await ghRes.json().catch(() => null)) as unknown;
  if (!ghRes.ok) {
    const err = data as GitHubApiError | null;
    if (ghRes.status === 401) throw new ClientError('Unauthorized', 401);
    json(ctx.res, ghRes.status, { error: err?.message ?? 'GitHub API error' });
    return;
  }
  json(ctx.res, 200, data);
}

async function handleHealth(ctx: RouteContext): Promise<void> {
  json(ctx.res, 200, { ok: true });
}

async function handleAuthStart(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    json(ctx.res, 503, { error: 'GitHub OAuth is not configured' });
    return;
  }

  const returnTo = normalizeReturnTo(ctx.url.searchParams.get('return_to'));
  const state = createOAuthState(returnTo);
  const redirectUri = `${oauthBaseUrl(ctx.req)}/api/auth/github/callback`;
  console.log(`[auth] OAuth start: redirect_uri=${redirectUri}, return_to=${returnTo}`);
  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'gist read:user');
  authUrl.searchParams.set('state', state);
  redirect(ctx.res, authUrl.toString());
}

async function handleAuthCallback(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    json(ctx.res, 503, { error: 'GitHub OAuth is not configured' });
    return;
  }

  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  if (!code || !state) {
    json(ctx.res, 400, { error: 'Missing OAuth callback parameters' });
    return;
  }

  const returnTo = consumeOAuthState(state);
  if (!returnTo) {
    json(ctx.res, 400, { error: 'Invalid or expired OAuth state' });
    return;
  }

  const redirectUri = `${oauthBaseUrl(ctx.req)}/api/auth/github/callback`;
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      state,
    }),
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });

  const tokenData = (await tokenRes.json().catch(() => null)) as OAuthTokenResponse | null;
  if (!tokenRes.ok || !tokenData?.access_token) {
    json(ctx.res, 502, { error: tokenData?.error_description ?? tokenData?.error ?? 'Failed to exchange OAuth code' });
    return;
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (!userRes.ok) {
    json(ctx.res, 502, { error: 'Failed to fetch GitHub user profile' });
    return;
  }

  const ghUser = (await userRes.json()) as {
    id: number;
    login: string;
    avatar_url: string;
    name: string | null;
  };

  const session = createSession(ctx.res, {
    githubUserId: ghUser.id,
    githubAccessToken: tokenData.access_token,
    githubLogin: ghUser.login,
    githubAvatarUrl: ghUser.avatar_url,
    githubName: ghUser.name,
    installationId: getRememberedInstallationForUser(ghUser.id),
  });

  console.log(`[auth] Created session for ${ghUser.login} (id=${session.id.slice(0, 8)}…), redirecting to ${returnTo}`);
  redirect(ctx.res, returnTo);
}

async function handleAuthSession(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = getSession(ctx.req);
  if (!session) {
    const hasCookie = Boolean(ctx.req.headers.cookie?.includes('input_session_id'));
    console.log(`[auth] Session check: no valid session (cookie present=${hasCookie})`);
    json(ctx.res, 200, { authenticated: false });
    return;
  }
  refreshSession(session, ctx.res);
  json(ctx.res, 200, {
    authenticated: true,
    user: {
      login: session.githubLogin,
      avatar_url: session.githubAvatarUrl,
      name: session.githubName,
    },
    installationId: session.installationId,
  });
}

async function handleAuthLogout(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  // We only destroy the server-side session; the GitHub access token is not
  // revoked. It remains valid until GitHub's own expiry or the user revokes
  // it manually at https://github.com/settings/applications.
  destroySession(ctx.req, ctx.res);
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
  const session = requireAuthSession(ctx);
  const body = await readJson(ctx.req);
  const installationId = body?.installationId;
  if (!installationId || typeof installationId !== 'string') {
    json(ctx.res, 400, { error: 'installationId is required' });
    return;
  }

  const jwt = await createAppJwt();
  const ghRes = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });

  if (!ghRes.ok) {
    clearRememberedInstallationForUser(session.githubUserId);
    session.installationId = null;
    refreshSession(session, ctx.res);
    json(ctx.res, 403, { error: 'Invalid installation' });
    return;
  }

  session.installationId = installationId;
  rememberInstallationForUser(session.githubUserId, installationId);
  refreshSession(session, ctx.res);
  json(ctx.res, 200, { installationId });
}

async function handleDisconnectInstallation(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  session.installationId = null;
  clearRememberedInstallationForUser(session.githubUserId);
  refreshSession(session, ctx.res);
  json(ctx.res, 200, { ok: true });
}

async function handleGitHubUser(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  json(ctx.res, 200, {
    login: session.githubLogin,
    avatar_url: session.githubAvatarUrl,
    name: session.githubName,
  });
}

async function handleListGists(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const qs = new URLSearchParams();
  const page = ctx.url.searchParams.get('page') ?? '1';
  const perPage = ctx.url.searchParams.get('per_page') ?? '30';
  qs.set('page', page);
  qs.set('per_page', perPage);
  await proxyGitHubJson(ctx, session, `/gists?${qs.toString()}`);
}

async function handleGetAuthedGist(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  await proxyGitHubJson(ctx, session, `/gists/${encodeURIComponent(ctx.match[1])}`);
}

async function handleCreateGist(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const body = await readJson(ctx.req);
  await proxyGitHubJson(ctx, session, '/gists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function handlePatchGist(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const body = await readJson(ctx.req);
  await proxyGitHubJson(ctx, session, `/gists/${encodeURIComponent(ctx.match[1])}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function handleDeleteGist(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = requireAuthSession(ctx);
  const ghRes = await githubFetchWithUserToken(session, `/gists/${encodeURIComponent(ctx.match[1])}`, {
    method: 'DELETE',
  });
  if (!ghRes.ok) {
    const data = (await ghRes.json().catch(() => null)) as GitHubApiError | null;
    if (ghRes.status === 401) throw new ClientError('Unauthorized', 401);
    json(ctx.res, ghRes.status, { error: data?.message ?? 'GitHub API error' });
    return;
  }
  json(ctx.res, 200, { ok: true });
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
  const content = body?.content;
  if (typeof content !== 'string') throw new ClientError('content is required');
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

async function handleGetPublicGist(ctx: RouteContext): Promise<void> {
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
    Accept: 'application/vnd.github+json',
    'User-Agent': 'input-github-app-auth-server',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${GITHUB_TOKEN}`;
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
    console.error('Gist fetch failed:', err);
    throw new ClientError('Failed to load gist', 502);
  }
}

const CONTENTS_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/;

const routes: RouteDef[] = [
  { method: 'GET', pattern: /^\/api\/github-app\/health$/, handler: handleHealth },
  { method: 'GET', pattern: /^\/api\/auth\/github\/start$/, handler: handleAuthStart },
  { method: 'GET', pattern: /^\/api\/auth\/github\/callback$/, handler: handleAuthCallback },
  { method: 'GET', pattern: /^\/api\/auth\/session$/, handler: handleAuthSession },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, handler: handleAuthLogout },
  { method: 'GET', pattern: /^\/api\/github\/user$/, handler: handleGitHubUser },
  { method: 'GET', pattern: /^\/api\/github\/gists$/, handler: handleListGists },
  { method: 'POST', pattern: /^\/api\/github\/gists$/, handler: handleCreateGist },
  { method: 'GET', pattern: /^\/api\/github\/gists\/([a-f0-9]+)$/i, handler: handleGetAuthedGist },
  { method: 'PATCH', pattern: /^\/api\/github\/gists\/([a-f0-9]+)$/i, handler: handlePatchGist },
  { method: 'DELETE', pattern: /^\/api\/github\/gists\/([a-f0-9]+)$/i, handler: handleDeleteGist },
  { method: 'GET', pattern: /^\/api\/github-app\/install-url$/, handler: handleInstallUrl },
  { method: 'POST', pattern: /^\/api\/github-app\/sessions$/, handler: handleCreateSession },
  { method: 'POST', pattern: /^\/api\/github-app\/disconnect$/, handler: handleDisconnectInstallation },
  { method: 'GET', pattern: /^\/api\/github-app\/installations\/([^/]+)\/repositories$/, handler: handleListRepos },
  { method: 'GET', pattern: CONTENTS_PATTERN, handler: handleGetContents },
  { method: 'PUT', pattern: CONTENTS_PATTERN, handler: handlePutContents },
  { method: 'DELETE', pattern: CONTENTS_PATTERN, handler: handleDeleteContents },
  { method: 'GET', pattern: /^\/api\/gists\/([a-f0-9]+)$/i, handler: handleGetPublicGist },
];

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
      const hasMethodMatch = routes.some((r) => r.method === req.method && pathname.match(r.pattern));
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
