import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
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
  buildReaderAiProjectSystemPrompt,
  buildReaderAiSystemPrompt,
  compactToolResults,
  estimateMessagesTokens,
  executeReaderAiEditDocumentTool,
  executeReaderAiProjectSyncTool,
  executeReaderAiSubagent,
  executeReaderAiSyncTool,
  type OpenRouterMessage,
  parseReaderAiUpstreamStream,
  READER_AI_DOC_PREVIEW_CHARS,
  READER_AI_MAX_CONCURRENT_TASKS,
  READER_AI_PROJECT_TOOLS,
  READER_AI_TOOLS,
  type ReaderAiFileEntry,
  type ReaderAiStreamParseResult,
  type ReaderAiToolCall,
  readUpstreamError,
  readUpstreamRateLimitMessage,
  StagedChanges,
} from './reader_ai_tools';
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
  context_length: number;
  featured?: boolean;
}

/**
 * Featured free model patterns — matched case-insensitively against model id/name.
 * Maintained server-side so updates don't require client deploys.
 */
const FEATURED_MODEL_PATTERNS = [
  'nemotron 3 nano 30b',
  'step-3.5-flash',
  'step 3.5 flash',
  'trinity mini',
  'trinity large preview',
];

interface ReaderAiChatBody {
  model?: unknown;
  source?: unknown;
  messages?: unknown;
  summary?: unknown;
  /** Project mode: server-side project session ID (preferred). */
  project_id?: unknown;
  /** Project mode: inline files (legacy fallback, used if project_id is absent). */
  project_files?: unknown;
  /** The path of the currently-viewed document (for project mode context). */
  current_doc_path?: unknown;
  /** If true, restrict project-mode edits to the currently-viewed document. */
  edit_mode_current_doc_only?: unknown;
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
    context_length?: unknown;
    supported_parameters?: unknown;
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
const READER_AI_MAX_MESSAGES = 24;
const READER_AI_MAX_MESSAGE_CHARS = 16_000;
const READER_AI_CONTEXT_WINDOW_MESSAGES = 8;
const READER_AI_MAX_SUMMARY_CHARS = 2000;
const READER_AI_SUMMARIZE_TIMEOUT_MS = 30_000;
const READER_AI_MIN_MODEL_PARAMS_B = 15;
const READER_AI_MAX_TOOL_ITERATIONS = 30;
const READER_AI_PER_CALL_TIMEOUT_MS = 60_000;
let readerAiModelsCache: { value: ReaderAiModelEntry[]; expiresAt: number } | null = null;
/** In-flight model fetch promise for stampede protection. */
let readerAiModelsFetchPromise: Promise<ReaderAiModelEntry[]> | null = null;

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

/** Truncate long assistant messages for summarization — strip tool interaction noise. */
function prepareMessageForSummary(msg: ReaderAiChatMessage): string {
  const label = msg.role === 'user' ? 'User' : 'Assistant';
  let content = msg.content;
  // Truncate very long assistant messages (often padded by tool results)
  if (content.length > 2000) {
    content = `${content.slice(0, 2000)}…`;
  }
  return `${label}: ${content}`;
}

async function summarizeReaderAiConversation(
  model: string,
  evictedMessages: ReaderAiChatMessage[],
  existingSummary: string,
  req: http.IncomingMessage,
): Promise<string> {
  const parts: string[] = [];
  if (existingSummary) parts.push(`Previous summary:\n${existingSummary}`);
  for (const msg of evictedMessages) {
    parts.push(prepareMessageForSummary(msg));
  }
  const toSummarize = parts.join('\n\n');

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_URL || requestBaseUrl(req),
      'X-Title': 'Input Reader AI',
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 512,
      messages: [
        {
          role: 'system',
          content:
            'Summarize the following conversation history in 2-4 concise sentences. Capture the key questions asked, answers given, important conclusions, and any files or code that were examined. Omit tool call details — focus on what was learned. Write in third person (e.g. "The user asked about...").',
        },
        { role: 'user', content: toSummarize },
      ],
    }),
    signal: AbortSignal.timeout(READER_AI_SUMMARIZE_TIMEOUT_MS),
  });

  if (!upstream.ok) return existingSummary;

  const payload = (await upstream.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const summary = payload?.choices?.[0]?.message?.content?.trim();
  return summary ? summary.slice(0, READER_AI_MAX_SUMMARY_CHARS) : existingSummary;
}

