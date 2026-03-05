import type http from 'node:http';
import {
  APP_URL,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_FETCH_TIMEOUT_MS,
  GITHUB_TOKEN,
  OPENROUTER_API_KEY,
  READER_AI_TIMEOUT_MS,
  SHARE_TOKEN_SECRET,
  SHARE_TOKEN_TTL_SECONDS,
} from './config';
import { ClientError } from './errors';
import { getGistCacheEntry, isFresh, markRevalidated, setGistCacheEntry } from './gist_cache';
import { createAppJwt, encodePathPreserveSlashes, githubFetchWithInstallationToken } from './github_client';
import { json, readJson, requireEnv, requireString } from './http_helpers';
import { checkRateLimit, checkRateLimitAuthenticated } from './rate_limit';
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
import { createRepoFileShareToken, verifyRepoFileShareToken } from './share_tokens';
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

interface GitHubRateLimitInfo {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  reset: number | null;
  resetAt: string | null;
  resource: string | null;
  retryAfterSeconds: number | null;
}

interface GitHubErrorInfo {
  status: number;
  requestId: string | null;
  isRateLimited: boolean;
  isBadCredentials: boolean;
  rateLimit: GitHubRateLimitInfo;
}

interface ShareRepoFileCreateBody {
  installationId?: unknown;
  repoFullName?: unknown;
  path?: unknown;
}

interface ReaderAiModelEntry {
  id: string;
  name: string;
}

interface ReaderAiChatBody {
  model?: unknown;
  source?: unknown;
  messages?: unknown;
}

interface ReaderAiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }>;
}

const SHARE_LINKS_NOT_CONFIGURED_ERROR = {
  error: 'Private sharing is unavailable: SHARE_TOKEN_SECRET is not configured on the server',
  code: 'share_links_not_configured',
} as const;

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

function splitRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) throw new ClientError('Invalid repoFullName', 400);
  return { owner, repo };
}

function requireAuthSession(ctx: RouteContext): Session {
  const session = getSession(ctx.req);
  if (!session) throw new ClientError('Unauthorized', 401);
  return session;
}

function checkRateLimitForSession(ctx: RouteContext, session: Session | null): boolean {
  if (session) {
    return checkRateLimitAuthenticated(ctx.req, ctx.res, session.githubUserId);
  }
  return checkRateLimit(ctx.req, ctx.res);
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
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', path);
    return;
  }
  json(ctx.res, 200, data);
}

function readHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function githubErrorInfo(ghRes: Response, message: string): GitHubErrorInfo {
  const limit = readHeaderInt(ghRes.headers, 'x-ratelimit-limit');
  const remaining = readHeaderInt(ghRes.headers, 'x-ratelimit-remaining');
  const used = readHeaderInt(ghRes.headers, 'x-ratelimit-used');
  const reset = readHeaderInt(ghRes.headers, 'x-ratelimit-reset');
  const resource = ghRes.headers.get('x-ratelimit-resource');
  const retryAfterSeconds = readHeaderInt(ghRes.headers, 'retry-after');
  const requestId = ghRes.headers.get('x-github-request-id');
  const isRateLimited =
    ghRes.status === 429 ||
    /rate limit|secondary rate limit|abuse/i.test(message) ||
    ((remaining ?? 1) <= 0 && ghRes.status >= 400);

  return {
    status: ghRes.status,
    requestId,
    isRateLimited,
    isBadCredentials: ghRes.status === 401 && /bad credentials/i.test(message),
    rateLimit: {
      limit,
      remaining,
      used,
      reset,
      resetAt: reset ? new Date(reset * 1000).toISOString() : null,
      resource,
      retryAfterSeconds,
    },
  };
}

function respondGitHubError(res: http.ServerResponse, ghRes: Response, fallbackMessage: string, source: string): void {
  const message = fallbackMessage || 'GitHub API error';
  const info = githubErrorInfo(ghRes, message);
  const rate = info.rateLimit;
  console.warn(
    `[github] ${source} -> ${info.status} "${message}" request_id=${info.requestId ?? '-'} rate_limited=${info.isRateLimited} remaining=${rate.remaining ?? '-'} reset=${rate.resetAt ?? '-'} retry_after=${rate.retryAfterSeconds ?? '-'}`,
  );
  json(res, ghRes.status, { error: message, github: info });
}

