import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { APP_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_FETCH_TIMEOUT_MS, GITHUB_TOKEN } from './config';
import { ClientError } from './errors';
import { getGistCacheEntry, isFresh, markRevalidated, setGistCacheEntry } from './gist_cache';
import { createAppJwt, encodePathPreserveSlashes, githubFetchWithInstallationToken } from './github_client';
import { requireEnv, requireString } from './http_helpers';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHono = Hono<any>;

type OAuthTokenResponse = {
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GitHubApiError = {
  message?: string;
};

function requestBaseUrl(c: Context): string {
  const proto = c.req.header('x-forwarded-proto');
  const scheme = proto ? proto.split(',')[0].trim() : 'http';
  const host = c.req.header('host') ?? 'localhost';
  return `${scheme}://${host}`;
}

function oauthBaseUrl(c: Context): string {
  return APP_URL || requestBaseUrl(c);
}

function normalizeReturnTo(raw: string | null | undefined): string {
  if (!raw) return '/auth';
  // Only allow same-origin relative paths.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/auth';
  return raw;
}

function requireAuthSession(c: Context): Session {
  const session = getSession(c);
  if (!session) throw new ClientError('Unauthorized', 401);
  return session;
}

function requireMatchedInstallation(c: Context, session: Session, paramName: string): string {
  const installationId = c.req.param(paramName);
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

async function proxyGitHubJson(c: Context, session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const ghRes = await githubFetchWithUserToken(session, path, init);
  const data = (await ghRes.json().catch(() => null)) as unknown;
  if (!ghRes.ok) {
    const err = data as GitHubApiError | null;
    if (ghRes.status === 401) throw new ClientError('Unauthorized', 401);
    return c.json({ error: err?.message ?? 'GitHub API error' }, ghRes.status as 400);
  }
  return c.json(data, 200);
}

const jsonBodyLimit = bodyLimit({ maxSize: 1024 * 1024 });

export function registerHealthRoute(app: AnyHono): void {
  app.get('/api/github-app/health', (c) => {
    return c.json({ ok: true }, 200);
  });
}

export function registerApiRoutes(app: AnyHono): void {
  app.get('/api/auth/github/start', (c) => {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      return c.json({ error: 'GitHub OAuth is not configured' }, 503);
    }

    const returnTo = normalizeReturnTo(c.req.query('return_to'));
    const state = createOAuthState(returnTo);
    const redirectUri = `${oauthBaseUrl(c)}/api/auth/github/callback`;
    console.log(`[auth] OAuth start: redirect_uri=${redirectUri}, return_to=${returnTo}`);
    const authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'gist read:user');
    authUrl.searchParams.set('state', state);
    return c.redirect(authUrl.toString(), 302);
  });

  app.get('/api/auth/github/callback', async (c) => {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      return c.json({ error: 'GitHub OAuth is not configured' }, 503);
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return c.json({ error: 'Missing OAuth callback parameters' }, 400);
    }

    const returnTo = consumeOAuthState(state);
    if (!returnTo) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }

    const redirectUri = `${oauthBaseUrl(c)}/api/auth/github/callback`;
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
      return c.json(
        { error: tokenData?.error_description ?? tokenData?.error ?? 'Failed to exchange OAuth code' },
        502,
      );
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
      return c.json({ error: 'Failed to fetch GitHub user profile' }, 502);
    }

    const ghUser = (await userRes.json()) as {
      id: number;
      login: string;
      avatar_url: string;
      name: string | null;
    };

    const session = createSession(c, {
      githubUserId: ghUser.id,
      githubAccessToken: tokenData.access_token,
      githubLogin: ghUser.login,
      githubAvatarUrl: ghUser.avatar_url,
      githubName: ghUser.name,
      installationId: getRememberedInstallationForUser(ghUser.id),
    });

    console.log(
      `[auth] Created session for ${ghUser.login} (id=${session.id.slice(0, 8)}…), redirecting to ${returnTo}`,
    );
    return c.redirect(returnTo, 302);
  });

  app.get('/api/auth/session', (c) => {
    const session = getSession(c);
    if (!session) {
      const hasCookie = Boolean(c.req.header('cookie')?.includes('input_session_id'));
      console.log(`[auth] Session check: no valid session (cookie present=${hasCookie})`);
      return c.json({ authenticated: false }, 200);
    }
    refreshSession(session, c);
    return c.json(
      {
        authenticated: true,
        user: {
          login: session.githubLogin,
          avatar_url: session.githubAvatarUrl,
          name: session.githubName,
        },
        installationId: session.installationId,
      },
      200,
    );
  });

  app.post('/api/auth/logout', (c) => {
    destroySession(c);
    return c.json({ ok: true }, 200);
  });

  app.get('/api/github-app/install-url', (c) => {
    const slug = requireEnv('GITHUB_APP_SLUG');
    const state = c.req.query('state');
    const installUrl = new URL(`https://github.com/apps/${slug}/installations/new`);
    if (state) installUrl.searchParams.set('state', state);
    return c.json({ url: installUrl.toString() }, 200);
  });

  app.post('/api/github-app/sessions', jsonBodyLimit, async (c) => {
    const session = requireAuthSession(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const installationId = body?.installationId;
    if (!installationId || typeof installationId !== 'string') {
      return c.json({ error: 'installationId is required' }, 400);
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
      refreshSession(session, c);
      return c.json({ error: 'Invalid installation' }, 403);
    }

    session.installationId = installationId;
    rememberInstallationForUser(session.githubUserId, installationId);
    refreshSession(session, c);
    return c.json({ installationId }, 200);
  });

  app.post('/api/github-app/disconnect', (c) => {
    const session = requireAuthSession(c);
    session.installationId = null;
    clearRememberedInstallationForUser(session.githubUserId);
    refreshSession(session, c);
    return c.json({ ok: true }, 200);
  });

  app.get('/api/github/user', (c) => {
    const session = requireAuthSession(c);
    return c.json(
      {
        login: session.githubLogin,
        avatar_url: session.githubAvatarUrl,
        name: session.githubName,
      },
      200,
    );
  });

  app.get('/api/github/gists', async (c) => {
    const session = requireAuthSession(c);
    const qs = new URLSearchParams();
    const page = c.req.query('page') ?? '1';
    const perPage = c.req.query('per_page') ?? '30';
    qs.set('page', page);
    qs.set('per_page', perPage);
    return proxyGitHubJson(c, session, `/gists?${qs.toString()}`);
  });

  app.post('/api/github/gists', jsonBodyLimit, async (c) => {
    const session = requireAuthSession(c);
    const body = await c.req.json().catch(() => null);
    return proxyGitHubJson(c, session, '/gists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  });

  app.get('/api/github/gists/:gistId', async (c) => {
    const session = requireAuthSession(c);
    return proxyGitHubJson(c, session, `/gists/${encodeURIComponent(c.req.param('gistId'))}`);
  });

  app.patch('/api/github/gists/:gistId', jsonBodyLimit, async (c) => {
    const session = requireAuthSession(c);
    const body = await c.req.json().catch(() => null);
    return proxyGitHubJson(c, session, `/gists/${encodeURIComponent(c.req.param('gistId'))}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  });

  app.delete('/api/github/gists/:gistId', async (c) => {
    const session = requireAuthSession(c);
    const ghRes = await githubFetchWithUserToken(session, `/gists/${encodeURIComponent(c.req.param('gistId'))}`, {
      method: 'DELETE',
    });
    if (!ghRes.ok) {
      const data = (await ghRes.json().catch(() => null)) as GitHubApiError | null;
      if (ghRes.status === 401) throw new ClientError('Unauthorized', 401);
      return c.json({ error: data?.message ?? 'GitHub API error' }, ghRes.status as 400);
    }
    return c.json({ ok: true }, 200);
  });

  app.get('/api/github-app/installations/:installationId/repositories', async (c) => {
    const session = requireAuthSession(c);
    const installationId = requireMatchedInstallation(c, session, 'installationId');

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

    return c.json({ total_count: allRepos.length, repositories: allRepos }, 200);
  });

  app.get('/api/github-app/installations/:installationId/repos/:owner/:repo/contents', async (c) => {
    const session = requireAuthSession(c);
    const installationId = requireMatchedInstallation(c, session, 'installationId');
    const owner = c.req.param('owner');
    const repo = c.req.param('repo');

    const pathParam = c.req.query('path') ?? '';
    const ref = c.req.query('ref');
    const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
    const ghUrl = ref ? `${ghPath}?ref=${encodeURIComponent(ref)}` : ghPath;
    const ghRes = await githubFetchWithInstallationToken(installationId, ghUrl);
    return c.json(await ghRes.json(), 200);
  });

  app.put('/api/github-app/installations/:installationId/repos/:owner/:repo/contents', jsonBodyLimit, async (c) => {
    const session = requireAuthSession(c);
    const installationId = requireMatchedInstallation(c, session, 'installationId');
    const owner = c.req.param('owner');
    const repo = c.req.param('repo');

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
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
    return c.json(await ghRes.json(), 200);
  });

  app.delete('/api/github-app/installations/:installationId/repos/:owner/:repo/contents', jsonBodyLimit, async (c) => {
    const session = requireAuthSession(c);
    const installationId = requireMatchedInstallation(c, session, 'installationId');
    const owner = c.req.param('owner');
    const repo = c.req.param('repo');

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
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
    return c.json(await ghRes.json(), 200);
  });

  app.get('/api/gists/:gistId', async (c) => {
    const gistId = c.req.param('gistId');
    const cached = getGistCacheEntry(gistId);
    const now = Date.now();

    if (cached && isFresh(cached, now)) {
      c.header('X-Cache', 'hit');
      return c.json(cached.data, 200);
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
        c.header('X-Cache', 'revalidated');
        return c.json(cached.data, 200);
      }

      if (!ghRes.ok) {
        if (cached) {
          c.header('X-Cache', 'stale');
          return c.json(cached.data, 200);
        }
        return c.json(
          { error: ghRes.status === 404 ? 'Gist not found' : 'GitHub API error' },
          ghRes.status === 404 ? 404 : 502,
        );
      }

      const data: unknown = await ghRes.json();
      const etag = ghRes.headers.get('etag');
      setGistCacheEntry(gistId, data, etag, now);
      c.header('X-Cache', 'miss');
      return c.json(data, 200);
    } catch (err) {
      if (cached) {
        c.header('X-Cache', 'stale');
        return c.json(cached.data, 200);
      }
      console.error('Gist fetch failed:', err);
      throw new ClientError('Failed to load gist', 502);
    }
  });
}