async function fetchReaderAiModels(req: http.IncomingMessage): Promise<ReaderAiModelEntry[]> {
  const now = Date.now();
  if (readerAiModelsCache && readerAiModelsCache.expiresAt > now) return readerAiModelsCache.value;

  // Stampede protection: if another request is already fetching, reuse it
  if (readerAiModelsFetchPromise) return readerAiModelsFetchPromise;
  readerAiModelsFetchPromise = fetchReaderAiModelsUncached(req).finally(() => {
    readerAiModelsFetchPromise = null;
  });
  return readerAiModelsFetchPromise;
}

async function fetchReaderAiModelsUncached(req: http.IncomingMessage): Promise<ReaderAiModelEntry[]> {
  const now = Date.now();
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
      const supportedParams = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
      if (!supportedParams.includes('tools')) return null;
      const paramsBillions = modelParamsEstimateBillions(entry);
      if (paramsBillions === null || paramsBillions < READER_AI_MIN_MODEL_PARAMS_B) return null;
      const rawCtx = typeof entry.context_length === 'number' ? entry.context_length : 0;
      const context_length = Number.isFinite(rawCtx) && rawCtx > 0 ? rawCtx : 0;
      const normalizedId = id.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const featured = FEATURED_MODEL_PATTERNS.some((pattern) => {
        const p = pattern.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return normalizedId.includes(p) || normalizedName.includes(p);
      });
      return { id, name, context_length, ...(featured ? { featured: true } : {}) };
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
  const session = getSession(ctx.req);
  if (!checkRateLimitForSession(ctx, session)) return;
  ensureOpenRouterConfigured();
  const models = await fetchReaderAiModels(ctx.req);
  json(ctx.res, 200, { models });
}

const READER_AI_MAX_PROJECT_FILES = 100;
const READER_AI_MAX_PROJECT_FILE_SIZE = 512 * 1024; // 512KB per file
const READER_AI_MAX_PROJECT_TOTAL_SIZE = 5 * 1024 * 1024; // 5MB total

function normalizeProjectFiles(raw: unknown): ReaderAiFileEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > READER_AI_MAX_PROJECT_FILES) {
    throw new ClientError(`Too many project files (${raw.length}, max ${READER_AI_MAX_PROJECT_FILES})`, 400);
  }
  const files: ReaderAiFileEntry[] = [];
  let totalSize = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const path = (item as { path?: unknown }).path;
    const content = (item as { content?: unknown }).content;
    const size = (item as { size?: unknown }).size;
    if (typeof path !== 'string' || typeof content !== 'string') continue;
    const fileSize = typeof size === 'number' && Number.isFinite(size) ? size : content.length;
    if (fileSize > READER_AI_MAX_PROJECT_FILE_SIZE) continue; // skip oversized files silently
    totalSize += fileSize;
    if (totalSize > READER_AI_MAX_PROJECT_TOTAL_SIZE) break;
    files.push({ path, content, size: fileSize });
  }
  return files.length > 0 ? files : null;
}

// ── Project session cache (avoids resending all files on every chat request) ──

const READER_AI_PROJECT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const READER_AI_MAX_PROJECT_SESSIONS = 50;
const READER_AI_MAX_PROJECT_SESSIONS_TOTAL_BYTES = 1024 * 1024 * 1024; // 1GB

interface ReaderAiProjectSession {
  id: string;
  userId: number;
  files: ReaderAiFileEntry[];
  stagedChanges: StagedChanges;
  /** Total size of files in this session (bytes). */
  totalFileSize: number;
  createdAt: number;
  lastAccessedAt: number;
}

const readerAiProjectSessions = new Map<string, ReaderAiProjectSession>();

function projectSessionsTotalBytes(): number {
  let total = 0;
  for (const ps of readerAiProjectSessions.values()) {
    total += ps.totalFileSize;
  }
  return total;
}

function pruneProjectSessions(): void {
  const now = Date.now();
  for (const [id, session] of readerAiProjectSessions) {
    if (now - session.lastAccessedAt > READER_AI_PROJECT_SESSION_TTL_MS) {
      readerAiProjectSessions.delete(id);
    }
  }
}

/** Evict oldest sessions until total memory is under the budget. */
function evictProjectSessionsToFit(requiredBytes: number): void {
  while (projectSessionsTotalBytes() + requiredBytes > READER_AI_MAX_PROJECT_SESSIONS_TOTAL_BYTES) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, ps] of readerAiProjectSessions) {
      if (ps.lastAccessedAt < oldestTime) {
        oldestTime = ps.lastAccessedAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    readerAiProjectSessions.delete(oldestId);
  }
}