async function readGitHubErrorMessage(ghRes: Response, fallback = 'GitHub API error'): Promise<string> {
  const text = await ghRes.text().catch(() => '');
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as GitHubApiError;
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    return message || fallback;
  } catch {
    const trimmed = text.trim();
    return trimmed || fallback;
  }
}

const READER_AI_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const READER_AI_MAX_SOURCE_CHARS = 140_000;
const READER_AI_MAX_MESSAGES = 24;
const READER_AI_MAX_MESSAGE_CHARS = 16_000;
const READER_AI_MIN_MODEL_PARAMS_B = 15;
let readerAiModelsCache: { value: ReaderAiModelEntry[]; expiresAt: number } | null = null;

function modelParamsEstimateBillions(entry: { id?: unknown; name?: unknown; description?: unknown }): number | null {
  const text = [
    typeof entry.name === 'string' ? entry.name : '',
    typeof entry.id === 'string' ? entry.id : '',
    typeof entry.description === 'string' ? entry.description : '',
  ]
    .join(' ')
    .toLowerCase();
  if (!text) return null;

  let best = 0;
  const mixtureMatches = text.matchAll(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/g);
  for (const match of mixtureMatches) {
    const experts = Number(match[1]);
    const perExpert = Number(match[2]);
    if (!Number.isFinite(experts) || !Number.isFinite(perExpert)) continue;
    best = Math.max(best, experts * perExpert);
  }

  const billionMatches = text.matchAll(/(\d+(?:\.\d+)?)\s*b\b/g);
  for (const match of billionMatches) {
    const billions = Number(match[1]);
    if (!Number.isFinite(billions)) continue;
    best = Math.max(best, billions);
  }

  const millionMatches = text.matchAll(/(\d+(?:\.\d+)?)\s*m\b/g);
  for (const match of millionMatches) {
    const millions = Number(match[1]);
    if (!Number.isFinite(millions)) continue;
    best = Math.max(best, millions / 1000);
  }

  return best > 0 ? best : null;
}

function ensureOpenRouterConfigured(): void {
  if (!OPENROUTER_API_KEY) {
    throw new ClientError('Reader AI is not configured on this server', 503);
  }
}

function normalizeReaderAiMessages(raw: unknown): ReaderAiChatMessage[] {
  if (!Array.isArray(raw)) throw new ClientError('messages must be an array', 400);
  if (raw.length === 0) throw new ClientError('messages cannot be empty', 400);
  if (raw.length > READER_AI_MAX_MESSAGES) throw new ClientError('Too many messages', 400);
  const messages: ReaderAiChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new ClientError('Invalid message payload', 400);
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      throw new ClientError('Invalid message payload', 400);
    }
    const trimmed = content.trim();
    if (!trimmed) throw new ClientError('Message content cannot be empty', 400);
    messages.push({
      role,
      content: trimmed.slice(0, READER_AI_MAX_MESSAGE_CHARS),
    });
  }
  return messages;
}

async function fetchReaderAiModels(req: http.IncomingMessage): Promise<ReaderAiModelEntry[]> {
  const now = Date.now();
  if (readerAiModelsCache && readerAiModelsCache.expiresAt > now) return readerAiModelsCache.value;

  const upstream = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_URL || requestBaseUrl(req),
      'X-Title': 'Input Reader AI',
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });

  const payload = (await upstream.json().catch(() => null)) as OpenRouterModelsResponse | null;
  if (!upstream.ok) {
    const message = `OpenRouter model listing failed (${upstream.status})`;
    throw new ClientError(message, 502);
  }

  const data = Array.isArray(payload?.data) ? payload.data : [];
  const models = data
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : '';
      const name = typeof entry.name === 'string' ? entry.name : id;
      if (!id.endsWith(':free')) return null;
      const paramsBillions = modelParamsEstimateBillions(entry);
      if (paramsBillions === null || paramsBillions < READER_AI_MIN_MODEL_PARAMS_B) return null;
      return { id, name };
    })
    .filter((entry): entry is ReaderAiModelEntry => Boolean(entry))
    .sort((a, b) => a.name.localeCompare(b.name));

  readerAiModelsCache = { value: models, expiresAt: now + READER_AI_MODELS_CACHE_TTL_MS };
  return models;
}