function getProjectSession(id: string, userId: number): ReaderAiProjectSession | null {
  const session = readerAiProjectSessions.get(id);
  if (!session) return null;
  if (session.userId !== userId) return null;
  if (Date.now() - session.lastAccessedAt > READER_AI_PROJECT_SESSION_TTL_MS) {
    readerAiProjectSessions.delete(id);
    return null;
  }
  session.lastAccessedAt = Date.now();
  return session;
}

async function handleReaderAiProjectCreate(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;

  const body = (await readJson(ctx.req)) as { files?: unknown } | null;
  const files = normalizeProjectFiles(body?.files);
  if (!files) throw new ClientError('files array is required and must not be empty', 400);

  const newSessionSize = files.reduce((sum, f) => sum + f.size, 0);

  // Prune expired sessions and enforce limits
  pruneProjectSessions();
  if (readerAiProjectSessions.size >= READER_AI_MAX_PROJECT_SESSIONS) {
    evictProjectSessionsToFit(newSessionSize);
  }
  // Enforce total memory budget
  evictProjectSessionsToFit(newSessionSize);

  const id = randomBytes(16).toString('hex');
  const now = Date.now();
  readerAiProjectSessions.set(id, {
    id,
    userId: session.githubUserId,
    files,
    stagedChanges: new StagedChanges(files),
    totalFileSize: newSessionSize,
    createdAt: now,
    lastAccessedAt: now,
  });

  json(ctx.res, 200, { project_id: id, file_count: files.length });
}

async function handleReaderAiProjectFiles(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;

  const projectId = ctx.match[1];
  const ps = getProjectSession(projectId, session.githubUserId);
  if (!ps) throw new ClientError('Project session not found or expired', 404);

  // Return only changed files (modified content) to minimize payload
  const changes = ps.stagedChanges.getChanges();
  const files = changes.filter((c) => c.modified !== null).map((c) => ({ path: c.path, content: c.modified! }));
  json(ctx.res, 200, { files });
}

async function handleReaderAiProjectFileUpdate(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;

  const projectId = ctx.match[1];
  const ps = getProjectSession(projectId, session.githubUserId);
  if (!ps) throw new ClientError('Project session not found or expired', 404);

  const body = (await readJson(ctx.req)) as { path?: unknown; content?: unknown } | null;
  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  const content = typeof body?.content === 'string' ? body.content : null;
  if (!path) throw new ClientError('path is required', 400);
  if (content === null) throw new ClientError('content is required', 400);

  const fileSize = Buffer.byteLength(content, 'utf8');
  const existingIndex = ps.files.findIndex((file) => file.path === path);
  if (existingIndex >= 0) {
    ps.files[existingIndex] = { path, content, size: fileSize };
  } else {
    ps.files.push({ path, content, size: fileSize });
  }
  ps.stagedChanges.reset(ps.files);

  json(ctx.res, 200, { updated: true, file_count: ps.files.length });
}

async function handleReaderAiProjectReset(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;

  const projectId = ctx.match[1];
  const ps = getProjectSession(projectId, session.githubUserId);
  if (ps) {
    ps.stagedChanges.reset(ps.files);
  }
  json(ctx.res, 200, { reset: true });
}