async function fetchPublicGitHub(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'input-github-app-auth-server',
    'X-GitHub-Api-Version': '2022-11-28',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
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
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
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
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  session.installationId = null;
  clearRememberedInstallationForUser(session.githubUserId);
  refreshSession(session, ctx.res);
  json(ctx.res, 200, { ok: true });
}

async function handleGitHubUser(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  json(ctx.res, 200, {
    login: session.githubLogin,
    avatar_url: session.githubAvatarUrl,
    name: session.githubName,
  });
}

async function handleListGists(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const qs = new URLSearchParams();
  const page = ctx.url.searchParams.get('page') ?? '1';
  const perPage = ctx.url.searchParams.get('per_page') ?? '30';
  qs.set('page', page);
  qs.set('per_page', perPage);
  await proxyGitHubJson(ctx, session, `/gists?${qs.toString()}`);
}

async function handleGetAuthedGist(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  await proxyGitHubJson(ctx, session, `/gists/${encodeURIComponent(ctx.match[1])}`);
}

async function handleCreateGist(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const body = await readJson(ctx.req);
  await proxyGitHubJson(ctx, session, '/gists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function handlePatchGist(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const body = await readJson(ctx.req);
  await proxyGitHubJson(ctx, session, `/gists/${encodeURIComponent(ctx.match[1])}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function handleDeleteGist(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const ghRes = await githubFetchWithUserToken(session, `/gists/${encodeURIComponent(ctx.match[1])}`, {
    method: 'DELETE',
  });
  if (!ghRes.ok) {
    const data = (await ghRes.json().catch(() => null)) as GitHubApiError | null;
    if (ghRes.status === 401) throw new ClientError('Unauthorized', 401);
    respondGitHubError(
      ctx.res,
      ghRes,
      data?.message ?? 'GitHub API error',
      `/gists/${encodeURIComponent(ctx.match[1])} [DELETE]`,
    );
    return;
  }
  json(ctx.res, 200, { ok: true });
}

async function handleListRepos(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
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
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];

  const pathParam = ctx.url.searchParams.get('path') ?? '';
  const ref = ctx.url.searchParams.get('ref');
  const encodedPath = encodePathPreserveSlashes(pathParam);
  const ghPath = encodedPath
    ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`
    : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
  const ghUrl = ref ? `${ghPath}?ref=${encodeURIComponent(ref)}` : ghPath;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghUrl);
  const data = (await ghRes.json().catch(() => null)) as unknown;
  if (!ghRes.ok) {
    const err = data as GitHubApiError | null;
    if (ghRes.status === 401) throw new ClientError('Unauthorized', 401);
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghUrl);
    return;
  }
  json(ctx.res, 200, data);
}

async function handlePutContents(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
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
  if (!ghRes.ok) {
    const err = (await ghRes.json().catch(() => null)) as GitHubApiError | null;
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }
  json(ctx.res, 200, await ghRes.json());
}

async function handleDeleteContents(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
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
  if (!ghRes.ok) {
    const err = (await ghRes.json().catch(() => null)) as GitHubApiError | null;
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }
  json(ctx.res, 200, await ghRes.json());
}

async function handleCreateRepoFileShare(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  if (!SHARE_TOKEN_SECRET) {
    json(ctx.res, 503, SHARE_LINKS_NOT_CONFIGURED_ERROR);
    return;
  }
  const body = (await readJson(ctx.req)) as ShareRepoFileCreateBody | null;
  const installationId = typeof body?.installationId === 'string' ? body.installationId : '';
  const repoFullName = typeof body?.repoFullName === 'string' ? body.repoFullName : '';
  const pathParam = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!installationId || !repoFullName || !pathParam)
    throw new ClientError('installationId, repoFullName, and path are required', 400);
  if (!pathParam.toLowerCase().endsWith('.md')) throw new ClientError('Only markdown files can be shared', 400);
  if (!session.installationId || session.installationId !== installationId) throw new ClientError('Forbidden', 403);

  const { owner, repo } = splitRepoFullName(repoFullName);
  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghPath);
  const data = (await ghRes.json().catch(() => null)) as {
    type?: string;
    path?: string;
    sha?: string;
    name?: string;
    content?: string;
    encoding?: string;
  } | null;
  if (!data || data.type !== 'file' || typeof data.sha !== 'string' || typeof data.path !== 'string') {
    throw new ClientError('Expected a file', 400);
  }
  if (!data.path.toLowerCase().endsWith('.md')) throw new ClientError('Only markdown files can be shared', 400);

  const token = createRepoFileShareToken(SHARE_TOKEN_SECRET, {
    installationId,
    owner,
    repo,
    path: data.path,
    nowMs: Date.now(),
    ttlSeconds: SHARE_TOKEN_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + SHARE_TOKEN_TTL_SECONDS * 1000).toISOString();
  json(ctx.res, 200, {
    token,
    url: `${requestBaseUrl(ctx.req)}/s/${encodeURIComponent(token)}`,
    expiresAt,
  });
}

async function handleGetSharedRepoFile(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  if (!SHARE_TOKEN_SECRET) {
    json(ctx.res, 503, SHARE_LINKS_NOT_CONFIGURED_ERROR);
    return;
  }

  const token = decodeURIComponent(ctx.match[1]);
  const payload = verifyRepoFileShareToken(SHARE_TOKEN_SECRET, token, Date.now());
  if (!payload) {
    json(ctx.res, 401, { error: 'Invalid or expired share token' });
    return;
  }

  const ghPath = `/repos/${encodeURIComponent(payload.owner)}/${encodeURIComponent(payload.repo)}/contents/${encodePathPreserveSlashes(payload.path)}`;
  const ghRes = await githubFetchWithInstallationToken(payload.installationId, ghPath);
  const data = (await ghRes.json().catch(() => null)) as {
    type?: string;
    path?: string;
    sha?: string;
    name?: string;
    content?: string;
    encoding?: string;
  } | null;
  if (!data || data.type !== 'file' || typeof data.sha !== 'string' || typeof data.path !== 'string') {
    throw new ClientError('Expected a file', 400);
  }
  if (!data.path.toLowerCase().endsWith('.md')) {
    json(ctx.res, 410, { error: 'Shared file is no longer a markdown file' });
    return;
  }
  if (typeof data.content !== 'string' || data.encoding !== 'base64') {
    throw new ClientError('Unexpected file payload from GitHub', 502);
  }

  json(ctx.res, 200, {
    owner: payload.owner,
    repo: payload.repo,
    path: data.path,
    name: data.name ?? data.path.split('/').pop() ?? data.path,
    sha: data.sha,
    content: data.content,
    encoding: data.encoding,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  });
}

async function handleGetRawContent(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];
  const pathParam = ctx.url.searchParams.get('path');
  if (!pathParam) throw new ClientError('path is required');

  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghPath, {
    headers: { Accept: 'application/vnd.github.raw' },
  });

  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Type', ghRes.headers.get('content-type') ?? 'application/octet-stream');
  ctx.res.setHeader('Cache-Control', 'private, max-age=300');
  const body = Buffer.from(await ghRes.arrayBuffer());
  ctx.res.end(body);
}