async function handleReaderAiProjectDelete(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;

  const projectId = ctx.match[1];
  const ps = readerAiProjectSessions.get(projectId);
  if (ps && ps.userId === session.githubUserId) {
    readerAiProjectSessions.delete(projectId);
  }
  json(ctx.res, 200, { deleted: true });
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
  // Validate model against the cached free models list to prevent use of non-free models
  const allowedModels = readerAiModelsCache?.value;
  if (allowedModels && allowedModels.length > 0 && !allowedModels.some((m) => m.id === model)) {
    throw new ClientError('Selected model is not available', 400);
  }
  const allMessages = normalizeReaderAiMessages(body?.messages);
  const existingSummary =
    typeof body?.summary === 'string' ? body.summary.trim().slice(0, READER_AI_MAX_SUMMARY_CHARS) : '';

  // Project mode: resolve from project session cache (preferred) or inline files (fallback)
  let projectFiles: ReaderAiFileEntry[] | null = null;
  const projectId = typeof body?.project_id === 'string' ? body.project_id.trim() : '';
  if (projectId) {
    const ps = getProjectSession(projectId, session.githubUserId);
    if (!ps) throw new ClientError('Project session not found or expired', 404);
    // Touch TTL so long-running tool loops don't expire the session mid-request
    ps.lastAccessedAt = Date.now();
    projectFiles = ps.files;
  } else {
    projectFiles = normalizeProjectFiles(body?.project_files);
  }
  const resolvedProjectFiles = projectFiles ?? undefined;
  const isProjectMode = resolvedProjectFiles !== undefined;
  const currentDocPath = typeof body?.current_doc_path === 'string' ? body.current_doc_path : null;
  const editModeCurrentDocOnly = body?.edit_mode_current_doc_only === true;

  let chatMessages: ReaderAiChatMessage[];
  let newSummary: string | null = null;
  let summarizationFailed = false;
  if (allMessages.length <= READER_AI_CONTEXT_WINDOW_MESSAGES) {
    if (existingSummary) {
      chatMessages = [
        { role: 'user', content: `[Summary of earlier conversation]\n${existingSummary}` },
        { role: 'assistant', content: 'Understood, I have the context from our earlier conversation.' },
        ...allMessages,
      ];
    } else {
      chatMessages = allMessages;
    }
  } else {
    const evicted = allMessages.slice(0, -READER_AI_CONTEXT_WINDOW_MESSAGES);
    const kept = allMessages.slice(-READER_AI_CONTEXT_WINDOW_MESSAGES);
    try {
      newSummary = await summarizeReaderAiConversation(model, evicted, existingSummary, ctx.req);
    } catch {
      newSummary = existingSummary || null;
      if (!existingSummary) summarizationFailed = true;
    }
    const summaryText = newSummary || existingSummary;
    if (summaryText) {
      chatMessages = [
        { role: 'user', content: `[Summary of earlier conversation]\n${summaryText}` },
        { role: 'assistant', content: 'Understood, I have the context from our earlier conversation.' },
        ...kept,
      ];
    } else {
      chatMessages = kept;
    }
  }

  // Prepare document for tool access
  const lines = source.split('\n');
  const documentEditState = {
    source,
    lines,
    currentDocPath,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
  };
  const cachedModels = readerAiModelsCache?.value ?? [];
  const modelEntry = cachedModels.find((m) => m.id === model);
  const contextTokens = modelEntry?.context_length || 0;

  // Build system prompt and tool set based on mode
  let systemPrompt: string;
  let tools: Array<(typeof READER_AI_TOOLS)[number] | (typeof READER_AI_PROJECT_TOOLS)[number]>;
  if (isProjectMode) {
    systemPrompt = buildReaderAiProjectSystemPrompt(resolvedProjectFiles, currentDocPath, editModeCurrentDocOnly);
    tools = editModeCurrentDocOnly
      ? READER_AI_PROJECT_TOOLS.filter((tool) => {
          const name = tool.function.name;
          return name !== 'create_file' && name !== 'delete_file' && name !== 'task';
        })
      : READER_AI_PROJECT_TOOLS;
  } else {
    const maxPreviewChars =
      contextTokens > 0
        ? Math.min(READER_AI_DOC_PREVIEW_CHARS, Math.floor(contextTokens * 3 * 0.25))
        : READER_AI_DOC_PREVIEW_CHARS;
    systemPrompt = buildReaderAiSystemPrompt(source, lines, maxPreviewChars, currentDocPath);
    tools = READER_AI_TOOLS;
  }

  // Build messages for OpenRouter (internal format supports tool call/result messages)
  const openRouterMessages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    ...chatMessages.map((m): OpenRouterMessage => ({ role: m.role, content: m.content })),
  ];

  const requestStart = Date.now();
  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  ctx.req.on('close', onClientClose);

  const openRouterHeaders = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': APP_URL || requestBaseUrl(ctx.req),
    'X-Title': 'Input Reader AI',
  };

  const callUpstream = (timeoutMs: number) =>
    fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: openRouterHeaders,
      body: JSON.stringify({ model, stream: true, messages: openRouterMessages, tools }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), abortController.signal]),
    });

  const remainingMs = () => Math.max(0, READER_AI_TIMEOUT_MS - (Date.now() - requestStart));
  const callTimeout = () => Math.min(READER_AI_PER_CALL_TIMEOUT_MS, remainingMs());

  // Token budget management — reserve space for system prompt, keep tool results within budget
  const maxContextTokens = contextTokens > 0 ? contextTokens : 32_000;
  // Reserve 25% for system prompt + file tree, 15% for output, 60% for conversation + tool results
  const conversationBudgetTokens = Math.floor(maxContextTokens * 0.6);

  // Staging layer for file edits in project mode — reuse from project session if available
  const projectSession = projectId ? readerAiProjectSessions.get(projectId) : undefined;
  const stagedChanges = projectSession
    ? projectSession.stagedChanges
    : isProjectMode
      ? new StagedChanges(resolvedProjectFiles)
      : undefined;

  const executeSyncToolCall = (tc: ReaderAiToolCall): string => {
    if (isProjectMode) {
      if (editModeCurrentDocOnly && currentDocPath) {
        let args: Record<string, unknown> | null = null;
        try {
          args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          // Let the tool handler return its own invalid JSON error.
        }
        if (tc.name === 'create_file' || tc.name === 'delete_file') {
          return `(tool ${tc.name} is not available while editing the current document)`;
        }
        if ((tc.name === 'read_file' || tc.name === 'edit_file') && args && typeof args.path === 'string') {
          if (args.path !== currentDocPath) {
            return `(tool ${tc.name} is restricted to the current document: ${currentDocPath})`;
          }
        }
      }
      return executeReaderAiProjectSyncTool(tc.name, tc.arguments, resolvedProjectFiles, stagedChanges);
    }
    if (tc.name === 'edit_document') return executeReaderAiEditDocumentTool(tc.arguments, documentEditState);
    return executeReaderAiSyncTool(tc.name, tc.arguments, documentEditState.lines);
  };

  let stagedChangesEmitted = false;
  const emitStagedChangesIfAny = () => {
    if (stagedChangesEmitted || ctx.res.writableEnded) return;
    const hasProjectStagedChanges = stagedChanges?.hasChanges() ?? false;
    const hasDocumentStagedChange = Boolean(documentEditState.stagedContent && documentEditState.stagedDiff);
    if (!hasProjectStagedChanges && !hasDocumentStagedChange) return;

    const allChanges = hasProjectStagedChanges
      ? stagedChanges!.getChanges()
      : [
          {
            path: currentDocPath || 'current-document.md',
            type: 'edit' as const,
            original: source,
            modified: documentEditState.stagedContent!,
            diff: documentEditState.stagedDiff!,
          },
        ];
    const changes = allChanges.map((c) => ({
      path: c.path,
      type: c.type,
      diff: c.diff,
    }));
    const edits = allChanges.filter((c) => c.type === 'edit').map((c) => c.path);
    const creates = allChanges.filter((c) => c.type === 'create').map((c) => c.path);
    const deletes = allChanges.filter((c) => c.type === 'delete').map((c) => c.path);
    const parts: string[] = [];
    if (edits.length === 1) parts.push(`Update ${edits[0]}`);
    else if (edits.length > 1) parts.push(`Update ${edits.length} files`);
    if (creates.length === 1) parts.push(`add ${creates[0]}`);
    else if (creates.length > 1) parts.push(`add ${creates.length} files`);
    if (deletes.length === 1) parts.push(`delete ${deletes[0]}`);
    else if (deletes.length > 1) parts.push(`delete ${deletes.length} files`);
    const suggestedCommitMessage = parts.join(', ') || 'Apply AI-suggested changes';
    ctx.res.write(
      `event: staged_changes\ndata: ${JSON.stringify({
        changes,
        suggested_commit_message: suggestedCommitMessage,
        ...(documentEditState.stagedContent ? { document_content: documentEditState.stagedContent } : {}),
      })}\n\n`,
    );
    stagedChangesEmitted = true;
  };

  const writeSseEvent = (event: string, data: unknown) => {
    if (ctx.res.writableEnded) return;
    ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // First call — errors before SSE starts can be returned as JSON
    const firstUpstream = await callUpstream(callTimeout());
    if (!firstUpstream.ok) {
      const rateLimitMsg = readUpstreamRateLimitMessage(firstUpstream.headers);
      if (rateLimitMsg) throw new ClientError(rateLimitMsg, 429);
      const payload = (await firstUpstream.json().catch(() => null)) as unknown;
      const upstreamError = readUpstreamError(payload);
      throw new ClientError(upstreamError || `OpenRouter request failed (${firstUpstream.status})`, 502);
    }
    if (!firstUpstream.body) throw new ClientError('OpenRouter did not return a stream', 502);

    // Start SSE response
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    ctx.res.setHeader('Cache-Control', 'no-cache');
    ctx.res.setHeader('Connection', 'keep-alive');
    if (newSummary) {
      ctx.res.write(`event: summary\ndata: ${JSON.stringify({ summary: newSummary })}\n\n`);
    }
    if (summarizationFailed) {
      writeSseEvent('error', { message: 'Earlier conversation context could not be summarized and may be lost.' });
    }

    let needsDrain = false;
    const writeSseDelta = (delta: string) => {
      if (ctx.res.writableEnded) return;
      const ok = ctx.res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
      if (!ok) needsDrain = true;
    };
    const awaitDrainIfNeeded = (): Promise<void> => {
      if (!needsDrain || ctx.res.writableEnded) {
        needsDrain = false;
        return Promise.resolve();
      }
      needsDrain = false;
      return new Promise((resolve) => {
        ctx.res.once('drain', resolve);
        // Safety timeout — don't block forever if the socket is gone
        setTimeout(resolve, 5000);
      });
    };

    // SSE keepalive: send a comment every 15s to prevent intermediary proxy idle-timeout kills
    const keepaliveInterval = setInterval(() => {
      if (ctx.res.writableEnded) return;
      ctx.res.write(': keepalive\n\n');
    }, 15_000);

    // Agentic tool-call loop
    let currentBody: ReadableStream<Uint8Array> | null = firstUpstream.body;
    for (let iteration = 0; iteration < READER_AI_MAX_TOOL_ITERATIONS; iteration++) {
      writeSseEvent('turn_start', { iteration });
      let result: ReaderAiStreamParseResult;
      try {
        result = await parseReaderAiUpstreamStream(currentBody, writeSseDelta);
      } catch (streamErr) {
        await currentBody.cancel().catch(() => {});
        currentBody = null;
        throw streamErr;
      }
      currentBody = null;

      if (result.toolCalls.length === 0) {
        writeSseEvent('turn_end', { iteration, reason: 'done' });
        break;
      }

      // Add assistant message with tool calls
      openRouterMessages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Execute each tool call — task calls run in parallel, sync tools run sequentially
      const taskCalls: Array<{ tc: ReaderAiToolCall; parsedArgs: Record<string, unknown> }> = [];
      const syncCalls: Array<{ tc: ReaderAiToolCall; parsedArgs: Record<string, unknown> | undefined }> = [];

      for (const tc of result.toolCalls) {
        let parsedArgs: Record<string, unknown> | undefined;
        try {
          parsedArgs = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
        } catch {
          // send raw string if unparseable
        }
        writeSseEvent('tool_call', { id: tc.id, name: tc.name, arguments: parsedArgs ?? tc.arguments });

        if (tc.name === 'task') {
          if (parsedArgs) {
            taskCalls.push({ tc, parsedArgs });
          } else {
            // Task call with malformed JSON — return an error tool result rather than
            // silently falling through to the sync tool path (which would return "unknown tool: task").
            openRouterMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '(task tool arguments could not be parsed as JSON — please provide valid JSON with a "prompt" field)',
            });
            writeSseEvent('tool_result', { id: tc.id, name: 'task', preview: '(invalid JSON arguments)' });
          }
        } else {
          syncCalls.push({ tc, parsedArgs });
        }
      }

      // Run sync tools first
      for (const { tc } of syncCalls) {
        const toolResult = executeSyncToolCall(tc);

        openRouterMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
        const resultPreview = toolResult.length > 200 ? `${toolResult.slice(0, 200)}...` : toolResult;
        writeSseEvent('tool_result', { id: tc.id, name: tc.name, preview: resultPreview });
      }

      // Run task calls in parallel (up to READER_AI_MAX_CONCURRENT_TASKS)
      if (taskCalls.length > 0) {
        const batches: Array<typeof taskCalls> = [];
        for (let i = 0; i < taskCalls.length; i += READER_AI_MAX_CONCURRENT_TASKS) {
          batches.push(taskCalls.slice(i, i + READER_AI_MAX_CONCURRENT_TASKS));
        }
        for (const batch of batches) {
          const taskPromises = batch.map(async ({ tc, parsedArgs }) => {
            const taskPrompt = typeof parsedArgs.prompt === 'string' ? parsedArgs.prompt : '';
            const taskSystemPrompt =
              typeof parsedArgs.system_prompt === 'string' ? parsedArgs.system_prompt : undefined;

            if (!taskPrompt) {
              return { id: tc.id, result: '(task tool requires a "prompt" argument)' };
            }

            try {
              const taskResult = await executeReaderAiSubagent({
                model,
                prompt: taskPrompt,
                systemPrompt: taskSystemPrompt,
                lines,
                source,
                projectFiles: isProjectMode ? resolvedProjectFiles : undefined,
                stagedChanges: isProjectMode ? stagedChanges : undefined,
                openRouterHeaders,
                signal: abortController.signal,
                onProgress: (event) => {
                  writeSseEvent('task_progress', {
                    id: tc.id,
                    name: 'task',
                    phase: event.phase,
                    iteration: event.iteration,
                    detail: event.detail,
                  });
                },
              });
              return { id: tc.id, result: taskResult };
            } catch (taskErr) {
              const message =
                taskErr instanceof DOMException && (taskErr.name === 'TimeoutError' || taskErr.name === 'AbortError')
                  ? 'Subagent timed out'
                  : taskErr instanceof Error
                    ? taskErr.message
                    : 'Subagent failed';
              writeSseEvent('task_progress', {
                id: tc.id,
                name: 'task',
                phase: 'error',
                detail: message,
              });
              return { id: tc.id, result: `[Subagent error: ${message}]` };
            }
          });

          const taskResults = await Promise.all(taskPromises);
          for (const { id, result: taskResult } of taskResults) {
            openRouterMessages.push({ role: 'tool', tool_call_id: id, content: taskResult });
            const resultPreview = taskResult.length > 200 ? `${taskResult.slice(0, 200)}...` : taskResult;
            writeSseEvent('tool_result', { id, name: 'task', preview: resultPreview });
          }
        }
      }

      // Check if conversation has grown beyond the token budget
      const currentTokens = estimateMessagesTokens(openRouterMessages);
      if (currentTokens > conversationBudgetTokens) {
        // Try compacting old tool results before giving up
        const reclaimed = compactToolResults(openRouterMessages, 4);
        if (reclaimed > 0) {
          const afterCompaction = estimateMessagesTokens(openRouterMessages);
          if (afterCompaction > conversationBudgetTokens) {
            writeSseEvent('turn_end', { iteration, reason: 'context_budget' });
            break;
          }
          // Compaction freed enough space — continue
        } else {
          writeSseEvent('turn_end', { iteration, reason: 'context_budget' });
          break;
        }
      }

      // Check remaining time before next call
      if (remainingMs() <= 0) {
        writeSseEvent('error', { message: 'Request timed out during tool execution' });
        writeSseEvent('turn_end', { iteration, reason: 'timeout' });
        break;
      }

      writeSseEvent('turn_end', { iteration, reason: 'tool_calls' });

      // Allow the write buffer to drain before making the next upstream call
      await awaitDrainIfNeeded();

      const nextUpstream = await callUpstream(callTimeout());
      if (!nextUpstream.ok || !nextUpstream.body) {
        const rateLimitMsg = readUpstreamRateLimitMessage(nextUpstream.headers);
        const status = nextUpstream.status ?? 0;
        const payload = rateLimitMsg ? null : (await nextUpstream.json().catch(() => null)) as unknown;
        const detail = rateLimitMsg || readUpstreamError(payload) || `Model returned an error (${status})`;
        writeSseEvent('error', { message: detail });
        break;
      }
      currentBody = nextUpstream.body;
    }
    // Cancel any unconsumed stream body
    if (currentBody) await currentBody.cancel().catch(() => {});
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      if (!ctx.res.headersSent) throw new ClientError('Reader AI request timed out', 504);
      if (!ctx.res.writableEnded) {
        writeSseEvent('error', { message: 'Request timed out' });
        emitStagedChangesIfAny();
        ctx.res.write('data: [DONE]\n\n');
        ctx.res.end();
      }
      return;
    }
    if (ctx.res.headersSent) {
      console.warn('Reader AI stream failed after response start:', err);
      if (!ctx.res.writableEnded) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred';
        writeSseEvent('error', { message });
        emitStagedChangesIfAny();
        ctx.res.write('data: [DONE]\n\n');
        ctx.res.end();
      }
      return;
    }
    throw err;
  } finally {
    clearInterval(keepaliveInterval);
    ctx.req.off('close', onClientClose);
  }

  // Emit staged changes if any edits were made
  emitStagedChangesIfAny();

  if (!ctx.res.writableEnded) {
    ctx.res.write('data: [DONE]\n\n');
    ctx.res.end();
  }
}

// ── Repo tarball download (bulk file fetch for AI repo mode) ──

const REPO_TARBALL_MAX_FILES = 100;
const REPO_TARBALL_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const REPO_TARBALL_TIMEOUT_MS = 30_000;

interface TarballFile {
  path: string;
  content: string;
  size: number;
}

async function extractTarball(stream: ReadableStream<Uint8Array>): Promise<TarballFile[]> {
  const files: TarballFile[] = [];
  const extract = tar.extract();
  const gunzip = createGunzip();

  return new Promise((resolve, reject) => {
    extract.on('entry', (header, entryStream, next) => {
      if (header.type !== 'file') {
        entryStream.resume();
        next();
        return;
      }
      // Tarball paths are prefixed with <owner>-<repo>-<sha>/
      const rawPath = header.name;
      const slashIndex = rawPath.indexOf('/');
      const path = slashIndex >= 0 ? rawPath.slice(slashIndex + 1) : rawPath;
      if (!path) {
        entryStream.resume();
        next();
        return;
      }

      const size = header.size ?? 0;
      if (size > REPO_TARBALL_MAX_FILE_SIZE) {
        entryStream.resume();
        next();
        return;
      }

      const chunks: Buffer[] = [];
      entryStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      entryStream.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Skip binary files — check for null bytes in the first 8KB
        const preview = buf.subarray(0, 8192);
        if (preview.includes(0)) {
          next();
          return;
        }
        files.push({ path, content: buf.toString('utf8'), size: buf.length });
        if (files.length > REPO_TARBALL_MAX_FILES) {
          extract.destroy(new Error('too_many_files'));
          return;
        }
        next();
      });
      entryStream.on('error', next);
    });

    extract.on('finish', () => resolve(files));
    extract.on('error', (err) => {
      if (err.message === 'too_many_files') {
        reject(new ClientError(`Repository has more than ${REPO_TARBALL_MAX_FILES} text files`, 400));
      } else {
        reject(err);
      }
    });

    // Pipe ReadableStream → Node stream → gunzip → tar extract
    const nodeStream = readableStreamToNodeStream(stream);
    nodeStream.pipe(gunzip).pipe(extract);
    gunzip.on('error', (err) => reject(new ClientError(`Failed to decompress tarball: ${err.message}`, 502)));
  });
}