async function handleGetPublicRepoContents(ctx: RouteContext): Promise<void> {
  if (!checkRateLimitForSession(ctx, getSession(ctx.req))) return;
  const owner = decodeURIComponent(ctx.match[1]);
  const repo = decodeURIComponent(ctx.match[2]);
  const pathParam = ctx.url.searchParams.get('path') ?? '';
  const ref = ctx.url.searchParams.get('ref');
  const encodedPath = encodePathPreserveSlashes(pathParam);
  const ghPath = encodedPath
    ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`
    : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
  const ghUrl = ref ? `${ghPath}?ref=${encodeURIComponent(ref)}` : ghPath;
  const ghRes = await fetchPublicGitHub(ghUrl);
  const data = (await ghRes.json().catch(() => null)) as GitHubApiError | unknown;
  if (!ghRes.ok) {
    const err = data as GitHubApiError | null;
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghUrl);
    return;
  }
  json(ctx.res, 200, data);
}

async function handleGetPublicRepoRaw(ctx: RouteContext): Promise<void> {
  if (!checkRateLimitForSession(ctx, getSession(ctx.req))) return;
  const owner = decodeURIComponent(ctx.match[1]);
  const repo = decodeURIComponent(ctx.match[2]);
  const pathParam = ctx.url.searchParams.get('path');
  if (!pathParam) throw new ClientError('path is required');

  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
  const ghRes = await fetchPublicGitHub(ghPath, {
    headers: { Accept: 'application/vnd.github.raw' },
  });
  if (!ghRes.ok) {
    const text = await ghRes.text().catch(() => '');
    let message = 'GitHub API error';
    if (text) {
      try {
        const parsed = JSON.parse(text) as GitHubApiError;
        message = parsed.message ?? message;
      } catch {
        message = text;
      }
    }
    respondGitHubError(ctx.res, ghRes, message, ghPath);
    return;
  }

  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Type', ghRes.headers.get('content-type') ?? 'application/octet-stream');
  ctx.res.setHeader('Cache-Control', 'public, max-age=300');
  const body = Buffer.from(await ghRes.arrayBuffer());
  ctx.res.end(body);
}

type GitTreeEntry = { path: string; type: string; sha: string; size?: number };

function filesFromTree(
  tree: GitTreeEntry[],
  markdownOnly: boolean,
): { name: string; path: string; sha: string; size?: number }[] {
  const files: { name: string; path: string; sha: string; size?: number }[] = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (markdownOnly && !entry.path.toLowerCase().endsWith('.md')) continue;
    const slash = entry.path.lastIndexOf('/');
    files.push({
      name: slash === -1 ? entry.path : entry.path.slice(slash + 1),
      path: entry.path,
      sha: entry.sha,
      size: typeof entry.size === 'number' ? entry.size : undefined,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function markdownOnlyTreeQuery(url: URL): boolean {
  const raw = url.searchParams.get('markdown_only');
  if (!raw) return true;
  const value = raw.toLowerCase();
  return !(value === '0' || value === 'false' || value === 'no');
}

async function handleGetTree(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];
  const ref = ctx.url.searchParams.get('ref') || 'HEAD';
  const markdownOnly = markdownOnlyTreeQuery(ctx.url);

  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghPath);
  const data = (await ghRes.json()) as { tree: GitTreeEntry[]; truncated: boolean };
  json(ctx.res, 200, { files: filesFromTree(data.tree, markdownOnly), truncated: data.truncated });
}

async function handleGetPublicTree(ctx: RouteContext): Promise<void> {
  if (!checkRateLimitForSession(ctx, getSession(ctx.req))) return;
  const owner = decodeURIComponent(ctx.match[1]);
  const repo = decodeURIComponent(ctx.match[2]);
  const ref = ctx.url.searchParams.get('ref') || 'HEAD';
  const markdownOnly = markdownOnlyTreeQuery(ctx.url);

  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const ghRes = await fetchPublicGitHub(ghPath);
  const data = (await ghRes.json().catch(() => null)) as {
    tree?: GitTreeEntry[];
    truncated?: boolean;
    message?: string;
  } | null;
  if (!ghRes.ok) {
    const err = data as GitHubApiError | null;
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }
  json(ctx.res, 200, { files: filesFromTree(data?.tree ?? [], markdownOnly), truncated: data?.truncated ?? false });
}

async function handleGetPublicGist(ctx: RouteContext): Promise<void> {
  const session = getSession(ctx.req);
  if (!checkRateLimitForSession(ctx, session)) return;
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
      const message = await readGitHubErrorMessage(ghRes, 'GitHub API error');
      respondGitHubError(ctx.res, ghRes, message, `/gists/${encodeURIComponent(gistId)} [public]`);
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

async function handleReaderAiModels(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  ensureOpenRouterConfigured();
  const models = await fetchReaderAiModels(ctx.req);
  json(ctx.res, 200, { models });
}

async function handleReaderAiChat(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  ensureOpenRouterConfigured();

  const body = (await readJson(ctx.req)) as ReaderAiChatBody | null;
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  const source = typeof body?.source === 'string' ? body.source.trim() : '';
  if (!model) throw new ClientError('model is required', 400);
  if (!source) throw new ClientError('source is required', 400);
  const messages = normalizeReaderAiMessages(body?.messages);

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_URL || requestBaseUrl(ctx.req),
        'X-Title': 'Input Reader AI',
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Answer questions about the provided markdown document. Cite specific details from the document when possible. If the document lacks the answer, say so plainly.',
          },
          {
            role: 'user',
            content: `Markdown document:\n\n${source.slice(-READER_AI_MAX_SOURCE_CHARS)}`,
          },
          ...messages,
        ],
      }),
      signal: AbortSignal.timeout(READER_AI_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      const payload = (await upstream.json().catch(() => null)) as unknown;
      const fallback = `OpenRouter request failed (${upstream.status})`;
      const errorObj =
        payload && typeof payload === 'object' && 'error' in payload ? (payload as { error?: unknown }).error : null;
      const upstreamError =
        errorObj && typeof errorObj === 'object' ? (errorObj as { message?: unknown }).message : null;
      throw new ClientError(typeof upstreamError === 'string' && upstreamError ? upstreamError : fallback, 502);
    }

    if (!upstream.body) {
      throw new ClientError('OpenRouter did not return a stream', 502);
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    ctx.res.setHeader('Cache-Control', 'no-cache');
    ctx.res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) ctx.res.write(Buffer.from(value));
      }
    } finally {
      if (!ctx.res.writableEnded) ctx.res.end();
    }
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      if (!ctx.res.headersSent) throw new ClientError('Reader AI request timed out', 504);
      if (!ctx.res.writableEnded) ctx.res.end();
      return;
    }
    if (ctx.res.headersSent) {
      console.warn('Reader AI stream failed after response start:', err);
      if (!ctx.res.writableEnded) ctx.res.end();
      return;
    }
    throw err;
  }
}

const CONTENTS_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/;
const RAW_CONTENT_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/raw$/;
const TREE_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/tree$/;
const PUBLIC_REPO_CONTENTS_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/contents$/;
const PUBLIC_REPO_RAW_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/raw$/;
const PUBLIC_REPO_TREE_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/tree$/;
const SHARE_REPO_FILE_PATTERN = /^\/api\/share\/repo-file\/([^/]+)$/;

const routes: RouteDef[] = [
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
  { method: 'POST', pattern: /^\/api\/share\/repo-file$/, handler: handleCreateRepoFileShare },
  { method: 'GET', pattern: SHARE_REPO_FILE_PATTERN, handler: handleGetSharedRepoFile },
  { method: 'GET', pattern: /^\/api\/github-app\/installations\/([^/]+)\/repositories$/, handler: handleListRepos },
  { method: 'GET', pattern: CONTENTS_PATTERN, handler: handleGetContents },
  { method: 'PUT', pattern: CONTENTS_PATTERN, handler: handlePutContents },
  { method: 'DELETE', pattern: CONTENTS_PATTERN, handler: handleDeleteContents },
  { method: 'GET', pattern: RAW_CONTENT_PATTERN, handler: handleGetRawContent },
  { method: 'GET', pattern: TREE_PATTERN, handler: handleGetTree },
  { method: 'GET', pattern: PUBLIC_REPO_CONTENTS_PATTERN, handler: handleGetPublicRepoContents },
  { method: 'GET', pattern: PUBLIC_REPO_RAW_PATTERN, handler: handleGetPublicRepoRaw },
  { method: 'GET', pattern: PUBLIC_REPO_TREE_PATTERN, handler: handleGetPublicTree },
  { method: 'GET', pattern: /^\/api\/gists\/([a-f0-9]+)$/i, handler: handleGetPublicGist },
  { method: 'GET', pattern: /^\/api\/ai\/models$/, handler: handleReaderAiModels },
  { method: 'POST', pattern: /^\/api\/ai\/chat$/, handler: handleReaderAiChat },
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