function readableStreamToNodeStream(webStream: ReadableStream<Uint8Array>): Readable {
  const reader = webStream.getReader();
  return new Readable({
    async read() {
      try {
        const { value, done } = await reader.read();
        if (done) {
          this.push(null);
        } else {
          this.push(Buffer.from(value));
        }
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

async function handleRepoTarball(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];
  const ref = ctx.url.searchParams.get('ref') || 'HEAD';

  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghPath, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(REPO_TARBALL_TIMEOUT_MS),
  });

  if (!ghRes.body) throw new ClientError('GitHub did not return a tarball body', 502);
  const files = await extractTarball(ghRes.body);
  json(ctx.res, 200, { files });
}

async function handlePublicRepoTarball(ctx: RouteContext): Promise<void> {
  if (!checkRateLimitForSession(ctx, getSession(ctx.req))) return;
  const owner = decodeURIComponent(ctx.match[1]);
  const repo = decodeURIComponent(ctx.match[2]);
  const ref = ctx.url.searchParams.get('ref') || 'HEAD';

  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`;
  const ghRes = await fetchPublicGitHub(ghPath, {
    signal: AbortSignal.timeout(REPO_TARBALL_TIMEOUT_MS),
  });
  if (!ghRes.ok) {
    const err = (await ghRes.json().catch(() => null)) as GitHubApiError | null;
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }
  if (!ghRes.body) throw new ClientError('GitHub did not return a tarball body', 502);
  const files = await extractTarball(ghRes.body);
  json(ctx.res, 200, { files });
}

const CONTENTS_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/;
const RAW_CONTENT_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/raw$/;
const TREE_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/tree$/;
const PUBLIC_REPO_CONTENTS_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/contents$/;
const PUBLIC_REPO_RAW_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/raw$/;
const PUBLIC_REPO_TREE_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/tree$/;
const TARBALL_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/tarball$/;
const PUBLIC_REPO_TARBALL_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/tarball$/;
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
  { method: 'GET', pattern: TARBALL_PATTERN, handler: handleRepoTarball },
  { method: 'GET', pattern: PUBLIC_REPO_CONTENTS_PATTERN, handler: handleGetPublicRepoContents },
  { method: 'GET', pattern: PUBLIC_REPO_RAW_PATTERN, handler: handleGetPublicRepoRaw },
  { method: 'GET', pattern: PUBLIC_REPO_TREE_PATTERN, handler: handleGetPublicTree },
  { method: 'GET', pattern: PUBLIC_REPO_TARBALL_PATTERN, handler: handlePublicRepoTarball },
  { method: 'GET', pattern: /^\/api\/gists\/([a-f0-9]+)$/i, handler: handleGetPublicGist },
  { method: 'GET', pattern: /^\/api\/ai\/models$/, handler: handleReaderAiModels },
  { method: 'POST', pattern: /^\/api\/ai\/project$/, handler: handleReaderAiProjectCreate },
  { method: 'GET', pattern: /^\/api\/ai\/project\/([a-f0-9]+)\/files$/, handler: handleReaderAiProjectFiles },
  { method: 'POST', pattern: /^\/api\/ai\/project\/([a-f0-9]+)\/file$/, handler: handleReaderAiProjectFileUpdate },
  { method: 'POST', pattern: /^\/api\/ai\/project\/([a-f0-9]+)\/reset$/, handler: handleReaderAiProjectReset },
  { method: 'DELETE', pattern: /^\/api\/ai\/project\/([a-f0-9]+)$/i, handler: handleReaderAiProjectDelete },
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
