import { createHash } from 'node:crypto';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { canGitHubUserEditMarkdownDocument, validateEditorsPreserved } from '../src/document_permissions.ts';
import type { ReaderAiStepErrorCode } from '../src/reader_ai_errors.ts';
import { resolveCommitCompactionSelection } from './commit_compaction.ts';
import {
  APP_URL,
  CLIENT_PORT,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_FETCH_TIMEOUT_MS,
  GITHUB_TOKEN,
  MAX_UPLOAD_BYTES,
  OPENROUTER_API_KEY,
  OPENROUTER_PAID_API_KEY,
  READER_AI_TIMEOUT_MS,
  SHARE_TOKEN_SECRET,
  SHARE_TOKEN_TTL_SECONDS,
} from './config.ts';
import { stripCriticMarkupComments } from './criticmarkup.js';
import { ClientError } from './errors.ts';
import { getGistCacheEntry, isFresh, markRevalidated, setGistCacheEntry } from './gist_cache.ts';
import {
  atomicForceUpdateGitHubRef,
  createAppJwt,
  encodePathPreserveSlashes,
  getGitHubRepositoryBranchState,
  getRepoInstallationId,
  githubFetchWithInstallationToken,
  githubGraphqlWithInstallationToken,
} from './github_client.ts';
import { json, readJson, requireEnv, requireString } from './http_helpers.ts';
import { checkRateLimit, checkRateLimitAuthenticated } from './rate_limit.ts';
import {
  canAccessReaderAiModel,
  getReaderAiModelSource,
  type ReaderAiModelAccessScope,
  readerAiModelAccessScopeForAuthenticated,
  shouldUseOpenRouterPromptCaching,
} from './reader_ai_access.ts';
import {
  buildReaderAiPromptListSystemPrompt,
  buildReaderAiSystemPrompt,
  compactToolResults,
  estimateMessagesTokens,
  executeReaderAiEditDocumentTool,
  executeReaderAiSubagent,
  executeReaderAiSyncTool,
  type OpenRouterMessage,
  parseReaderAiUpstreamStream,
  parseToolArgumentsWithRepair,
  parseUnifiedDiffHunks,
  READER_AI_DOC_PREVIEW_CHARS,
  READER_AI_MAX_CONCURRENT_TASKS,
  READER_AI_TOOLS,
  type ReaderAiStreamParseResult,
  type ReaderAiToolCall,
  readUpstreamError,
  readUpstreamRateLimitMessage,
} from './reader_ai_tools.ts';
import { createOrReuseRepoFileShareLink, listRepoFileShareLinkResponses } from './repo_file_share_links.ts';
import {
  clearRememberedInstallationForUser,
  consumeOAuthState,
  createOAuthState,
  createSession,
  destroySession,
  getRememberedInstallationForUser,
  getSession,
  isInstallationLinkedForUser,
  listInstallationsForUser,
  refreshSession,
  rememberInstallationForUser,
  removeInstallationForUser,
  selectInstallationForUser,
} from './session.ts';
import { verifyRepoFileShareToken } from './share_tokens.ts';
import { stripManagedSubdomain } from './subdomain.ts';
import type { Session, UserInstallation } from './types.ts';

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

interface ShareRepoFileListQuery {
  installationId: string;
  repoFullName: string;
  path: string;
}

interface EditorShareRepoFileUpdateBody extends Record<string, unknown> {
  message?: unknown;
  content?: unknown;
  sha?: unknown;
}

interface RepoContentsFileData {
  type?: string;
  path?: string;
  sha?: string;
  name?: string;
  content?: string;
  encoding?: string;
}

interface ReaderAiApplyConflictEntry {
  path: string;
  reason: 'document_changed';
  message: string;
  current_content?: string;
  current_sha?: string;
  expected_version?: string | null;
  current_version?: string | null;
}

function readerAiContentVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
const FEATURED_MODEL_PATTERNS = ['nemotron 3 nano', 'nemotron 3 super', 'trinity mini'];
const HIDDEN_FREE_MODEL_PATTERNS = ['llama 3 3 70b instruct', 'gpt oss 120b', 'qwen3 next 80b a3b instruct'];

const OPENROUTER_PAID_MODELS: ReaderAiModelEntry[] = [
  {
    id: 'anthropic/claude-opus-4.6',
    name: 'Anthropic: Claude Opus 4.6 (Paid)',
    context_length: 1_000_000,
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Anthropic: Claude Sonnet 4.6 (Paid)',
    context_length: 1_000_000,
  },
  {
    id: 'google/gemini-3-flash-preview',
    name: 'Google: Gemini 3 Flash Preview (Paid)',
    context_length: 1_048_576,
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Google: Gemini 3.1 Pro Preview (Paid)',
    context_length: 1_048_576,
  },
];

interface ReaderAiChatBody {
  model?: unknown;
  source?: unknown;
  messages?: unknown;
  mode?: unknown;
  summary?: unknown;
  current_doc_path?: unknown;
  edit_mode_current_doc_only?: unknown;
  allow_document_edits?: unknown;
}

interface ReaderAiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function normalizeReaderAiModelText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function classifyReaderAiToolErrorCode(error: string): ReaderAiStepErrorCode {
  const normalized = error.toLowerCase();
  if (
    normalized.includes('invalid json') ||
    normalized.includes('could not be parsed as json') ||
    normalized.includes('path is required') ||
    normalized.includes('content is required') ||
    normalized.includes('new_text is required') ||
    normalized.includes('old_text is required')
  ) {
    return 'invalid_arguments';
  }
  if (normalized.includes('old_text not found')) return 'conflict';
  if (normalized.includes('file not found')) return 'not_found';
  if (normalized.includes('unknown tool')) return 'unknown_tool';
  if (normalized.includes('rate limit')) return 'rate_limited';
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (normalized.includes('network') || normalized.includes('fetch')) return 'network';
  return 'unknown';
}

function classifyReaderAiTaskErrorCode(error: unknown): ReaderAiStepErrorCode {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('rate limit')) return 'rate_limited';
  if (message.includes('network') || message.includes('fetch')) return 'network';
  return 'task_failed';
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

function canonicalAppBaseUrl(req: http.IncomingMessage): string {
  if (APP_URL) return APP_URL;

  for (const candidate of [req.headers.origin, req.headers.referer]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try {
      const url = new URL(candidate);
      const host = stripManagedSubdomain(url.host) ?? url.host;
      return `${url.protocol}//${host}`;
    } catch {
      // Ignore malformed client-supplied origins and fall back to request host.
    }
  }

  const proto = req.headers['x-forwarded-proto'];
  const scheme = typeof proto === 'string' ? proto.split(',')[0].trim() : 'http';
  const host = stripManagedSubdomain(req.headers.host) ?? req.headers.host ?? `localhost:${CLIENT_PORT}`;
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

function parseShareRepoFileListQuery(url: URL): ShareRepoFileListQuery {
  const installationId = url.searchParams.get('installationId')?.trim() ?? '';
  const repoFullName = url.searchParams.get('repoFullName')?.trim() ?? '';
  const path = url.searchParams.get('path')?.trim() ?? '';
  if (!installationId || !repoFullName || !path) {
    throw new ClientError('installationId, repoFullName, and path are required', 400);
  }
  return { installationId, repoFullName, path };
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
  if (!isInstallationLinkedForUser(session.githubUserId, installationId)) {
    throw new ClientError('Forbidden', 403);
  }
  return installationId;
}

function authSessionResponse(session: Session): {
  authenticated: true;
  user: {
    login: string;
    avatar_url: string;
    name: string | null;
  };
  installationId: string | null;
  installations: UserInstallation[];
} {
  return {
    authenticated: true,
    user: {
      login: session.githubLogin,
      avatar_url: session.githubAvatarUrl,
      name: session.githubName,
    },
    installationId: session.installationId,
    installations: listInstallationsForUser(session.githubUserId),
  };
}

type GitHubInstallationAccount = {
  login?: string;
  type?: string;
  avatar_url?: string;
  html_url?: string;
};

type GitHubInstallation = {
  id?: number;
  account?: GitHubInstallationAccount | null;
};

async function fetchGitHubInstallation(installationId: string): Promise<GitHubInstallation> {
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
    throw new ClientError('Invalid installation', 403);
  }
  return (await ghRes.json()) as GitHubInstallation;
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
  if (await gitHubResponseFailed(ctx.res, ghRes, path, { preParsedBody: data, throw401: true })) return;
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

function copyGitHubRateLimitHeaders(res: http.ServerResponse, ghRes: Response): void {
  for (const headerName of [
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-ratelimit-resource',
  ]) {
    const value = ghRes.headers.get(headerName);
    if (value) res.setHeader(headerName, value);
  }
}

function respondGitHubError(res: http.ServerResponse, ghRes: Response, fallbackMessage: string, source: string): void {
  const message = fallbackMessage || 'GitHub API error';
  const info = githubErrorInfo(ghRes, message);
  const rate = info.rateLimit;
  console.warn(
    `[github] ${source} -> ${info.status} "${message}" request_id=${info.requestId ?? '-'} rate_limited=${info.isRateLimited} remaining=${rate.remaining ?? '-'} reset=${rate.resetAt ?? '-'} retry_after=${rate.retryAfterSeconds ?? '-'}`,
  );
  copyGitHubRateLimitHeaders(res, ghRes);
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

/**
 * Check a GitHub API response and handle the common error/success boilerplate.
 * On error: parses the error body (or uses pre-parsed data), sends the error
 * response via respondGitHubError, and returns true.
 * On success: copies rate-limit headers and returns false.
 *
 * Options:
 * - preParsedBody: use already-parsed JSON instead of calling ghRes.json()
 * - throw401: throw ClientError on 401 instead of sending respondGitHubError
 */
async function gitHubResponseFailed(
  res: http.ServerResponse,
  ghRes: Response,
  source: string,
  opts?: { preParsedBody?: unknown; throw401?: boolean },
): Promise<boolean> {
  if (!ghRes.ok) {
    if (opts?.throw401 && ghRes.status === 401) throw new ClientError('Unauthorized', 401);
    const err =
      opts?.preParsedBody !== undefined
        ? (opts.preParsedBody as GitHubApiError | null)
        : ((await ghRes.json().catch(() => null)) as GitHubApiError | null);
    respondGitHubError(res, ghRes, err?.message ?? 'GitHub API error', source);
    return true;
  }
  copyGitHubRateLimitHeaders(res, ghRes);
  return false;
}

function isPublicPatPolicyFailure(status: number, message: string): boolean {
  if (status !== 401 && status !== 403) return false;
  const normalized = message.toLowerCase();
  if (!normalized.includes('fine-grained personal access token')) return false;
  return normalized.includes('forbid') || normalized.includes('lifetime');
}

function isEmptyGitRepositoryError(status: number, message: string): boolean {
  if (status !== 404 && status !== 409) return false;
  return /git repository is empty|repository is empty/i.test(message);
}

function isRootContentsRequest(path: string): boolean {
  return path.trim() === '';
}

const READER_AI_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const READER_AI_MAX_MESSAGES = 500;
const READER_AI_MAX_MESSAGE_CHARS = 16_000;
const READER_AI_CONTEXT_WINDOW_MESSAGES = 8;
const READER_AI_MAX_SUMMARY_CHARS = 2000;
const READER_AI_SUMMARIZE_TIMEOUT_MS = 30_000;
const READER_AI_MIN_MODEL_PARAMS_B = 15;
const READER_AI_MAX_TOOL_ITERATIONS = 30;
const READER_AI_PER_CALL_TIMEOUT_MS = 60_000;
const readerAiModelsCache = new Map<ReaderAiModelAccessScope, { value: ReaderAiModelEntry[]; expiresAt: number }>();
/** In-flight model fetch promise for stampede protection. */
const readerAiModelsFetchPromise = new Map<ReaderAiModelAccessScope, Promise<ReaderAiModelEntry[]>>();

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

function ensureReaderAiConfigured(session: Session | null): void {
  if ((session && !OPENROUTER_API_KEY && !OPENROUTER_PAID_API_KEY) || (!session && !OPENROUTER_API_KEY)) {
    throw new ClientError('Reader AI is not configured on this server', 503);
  }
}

const paidReaderAiModelIds = new Set(OPENROUTER_PAID_MODELS.map((entry) => entry.id));

function readerAiModelAccessScopeForSession(session: Session | null): ReaderAiModelAccessScope {
  return readerAiModelAccessScopeForAuthenticated(session !== null);
}

function getOpenRouterApiKeyForModel(model: string, session: Session | null): string {
  const source = getReaderAiModelSource(model, paidReaderAiModelIds);
  if (source === 'paid') {
    if (!session) {
      throw new ClientError('Selected paid model requires sign in', 401);
    }
    if (!OPENROUTER_PAID_API_KEY) {
      throw new ClientError('Selected paid model is not configured on this server', 503);
    }
    return OPENROUTER_PAID_API_KEY;
  }
  if (!OPENROUTER_API_KEY) {
    throw new ClientError('Selected free model is not configured on this server', 503);
  }
  return OPENROUTER_API_KEY;
}

function openRouterHeaders(req: http.IncomingMessage, apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': APP_URL || requestBaseUrl(req),
    'X-Title': 'Input Reader AI',
  };
}

function openRouterPromptCacheControl(model: string): { type: 'ephemeral' } | undefined {
  return shouldUseOpenRouterPromptCaching(model, paidReaderAiModelIds) ? { type: 'ephemeral' } : undefined;
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
    const trimmed = stripCriticMarkupComments(content).trim();
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
  session: Session | null,
): Promise<string> {
  const parts: string[] = [];
  if (existingSummary) parts.push(`Previous summary:\n${existingSummary}`);
  for (const msg of evictedMessages) {
    parts.push(prepareMessageForSummary(msg));
  }
  const toSummarize = parts.join('\n\n');

  const apiKey = getOpenRouterApiKeyForModel(model, session);
  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(req, apiKey),
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
      ...(openRouterPromptCacheControl(model) ? { cache_control: openRouterPromptCacheControl(model) } : {}),
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

async function fetchReaderAiModels(req: http.IncomingMessage, session: Session | null): Promise<ReaderAiModelEntry[]> {
  const scope = readerAiModelAccessScopeForSession(session);
  const now = Date.now();
  const cached = readerAiModelsCache.get(scope);
  if (cached && cached.expiresAt > now) return cached.value;

  // Stampede protection: if another request is already fetching, reuse it
  const inFlight = readerAiModelsFetchPromise.get(scope);
  if (inFlight) return inFlight;
  const promise = fetchReaderAiModelsUncached(req, scope).finally(() => {
    readerAiModelsFetchPromise.delete(scope);
  });
  readerAiModelsFetchPromise.set(scope, promise);
  return promise;
}

async function fetchReaderAiModelsUncached(
  req: http.IncomingMessage,
  scope: ReaderAiModelAccessScope,
): Promise<ReaderAiModelEntry[]> {
  const now = Date.now();
  const modelsById = new Map<string, ReaderAiModelEntry>();

  if (OPENROUTER_API_KEY) {
    const upstream = await fetch('https://openrouter.ai/api/v1/models', {
      headers: openRouterHeaders(req, OPENROUTER_API_KEY),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });

    const payload = (await upstream.json().catch(() => null)) as OpenRouterModelsResponse | null;
    if (!upstream.ok) {
      const message = `OpenRouter model listing failed (${upstream.status})`;
      throw new ClientError(message, 502);
    }

    const data = Array.isArray(payload?.data) ? payload.data : [];
    for (const entry of data) {
      const id = typeof entry.id === 'string' ? entry.id : '';
      const name = typeof entry.name === 'string' ? entry.name : id;
      if (!id.endsWith(':free')) continue;
      const supportedParams = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
      if (!supportedParams.includes('tools')) continue;
      const paramsBillions = modelParamsEstimateBillions(entry);
      if (paramsBillions === null || paramsBillions < READER_AI_MIN_MODEL_PARAMS_B) continue;
      const rawCtx = typeof entry.context_length === 'number' ? entry.context_length : 0;
      const context_length = Number.isFinite(rawCtx) && rawCtx > 0 ? rawCtx : 0;
      const normalizedId = normalizeReaderAiModelText(id);
      const normalizedName = normalizeReaderAiModelText(name);
      const hidden = HIDDEN_FREE_MODEL_PATTERNS.some((pattern) => {
        const normalizedPattern = normalizeReaderAiModelText(pattern);
        return normalizedId.includes(normalizedPattern) || normalizedName.includes(normalizedPattern);
      });
      if (hidden) continue;
      const featured = FEATURED_MODEL_PATTERNS.some((pattern) => {
        const p = normalizeReaderAiModelText(pattern);
        return normalizedId.includes(p) || normalizedName.includes(p);
      });
      modelsById.set(id, { id, name, context_length, ...(featured ? { featured: true } : {}) });
    }
  }

  if (scope === 'with_paid' && OPENROUTER_PAID_API_KEY) {
    for (const model of OPENROUTER_PAID_MODELS) {
      modelsById.set(model.id, model);
    }
  }

  const models = [...modelsById.values()].sort((a, b) => a.name.localeCompare(b.name));

  readerAiModelsCache.set(scope, { value: models, expiresAt: now + READER_AI_MODELS_CACHE_TTL_MS });
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
  const authedRes = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });

  if (!GITHUB_TOKEN) return authedRes;

  const retryMessage = await readGitHubErrorMessage(authedRes.clone(), '');
  if (!isPublicPatPolicyFailure(authedRes.status, retryMessage)) return authedRes;

  const retryHeaders = { ...headers };
  delete retryHeaders.Authorization;
  console.warn(`[github] ${path} -> retrying public request without GITHUB_TOKEN after PAT policy rejection`);
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: retryHeaders,
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
  const includeGists = ctx.url.searchParams.get('include_gists') !== '0';
  const state = createOAuthState(returnTo);
  const redirectUri = `${oauthBaseUrl(ctx.req)}/api/auth/github/callback`;
  console.log(`[auth] OAuth start: redirect_uri=${redirectUri}, return_to=${returnTo}`);
  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', includeGists ? 'gist read:user' : 'read:user');
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
  json(ctx.res, 200, authSessionResponse(session));
}

async function handleAuthLogout(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  const session = getSession(ctx.req);
  if (session && GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
    // Revoke the OAuth token server-side so it cannot be reused. The gist scope
    // grants write access, so we don't want stale tokens lingering after logout.
    // Failures here are non-fatal — the session is destroyed regardless.
    try {
      const credentials = Buffer.from(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`).toString('base64');
      await fetch(`https://api.github.com/applications/${GITHUB_CLIENT_ID}/token`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/json',
          'User-Agent': 'input-github-app-auth-server',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: session.githubAccessToken }),
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn('[auth] Failed to revoke OAuth token on logout:', err);
    }
  }
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

  let installation: GitHubInstallation;
  try {
    installation = await fetchGitHubInstallation(installationId);
  } catch {
    json(ctx.res, 403, { error: 'Invalid installation' });
    return;
  }

  session.installationId = installationId;
  rememberInstallationForUser(session.githubUserId, {
    installationId,
    accountLogin: installation.account?.login ?? null,
    accountType: installation.account?.type ?? null,
    accountAvatarUrl: installation.account?.avatar_url ?? null,
    accountHtmlUrl: installation.account?.html_url ?? null,
  });
  refreshSession(session, ctx.res);
  json(ctx.res, 200, {
    installationId,
    installations: listInstallationsForUser(session.githubUserId),
  });
}

async function handleDisconnectInstallation(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const body = await readJson(ctx.req).catch(() => undefined);
  const installationId = typeof body?.installationId === 'string' ? body.installationId : null;
  if (installationId) {
    session.installationId = removeInstallationForUser(session.githubUserId, installationId);
  } else {
    session.installationId = null;
    clearRememberedInstallationForUser(session.githubUserId);
  }
  refreshSession(session, ctx.res);
  json(ctx.res, 200, {
    ok: true,
    installationId: session.installationId,
    installations: listInstallationsForUser(session.githubUserId),
  });
}

async function handleSelectInstallation(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const body = await readJson(ctx.req);
  const installationId = body?.installationId;
  if (!installationId || typeof installationId !== 'string') {
    json(ctx.res, 400, { error: 'installationId is required' });
    return;
  }
  if (!selectInstallationForUser(session.githubUserId, installationId)) {
    json(ctx.res, 403, { error: 'Installation is not linked to this user' });
    return;
  }
  session.installationId = installationId;
  refreshSession(session, ctx.res);
  json(ctx.res, 200, {
    installationId,
    installations: listInstallationsForUser(session.githubUserId),
  });
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
  if (
    await gitHubResponseFailed(ctx.res, ghRes, `/gists/${encodeURIComponent(ctx.match[1])} [DELETE]`, {
      throw401: true,
    })
  )
    return;
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
    if (await gitHubResponseFailed(ctx.res, ghRes, `/installation/repositories?page=${page}`)) return;
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
    if (isRootContentsRequest(pathParam) && isEmptyGitRepositoryError(ghRes.status, err?.message ?? '')) {
      copyGitHubRateLimitHeaders(ctx.res, ghRes);
      json(ctx.res, 200, []);
      return;
    }
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghUrl);
    return;
  }
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
  json(ctx.res, 200, data);
}

function estimateBase64DecodedBytes(input: string): number {
  const normalized = input.replace(/\s+/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const decoded = Math.floor((normalized.length * 3) / 4) - padding;
  return Math.max(0, decoded);
}

function normalizeRepoPathFromRoute(path: string): string {
  return decodeURIComponent(path).replace(/^\/+/, '');
}

function assertMarkdownRepoFileData(
  data: RepoContentsFileData | null,
  notMarkdownMessage: string,
): asserts data is RepoContentsFileData & {
  type: 'file';
  path: string;
  sha: string;
  content: string;
  encoding: 'base64';
} {
  if (!data || data.type !== 'file' || typeof data.sha !== 'string' || typeof data.path !== 'string') {
    throw new ClientError('Expected a file', 400);
  }
  if (!data.path.toLowerCase().endsWith('.md')) {
    throw new ClientError(notMarkdownMessage, 400);
  }
  if (typeof data.content !== 'string' || data.encoding !== 'base64') {
    throw new ClientError('Unexpected file payload from GitHub', 502);
  }
}

async function fetchRepoMarkdownFile(
  res: http.ServerResponse,
  installationId: string,
  owner: string,
  repo: string,
  path: string,
  notMarkdownMessage = 'Only markdown files can be shared',
): Promise<RepoContentsFileData & { type: 'file'; path: string; sha: string; content: string; encoding: 'base64' }> {
  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(path)}`;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghPath);
  const data = (await ghRes.json().catch(() => null)) as RepoContentsFileData | null;
  if (!ghRes.ok) {
    const message = (data as GitHubApiError | null)?.message ?? 'GitHub API error';
    copyGitHubRateLimitHeaders(res, ghRes);
    throw new ClientError(message, ghRes.status >= 400 && ghRes.status < 500 ? ghRes.status : 502);
  }
  copyGitHubRateLimitHeaders(res, ghRes);
  assertMarkdownRepoFileData(data, notMarkdownMessage);
  return data;
}

async function requireSharedEditorRepoFileAccess(
  res: http.ServerResponse,
  session: Session,
  owner: string,
  repo: string,
  path: string,
): Promise<{
  installationId: string;
  file: RepoContentsFileData & { type: 'file'; path: string; sha: string; content: string; encoding: 'base64' };
}> {
  const installationId = await getRepoInstallationId(owner, repo);
  const file = await fetchRepoMarkdownFile(
    res,
    installationId,
    owner,
    repo,
    path,
    'Only markdown files can be shared with editors',
  );
  const markdown = Buffer.from(file.content, 'base64').toString('utf8');
  if (!canGitHubUserEditMarkdownDocument(markdown, session.githubLogin)) {
    throw new ClientError('You do not have editor access to this document', 403);
  }
  return { installationId, file };
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
  if (estimateBase64DecodedBytes(content) > MAX_UPLOAD_BYTES) {
    throw new ClientError('File too large (max 5 MB)', 413);
  }
  const sha = typeof body?.sha === 'string' ? body.sha : undefined;
  const branch = typeof body?.branch === 'string' ? body.branch : undefined;
  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(pathParam)}`;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha, branch }),
  });
  if (await gitHubResponseFailed(ctx.res, ghRes, ghPath)) return;
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
  if (await gitHubResponseFailed(ctx.res, ghRes, ghPath)) return;
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
  if (!isInstallationLinkedForUser(session.githubUserId, installationId)) throw new ClientError('Forbidden', 403);

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
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
  if (!data.path.toLowerCase().endsWith('.md')) throw new ClientError('Only markdown files can be shared', 400);

  const shareLink = createOrReuseRepoFileShareLink({
    githubUserId: session.githubUserId,
    installationId,
    owner,
    repo,
    path: data.path,
    baseUrl: canonicalAppBaseUrl(ctx.req),
    nowMs: Date.now(),
    ttlSeconds: SHARE_TOKEN_TTL_SECONDS,
    secret: SHARE_TOKEN_SECRET,
  });
  json(ctx.res, 200, shareLink);
}

async function handleListRepoFileShares(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  if (!SHARE_TOKEN_SECRET) {
    json(ctx.res, 503, SHARE_LINKS_NOT_CONFIGURED_ERROR);
    return;
  }

  const { installationId, repoFullName, path } = parseShareRepoFileListQuery(ctx.url);
  if (!path.toLowerCase().endsWith('.md')) throw new ClientError('Only markdown files can be shared', 400);
  if (!isInstallationLinkedForUser(session.githubUserId, installationId)) throw new ClientError('Forbidden', 403);

  const { owner, repo } = splitRepoFullName(repoFullName);
  const links = listRepoFileShareLinkResponses({
    githubUserId: session.githubUserId,
    installationId,
    owner,
    repo,
    path,
  });
  json(ctx.res, 200, { links });
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
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
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

async function handleGetSharedRepoFileByRef(ctx: RouteContext): Promise<void> {
  if (!checkRateLimit(ctx.req, ctx.res)) return;
  if (!SHARE_TOKEN_SECRET) {
    json(ctx.res, 503, SHARE_LINKS_NOT_CONFIGURED_ERROR);
    return;
  }

  const owner = decodeURIComponent(ctx.match[1]);
  const repo = decodeURIComponent(ctx.match[2]);
  const path = decodeURIComponent(ctx.match[3]);
  const token = ctx.url.searchParams.get('t');
  if (!token) throw new ClientError('Missing share token', 400);

  const payload = verifyRepoFileShareToken(SHARE_TOKEN_SECRET, token, Date.now(), { owner, repo, path });
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
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
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

async function handleGetEditorSharedRepoFile(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;

  const owner = decodeURIComponent(ctx.match[1]);
  const repo = decodeURIComponent(ctx.match[2]);
  const path = normalizeRepoPathFromRoute(ctx.match[3]);
  const { installationId, file } = await requireSharedEditorRepoFileAccess(ctx.res, session, owner, repo, path);

  json(ctx.res, 200, {
    owner,
    repo,
    path: file.path,
    name: file.name ?? file.path.split('/').pop() ?? file.path,
    sha: file.sha,
    content: file.content,
    encoding: file.encoding,
    installationId,
  });
}

async function handlePutEditorSharedRepoFile(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;

  const owner = decodeURIComponent(ctx.match[1]);
  const repo = decodeURIComponent(ctx.match[2]);
  const path = normalizeRepoPathFromRoute(ctx.match[3]);
  const body = (await readJson(ctx.req)) as EditorShareRepoFileUpdateBody | null;
  const message = requireString(body, 'message');
  const content = body?.content;
  if (typeof content !== 'string') throw new ClientError('content is required', 400);
  if (estimateBase64DecodedBytes(content) > MAX_UPLOAD_BYTES) {
    throw new ClientError('File too large (max 5 MB)', 413);
  }
  const sha = typeof body?.sha === 'string' ? body.sha : undefined;

  // TOCTOU: The file could be updated between this read (used for authorization + editors
  // validation) and the subsequent PUT. In the worst case a concurrent write could remove
  // this user from the editors list or change the editors, and our PUT would still go
  // through. The `sha` parameter mitigates this for normal usage — GitHub will reject the
  // PUT with 409 if the file changed — but `sha` is optional, so a request without it
  // could bypass the conflict check. This is acceptable because the GitHub App's
  // installation token (not the user's token) performs the write, so the blast radius is
  // limited to a single stale-read race, and the editors validation below ensures the
  // *content being written* still preserves the editors list.
  const { installationId, file } = await requireSharedEditorRepoFileAccess(ctx.res, session, owner, repo, path);
  const originalMarkdown = Buffer.from(file.content, 'base64').toString('utf8');
  const newMarkdown = Buffer.from(content, 'base64').toString('utf8');
  const editorsError = validateEditorsPreserved(originalMarkdown, newMarkdown);
  if (editorsError) {
    throw new ClientError(editorsError, 403);
  }
  const ghPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(path)}`;
  const ghRes = await githubFetchWithInstallationToken(installationId, ghPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha }),
  });
  if (await gitHubResponseFailed(ctx.res, ghRes, ghPath)) return;
  json(ctx.res, 200, await ghRes.json());
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
    const message = await readGitHubErrorMessage(ghRes);
    respondGitHubError(ctx.res, ghRes, message, ghPath);
    return;
  }

  ctx.res.statusCode = 200;
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
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
    if (isRootContentsRequest(pathParam) && isEmptyGitRepositoryError(ghRes.status, err?.message ?? '')) {
      copyGitHubRateLimitHeaders(ctx.res, ghRes);
      json(ctx.res, 200, []);
      return;
    }
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghUrl);
    return;
  }
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
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
    const message = await readGitHubErrorMessage(ghRes);
    respondGitHubError(ctx.res, ghRes, message, ghPath);
    return;
  }

  ctx.res.statusCode = 200;
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
  ctx.res.setHeader('Content-Type', ghRes.headers.get('content-type') ?? 'application/octet-stream');
  ctx.res.setHeader('Cache-Control', 'public, max-age=300');
  const body = Buffer.from(await ghRes.arrayBuffer());
  ctx.res.end(body);
}

type GitTreeEntry = { path: string; type: string; sha: string; size?: number; url?: string };
type GitBlobTreeEntry = GitTreeEntry & { mode: string; type: 'blob' };
interface GitHubCommitListItem {
  sha?: string;
  parents?: Array<{ sha?: string }>;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  html_url?: string;
}

type ApiTreeEntry = {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size?: number;
};

function mapApiTreeEntryType(type: string): ApiTreeEntry['type'] | null {
  if (type === 'blob') return 'file';
  if (type === 'tree') return 'dir';
  if (type === 'commit') return 'submodule';
  // GitHub tree API may report symlinks as blob entries with mode 120000 in other endpoints.
  // Keep explicit support for forward-compatibility.
  if (type === 'symlink') return 'symlink';
  return null;
}

function entriesFromTree(tree: GitTreeEntry[]): ApiTreeEntry[] {
  const entries: ApiTreeEntry[] = [];
  for (const entry of tree) {
    const mapped = mapApiTreeEntryType(entry.type);
    if (!mapped) continue;
    const slash = entry.path.lastIndexOf('/');
    entries.push({
      type: mapped,
      name: slash === -1 ? entry.path : entry.path.slice(slash + 1),
      path: entry.path,
      sha: entry.sha,
      size: typeof entry.size === 'number' ? entry.size : undefined,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

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

function normalizeRepoRelativePath(input: string): string {
  const normalized = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) throw new ClientError('Invalid path', 400);
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new ClientError('Invalid path', 400);
  return normalized;
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
  const data = (await ghRes.json().catch(() => null)) as {
    tree?: GitTreeEntry[];
    truncated?: boolean;
    message?: string;
  } | null;
  if (!ghRes.ok) {
    const err = data as GitHubApiError | null;
    if (isEmptyGitRepositoryError(ghRes.status, err?.message ?? '')) {
      copyGitHubRateLimitHeaders(ctx.res, ghRes);
      json(ctx.res, 200, { files: [], entries: [], truncated: false });
      return;
    }
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
  json(ctx.res, 200, {
    files: filesFromTree(data?.tree ?? [], markdownOnly),
    entries: entriesFromTree(data?.tree ?? []),
    truncated: data?.truncated ?? false,
  });
}

async function handleListRecentCommits(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];
  const requestedPerPage = Number(ctx.url.searchParams.get('per_page') || '20');
  const perPage = Number.isFinite(requestedPerPage) ? Math.min(20, Math.max(1, Math.floor(requestedPerPage))) : 20;

  const recentCommitsQuery = `
    query RecentCommits($owner: String!, $repo: String!, $perPage: Int!) {
      repository(owner: $owner, name: $repo) {
        defaultBranchRef {
          name
          target {
            ... on Commit {
              history(first: $perPage) {
                nodes {
                  oid
                  message
                  committedDate
                  url
                  parents(first: 10) {
                    totalCount
                  }
                  author {
                    name
                    date
                  }
                  committer {
                    date
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const recentCommitsPayload = await githubGraphqlWithInstallationToken<{
    repository?: {
      defaultBranchRef?: {
        name?: string | null;
        target?: {
          history?: {
            nodes?: Array<{
              oid?: string | null;
              message?: string | null;
              committedDate?: string | null;
              url?: string | null;
              parents?: { totalCount?: number | null } | null;
              author?: { name?: string | null; date?: string | null } | null;
              committer?: { date?: string | null } | null;
            } | null> | null;
          } | null;
        } | null;
      } | null;
    } | null;
  }>(installationId, recentCommitsQuery, { owner, repo, perPage });
  const graphqlMessage =
    recentCommitsPayload.errors
      ?.map((entry: { message?: string }) => entry.message)
      .filter((message): message is string => typeof message === 'string' && message.trim().length > 0)
      .join('; ') ?? '';
  const branch = recentCommitsPayload.data?.repository?.defaultBranchRef?.name?.trim() ?? '';
  if (!branch) {
    if (/could not resolve to a repository|not found/i.test(graphqlMessage)) {
      throw new ClientError('Repository not found', 404);
    }
    throw new ClientError(graphqlMessage || 'Failed to load repository metadata', 502);
  }
  const commitNodes = recentCommitsPayload.data?.repository?.defaultBranchRef?.target?.history?.nodes ?? [];
  const commits = commitNodes
    .map((commit: (typeof commitNodes)[number], index: number) => {
      const sha = typeof commit?.oid === 'string' ? commit.oid : '';
      if (!sha) return null;
      const message = typeof commit?.message === 'string' ? commit.message : '';
      const summary = message.split('\n', 1)[0] ?? '';
      return {
        sha,
        shortSha: sha.slice(0, 7),
        summary,
        message,
        authoredAt: typeof commit?.author?.date === 'string' ? commit.author.date : null,
        committedAt: typeof commit?.committer?.date === 'string' ? commit.committer.date : null,
        authorName: typeof commit?.author?.name === 'string' ? commit.author.name : null,
        parentCount: typeof commit?.parents?.totalCount === 'number' ? commit.parents.totalCount : 0,
        htmlUrl: typeof commit?.url === 'string' ? commit.url : null,
        isHead: index === 0,
      };
    })
    .filter((commit): commit is NonNullable<typeof commit> => commit !== null);

  json(ctx.res, 200, {
    branch,
    headSha: commits[0]?.sha ?? null,
    commits,
    pageSize: perPage,
    hasMore: commits.length === perPage,
  });
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
    if (isEmptyGitRepositoryError(ghRes.status, err?.message ?? '')) {
      copyGitHubRateLimitHeaders(ctx.res, ghRes);
      json(ctx.res, 200, { files: [], entries: [], truncated: false });
      return;
    }
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
  json(ctx.res, 200, {
    files: filesFromTree(data?.tree ?? [], markdownOnly),
    entries: entriesFromTree(data?.tree ?? []),
    truncated: data?.truncated ?? false,
  });
}

async function fetchRepositoryBranchState(
  installationId: string,
  owner: string,
  repo: string,
): Promise<{
  repositoryId: string;
  defaultBranch: string;
  headSha: string;
  baseTreeSha: string;
  tree: GitTreeEntry[];
}> {
  const branchState = await getGitHubRepositoryBranchState(installationId, owner, repo);
  const treePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branchState.baseTreeSha)}?recursive=1`;
  const treeRes = await githubFetchWithInstallationToken(installationId, treePath);
  const treeData = (await treeRes.json().catch(() => null)) as {
    tree?: GitTreeEntry[];
    truncated?: boolean;
    message?: string;
  } | null;
  if (!treeRes.ok || !Array.isArray(treeData?.tree)) {
    if (treeRes.status === 401) throw new ClientError('Unauthorized', 401);
    throw new ClientError(treeData?.message ?? 'Failed to load repository tree', 502);
  }
  if (treeData.truncated) throw new ClientError('Repository tree is too large to load atomically', 413);
  return { ...branchState, tree: treeData.tree };
}

async function loadRepoBranchState(
  installationId: string,
  owner: string,
  repo: string,
): Promise<{
  repositoryId: string;
  branch: string;
  headSha: string;
  baseTreeSha: string;
  blobsByPath: Map<string, GitBlobTreeEntry>;
}> {
  const branchState = await fetchRepositoryBranchState(installationId, owner, repo);
  const blobsByPath = new Map<string, GitBlobTreeEntry>();
  for (const entry of branchState.tree) {
    if (entry.type !== 'blob') continue;
    const mode = (entry as GitTreeEntry & { mode?: string }).mode;
    if (typeof mode !== 'string') continue;
    blobsByPath.set(entry.path, { ...entry, mode, type: 'blob' });
  }
  return {
    repositoryId: branchState.repositoryId,
    branch: branchState.defaultBranch,
    headSha: branchState.headSha,
    baseTreeSha: branchState.baseTreeSha,
    blobsByPath,
  };
}

async function updateBranchRefAtomically(
  installationId: string,
  repositoryId: string,
  branch: string,
  expectedHeadSha: string,
  nextHeadSha: string,
  _force = true,
): Promise<{ conflict: boolean }> {
  try {
    await atomicForceUpdateGitHubRef(
      installationId,
      repositoryId,
      `refs/heads/${branch}`,
      expectedHeadSha,
      nextHeadSha,
    );
    return { conflict: false };
  } catch (err) {
    if (err instanceof ClientError && err.statusCode === 409) return { conflict: true };
    throw err;
  }
}

async function handleGitBatchMutation(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];

  const body = await readJson(ctx.req);
  const message = requireString(body, 'message');
  const renames = Array.isArray(body?.renames)
    ? body.renames.map((item) => {
        if (!item || typeof item !== 'object') throw new ClientError('Invalid rename entry', 400);
        const from = normalizeRepoRelativePath(requireString(item, 'from'));
        const to = normalizeRepoRelativePath(requireString(item, 'to'));
        return { from, to };
      })
    : [];
  const deletes = Array.isArray(body?.deletes)
    ? body.deletes.map((path) => normalizeRepoRelativePath(String(path)))
    : [];
  const creates = Array.isArray(body?.creates)
    ? body.creates.map((item) => {
        if (!item || typeof item !== 'object') throw new ClientError('Invalid create entry', 400);
        const path = normalizeRepoRelativePath(requireString(item, 'path'));
        const content = typeof item.content === 'string' ? item.content : '';
        return { path, content };
      })
    : [];
  if (renames.length === 0 && deletes.length === 0 && creates.length === 0) {
    throw new ClientError('At least one of renames, deletes, or creates is required', 400);
  }
  if (renames.some((entry) => entry.from === entry.to)) {
    throw new ClientError('Rename source and destination must differ', 400);
  }

  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branchState = await fetchRepositoryBranchState(installationId, owner, repo);
  const branch = branchState.defaultBranch;
  const headSha = branchState.headSha;
  const baseTreeSha = branchState.baseTreeSha;
  const treeData = { tree: branchState.tree } as const;

  const blobsByPath = new Map<string, GitBlobTreeEntry>();
  for (const entry of treeData.tree as Array<GitTreeEntry & { mode?: string }>) {
    if (entry.type !== 'blob') continue;
    if (typeof entry.mode !== 'string') continue;
    blobsByPath.set(entry.path, { ...entry, mode: entry.mode, type: 'blob' });
  }

  const deletePaths = new Set<string>(deletes);
  const renameSources = new Set(renames.map((entry) => entry.from));
  const plannedDeletes = new Set<string>([...deletes, ...renameSources]);
  const plannedCreates = new Set<string>();

  for (const entry of renames) {
    if (plannedCreates.has(entry.to)) throw new ClientError(`Duplicate destination path: ${entry.to}`, 400);
    plannedCreates.add(entry.to);
  }
  for (const entry of creates) {
    if (plannedCreates.has(entry.path)) throw new ClientError(`Duplicate create path: ${entry.path}`, 400);
    plannedCreates.add(entry.path);
  }

  for (const entry of renames) {
    if (!blobsByPath.has(entry.from)) throw new ClientError(`Source file not found: ${entry.from}`, 404);
    if (blobsByPath.has(entry.to) && !plannedDeletes.has(entry.to)) {
      throw new ClientError(`Destination already exists: ${entry.to}`, 409);
    }
  }
  for (const path of deletePaths) {
    if (!blobsByPath.has(path)) throw new ClientError(`Delete target not found: ${path}`, 404);
  }
  for (const entry of creates) {
    if (blobsByPath.has(entry.path) && !plannedDeletes.has(entry.path)) {
      throw new ClientError(`Create destination already exists: ${entry.path}`, 409);
    }
  }

  const treeMutations: Array<{
    path: string;
    mode: string;
    type: 'blob';
    sha?: string | null;
    content?: string;
  }> = [];
  for (const path of deletePaths) {
    const source = blobsByPath.get(path);
    if (!source) continue;
    treeMutations.push({ path, mode: source.mode, type: 'blob', sha: null });
  }
  for (const entry of renames) {
    const source = blobsByPath.get(entry.from);
    if (!source) continue;
    if (!deletePaths.has(entry.from)) {
      treeMutations.push({ path: entry.from, mode: source.mode, type: 'blob', sha: null });
    }
    treeMutations.push({ path: entry.to, mode: source.mode, type: 'blob', sha: source.sha });
  }
  for (const entry of creates) {
    treeMutations.push({ path: entry.path, mode: '100644', type: 'blob', content: entry.content });
  }

  const createTreePath = `${repoPath}/git/trees`;
  const createTreeRes = await githubFetchWithInstallationToken(installationId, createTreePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeMutations }),
  });
  const createdTree = (await createTreeRes.json().catch(() => null)) as { sha?: string; message?: string } | null;
  if (!createTreeRes.ok || typeof createdTree?.sha !== 'string') {
    if (createTreeRes.status === 401) throw new ClientError('Unauthorized', 401);
    respondGitHubError(ctx.res, createTreeRes, createdTree?.message ?? 'Failed to create tree', createTreePath);
    return;
  }

  const createCommitPath = `${repoPath}/git/commits`;
  const createCommitRes = await githubFetchWithInstallationToken(installationId, createCommitPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: createdTree.sha, parents: [headSha] }),
  });
  const createdCommit = (await createCommitRes.json().catch(() => null)) as { sha?: string; message?: string } | null;
  if (!createCommitRes.ok || typeof createdCommit?.sha !== 'string') {
    if (createCommitRes.status === 401) throw new ClientError('Unauthorized', 401);
    respondGitHubError(ctx.res, createCommitRes, createdCommit?.message ?? 'Failed to create commit', createCommitPath);
    return;
  }
  try {
    await updateBranchRefAtomically(
      installationId,
      branchState.repositoryId,
      branch,
      headSha,
      createdCommit.sha,
      false,
    );
  } catch (err) {
    if (err instanceof ClientError && err.statusCode === 409) {
      json(ctx.res, 409, {
        error: 'Repository changed while applying git batch update. Please retry.',
        code: 'repo_ref_conflict',
      });
      return;
    }
    throw err;
  }

  json(ctx.res, 200, {
    commitSha: createdCommit.sha,
    previousHeadSha: headSha,
    renamed: renames.length,
    deleted: deletes.length,
    created: creates.length,
  });
}

async function handleCompactRecentCommits(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  const installationId = requireMatchedInstallation(ctx, session, 1);
  const owner = ctx.match[2];
  const repo = ctx.match[3];
  const body = (await readJson(ctx.req)) as {
    head_sha?: unknown;
    selected_shas?: unknown;
    message?: unknown;
  } | null;
  const expectedHeadSha = typeof body?.head_sha === 'string' ? body.head_sha.trim() : '';
  const selectedShas = Array.isArray(body?.selected_shas)
    ? body.selected_shas.filter((sha): sha is string => typeof sha === 'string')
    : [];
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!expectedHeadSha) throw new ClientError('head_sha is required', 400);
  if (!message) throw new ClientError('message is required', 400);

  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branchState = await getGitHubRepositoryBranchState(installationId, owner, repo);
  const branch = branchState.defaultBranch;

  const commitsPath = `${repoPath}/commits?sha=${encodeURIComponent(branch)}&per_page=20&page=1`;
  const commitsRes = await githubFetchWithInstallationToken(installationId, commitsPath);
  const commitsData = (await commitsRes.json().catch(() => null)) as GitHubCommitListItem[] | GitHubApiError | null;
  if (!commitsRes.ok || !Array.isArray(commitsData)) {
    if (commitsRes.status === 401) throw new ClientError('Unauthorized', 401);
    const err = commitsData as GitHubApiError | null;
    respondGitHubError(ctx.res, commitsRes, err?.message ?? 'Failed to load recent commits', commitsPath);
    return;
  }

  const selection = (() => {
    try {
      return resolveCommitCompactionSelection(
        commitsData
          .map((commit) => ({
            sha: typeof commit.sha === 'string' ? commit.sha : '',
            parents: Array.isArray(commit.parents)
              ? commit.parents.map((parent) => (typeof parent.sha === 'string' ? parent.sha : '')).filter(Boolean)
              : [],
          }))
          .filter((commit) => commit.sha),
        selectedShas,
      );
    } catch (err) {
      throw new ClientError(err instanceof Error ? err.message : 'Invalid commit selection', 400);
    }
  })();

  const createCommitPath = `${repoPath}/git/commits`;
  const createCommitRes = await githubFetchWithInstallationToken(installationId, createCommitPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: branchState.baseTreeSha,
      parents: [selection.baseParentSha],
    }),
  });
  const createdCommit = (await createCommitRes.json().catch(() => null)) as { sha?: string; message?: string } | null;
  if (!createCommitRes.ok || typeof createdCommit?.sha !== 'string') {
    if (createCommitRes.status === 401) throw new ClientError('Unauthorized', 401);
    respondGitHubError(
      ctx.res,
      createCommitRes,
      createdCommit?.message ?? 'Failed to create compacted commit',
      createCommitPath,
    );
    return;
  }

  const updateRefsMutation = `
    mutation ForceUpdateRefAtomically($input: UpdateRefsInput!) {
      updateRefs(input: $input) {
        clientMutationId
      }
    }
  `;
  const updateRefsPayload = await githubGraphqlWithInstallationToken<{
    updateRefs?: { clientMutationId?: string | null };
  }>(installationId, updateRefsMutation, {
    input: {
      repositoryId: branchState.repositoryId,
      refUpdates: [
        {
          name: `refs/heads/${branch}`,
          beforeOid: expectedHeadSha,
          afterOid: createdCommit.sha,
          force: true,
        },
      ],
    },
  });
  const graphqlMessage =
    updateRefsPayload.errors
      ?.map((entry) => entry.message)
      .filter((message): message is string => typeof message === 'string' && message.trim().length > 0)
      .join('; ') ?? '';
  if (graphqlMessage) {
    if (/before oid|beforeOid|expected|stale|has moved|mismatch|not at/i.test(graphqlMessage)) {
      json(ctx.res, 409, {
        error: 'The branch changed while compacting commits. Reload and try again.',
        code: 'repo_ref_conflict',
      });
      return;
    }
    throw new ClientError(graphqlMessage, 502);
  }

  json(ctx.res, 200, {
    branch,
    previousHeadSha: selection.headSha,
    newHeadSha: createdCommit.sha,
    replacedCommitCount: selection.selectedCount,
  });
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

  try {
    const ghRes = await fetchPublicGitHub(`/gists/${encodeURIComponent(gistId)}`, {
      headers: cached?.etag ? { 'If-None-Match': cached.etag } : undefined,
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
    copyGitHubRateLimitHeaders(ctx.res, ghRes);
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
  ensureReaderAiConfigured(session);
  const models = await fetchReaderAiModels(ctx.req, session);
  json(ctx.res, 200, { models });
}

async function handleReaderAiApply(ctx: RouteContext): Promise<void> {
  const session = requireAuthSession(ctx);
  if (!checkRateLimitForSession(ctx, session)) return;
  // This endpoint intentionally consumes staged changes + file_contents from the client.

  const body = (await readJson(ctx.req)) as {
    context?: {
      kind?: unknown;
      gist_id?: unknown;
      installation_id?: unknown;
      repo_full_name?: unknown;
    };
    changes?: unknown;
    file_contents?: unknown;
    commit_message?: unknown;
  } | null;

  const context = body?.context;
  const kind = typeof context?.kind === 'string' ? context.kind : '';
  const commitMessage =
    typeof body?.commit_message === 'string' && body.commit_message.trim()
      ? body.commit_message.trim()
      : 'Apply AI-suggested changes';
  const changesRaw = body?.changes;
  const fileContentsRaw = body?.file_contents;

  if (!Array.isArray(changesRaw) || changesRaw.length === 0) {
    throw new ClientError('changes must be a non-empty array', 400);
  }
  if (!fileContentsRaw || typeof fileContentsRaw !== 'object') {
    throw new ClientError('file_contents must be an object', 400);
  }

  const changes = changesRaw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new ClientError('Invalid change entry', 400);
    const path = typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path.trim() : '';
    const type = typeof (entry as { type?: unknown }).type === 'string' ? (entry as { type: string }).type : '';
    if (!path) throw new ClientError('Change path is required', 400);
    if (type !== 'edit' && type !== 'create' && type !== 'delete') throw new ClientError('Invalid change type', 400);
    const originalContentRaw = (entry as { originalContent?: unknown }).originalContent;
    const originalContent =
      originalContentRaw === null || typeof originalContentRaw === 'string' ? (originalContentRaw ?? null) : undefined;
    const expectedVersion =
      originalContent === null || typeof originalContent === 'string'
        ? readerAiContentVersion(originalContent ?? '')
        : null;
    return {
      path,
      type,
      ...(originalContent !== undefined ? { originalContent } : {}),
      ...(expectedVersion ? { expectedVersion } : {}),
    } as {
      path: string;
      type: 'edit' | 'create' | 'delete';
      originalContent?: string | null;
      expectedVersion?: string;
    };
  });

  const fileContents = new Map(
    Object.entries(fileContentsRaw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  );

  const applied: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  let conflict: ReaderAiApplyConflictEntry | undefined;

  if (kind === 'gist') {
    const gistId = typeof context?.gist_id === 'string' ? context.gist_id : '';
    if (!gistId) throw new ClientError('context.gist_id is required', 400);
    const gistRes = await githubFetchWithUserToken(session, `/gists/${encodeURIComponent(gistId)}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    const gistData = (await gistRes.json().catch(() => null)) as {
      updated_at?: string;
      files?: Record<string, { content?: string | null } | null>;
      message?: string;
    } | null;
    if (!gistRes.ok) {
      respondGitHubError(
        ctx.res,
        gistRes,
        gistData?.message ?? 'GitHub API error',
        `/gists/${encodeURIComponent(gistId)}`,
      );
      return;
    }
    const gistUpdatedAt = typeof gistData?.updated_at === 'string' ? gistData.updated_at : null;
    const gistFiles = gistData?.files && typeof gistData.files === 'object' ? gistData.files : {};
    const gistUpdates: Record<string, { content: string } | null> = {};
    for (const change of changes) {
      const currentContent =
        change.type === 'create'
          ? null
          : typeof gistFiles?.[change.path]?.content === 'string'
            ? (gistFiles[change.path] as { content: string }).content
            : null;
      const currentVersion = readerAiContentVersion(currentContent ?? '');
      if (change.expectedVersion && change.expectedVersion !== currentVersion) {
        conflict = {
          path: change.path,
          reason: 'document_changed',
          message: 'The document changed after the AI generated this edit.',
          ...(typeof currentContent === 'string' ? { current_content: currentContent } : {}),
          ...(gistUpdatedAt ? { current_sha: gistUpdatedAt } : {}),
          expected_version: change.expectedVersion,
          current_version: currentVersion,
        };
        json(ctx.res, 200, { applied, failed, conflict });
        return;
      }
      if (change.type === 'delete') {
        gistUpdates[change.path] = null;
        continue;
      }
      const content = fileContents.get(change.path);
      if (typeof content !== 'string') {
        failed.push({ path: change.path, error: 'Modified content not found' });
        continue;
      }
      gistUpdates[change.path] = { content };
    }
    if (Object.keys(gistUpdates).length > 0) {
      const ghRes = await githubFetchWithUserToken(session, `/gists/${encodeURIComponent(gistId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: gistUpdates }),
      });
      if (await gitHubResponseFailed(ctx.res, ghRes, `/gists/${encodeURIComponent(gistId)}`, { throw401: true }))
        return;
      applied.push(...Object.keys(gistUpdates));
    }
    json(ctx.res, 200, { applied, failed, ...(conflict ? { conflict } : {}) });
    return;
  }

  if (kind === 'repo') {
    const installationId = typeof context?.installation_id === 'string' ? context.installation_id : '';
    const repoFullName = typeof context?.repo_full_name === 'string' ? context.repo_full_name : '';
    if (!installationId || !repoFullName) {
      throw new ClientError('context.installation_id and context.repo_full_name are required', 400);
    }
    if (!isInstallationLinkedForUser(session.githubUserId, installationId)) throw new ClientError('Forbidden', 403);
    const { owner, repo } = splitRepoFullName(repoFullName);

    if (changes.length > 1) {
      const normalizedChanges = changes.map((change) => ({
        ...change,
        normalizedPath: normalizeRepoRelativePath(change.path),
      }));
      const seenPaths = new Set<string>();
      const candidateChanges: Array<(typeof normalizedChanges)[number]> = [];
      for (const change of normalizedChanges) {
        if (seenPaths.has(change.normalizedPath)) {
          failed.push({ path: change.path, error: 'Duplicate path in staged changes' });
          continue;
        }
        seenPaths.add(change.normalizedPath);
        if (change.type !== 'delete' && typeof fileContents.get(change.path) !== 'string') {
          failed.push({ path: change.path, error: 'Modified content not found' });
          continue;
        }
        candidateChanges.push(change);
      }

      if (candidateChanges.length === 0) {
        json(ctx.res, 200, { applied, failed });
        return;
      }

      try {
        const branchState = await loadRepoBranchState(installationId, owner, repo);
        const { branch, headSha, baseTreeSha, blobsByPath } = branchState;

        const treeMutations: Array<{ path: string; mode: string; type: 'blob'; sha?: null; content?: string }> = [];
        const applyablePaths: string[] = [];

        for (const change of candidateChanges) {
          const existing = blobsByPath.get(change.normalizedPath);
          if (change.expectedVersion) {
            let currentContent: string | null = null;
            if (existing?.url) {
              const blobRes = await githubFetchWithInstallationToken(installationId, existing.url);
              const blobData = (await blobRes.json().catch(() => null)) as {
                content?: string;
                encoding?: string;
              } | null;
              if (blobRes.ok && typeof blobData?.content === 'string') {
                currentContent =
                  blobData.encoding === 'base64'
                    ? Buffer.from(blobData.content.replace(/\n/g, ''), 'base64').toString('utf8')
                    : blobData.content;
              }
            }
            const currentVersion = readerAiContentVersion(currentContent ?? '');
            if (currentVersion !== change.expectedVersion) {
              conflict = {
                path: change.path,
                reason: 'document_changed',
                message: 'The file changed after the AI generated this edit.',
                ...(typeof currentContent === 'string' ? { current_content: currentContent } : {}),
                ...(existing?.sha ? { current_sha: existing.sha } : {}),
                expected_version: change.expectedVersion,
                current_version: currentVersion,
              };
              json(ctx.res, 200, { applied, failed, conflict });
              return;
            }
          }
          if (change.type === 'delete') {
            if (!existing) {
              failed.push({ path: change.path, error: 'File not found' });
              continue;
            }
            treeMutations.push({ path: change.normalizedPath, mode: existing.mode, type: 'blob', sha: null });
            applyablePaths.push(change.path);
            continue;
          }

          const content = fileContents.get(change.path);
          if (typeof content !== 'string') {
            failed.push({ path: change.path, error: 'Modified content not found' });
            continue;
          }

          if (change.type === 'edit') {
            if (!existing) {
              failed.push({ path: change.path, error: 'File not found' });
              continue;
            }
            treeMutations.push({
              path: change.normalizedPath,
              mode: existing.mode,
              type: 'blob',
              content,
            });
            applyablePaths.push(change.path);
            continue;
          }

          if (existing) {
            failed.push({ path: change.path, error: 'File already exists' });
            continue;
          }
          treeMutations.push({
            path: change.normalizedPath,
            mode: '100644',
            type: 'blob',
            content,
          });
          applyablePaths.push(change.path);
        }

        if (treeMutations.length === 0) {
          json(ctx.res, 200, { applied, failed, ...(conflict ? { conflict } : {}) });
          return;
        }

        const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
        const createTreePath = `${repoPath}/git/trees`;
        const createTreeRes = await githubFetchWithInstallationToken(installationId, createTreePath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_tree: baseTreeSha, tree: treeMutations }),
        });
        const createdTree = (await createTreeRes.json().catch(() => null)) as { sha?: string } | null;
        if (typeof createdTree?.sha !== 'string') throw new Error('Failed to create tree');

        const createCommitPath = `${repoPath}/git/commits`;
        const createCommitRes = await githubFetchWithInstallationToken(installationId, createCommitPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: commitMessage, tree: createdTree.sha, parents: [headSha] }),
        });
        const createdCommit = (await createCommitRes.json().catch(() => null)) as { sha?: string } | null;
        if (typeof createdCommit?.sha !== 'string') throw new Error('Failed to create commit');

        const updateResult = await updateBranchRefAtomically(
          installationId,
          branchState.repositoryId,
          branch,
          headSha,
          createdCommit.sha,
          false,
        );
        if (updateResult.conflict) {
          failed.push(
            ...candidateChanges
              .filter((change) => !failed.some((entry) => entry.path === change.path))
              .map((change) => ({
                path: change.path,
                error: 'Repository changed while applying staged changes. Reload and try again.',
              })),
          );
          json(ctx.res, 200, { applied, failed });
          return;
        }

        applied.push(...applyablePaths);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const alreadyFailedPaths = new Set(failed.map((entry) => entry.path));
        for (const change of candidateChanges) {
          if (alreadyFailedPaths.has(change.path)) continue;
          failed.push({ path: change.path, error: message });
        }
      }

      json(ctx.res, 200, { applied, failed });
      return;
    }

    for (const change of changes) {
      try {
        const normalizedPath = normalizeRepoRelativePath(change.path);
        const contentsPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePathPreserveSlashes(normalizedPath)}`;
        if (change.type === 'delete') {
          const getRes = await githubFetchWithInstallationToken(installationId, contentsPath);
          if (getRes.status === 404) {
            failed.push({ path: change.path, error: 'File not found' });
            continue;
          }
          if (!getRes.ok) {
            const message = await readGitHubErrorMessage(getRes);
            throw new Error(message);
          }
          const data = (await getRes.json().catch(() => null)) as {
            type?: string;
            sha?: string;
            content?: string;
            encoding?: string;
          } | null;
          if (!data || data.type !== 'file' || typeof data.sha !== 'string') {
            failed.push({ path: change.path, error: 'Expected a file' });
            continue;
          }
          const currentContent =
            typeof data.content === 'string'
              ? data.encoding === 'base64'
                ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
                : data.content
              : null;
          if (change.expectedVersion) {
            const currentVersion = readerAiContentVersion(currentContent ?? '');
            if (currentVersion !== change.expectedVersion) {
              conflict = {
                path: change.path,
                reason: 'document_changed',
                message: 'The file changed after the AI generated this edit.',
                ...(typeof currentContent === 'string' ? { current_content: currentContent } : {}),
                current_sha: data.sha,
                expected_version: change.expectedVersion,
                current_version: currentVersion,
              };
              json(ctx.res, 200, { applied, failed, conflict });
              return;
            }
          }
          const delRes = await githubFetchWithInstallationToken(installationId, contentsPath, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: normalizedPath, message: commitMessage, sha: data.sha }),
          });
          if (!delRes.ok) {
            const message = await readGitHubErrorMessage(delRes);
            throw new Error(message);
          }
          applied.push(change.path);
          continue;
        }

        const content = fileContents.get(change.path);
        if (typeof content !== 'string') {
          failed.push({ path: change.path, error: 'Modified content not found' });
          continue;
        }
        let sha: string | undefined;
        if (change.type === 'edit') {
          const getRes = await githubFetchWithInstallationToken(installationId, contentsPath);
          if (getRes.ok) {
            const data = (await getRes.json().catch(() => null)) as {
              type?: string;
              sha?: string;
              content?: string;
              encoding?: string;
            } | null;
            if (data?.type === 'file' && typeof data.sha === 'string') {
              sha = data.sha;
              if (change.expectedVersion) {
                const currentContent =
                  typeof data.content === 'string'
                    ? data.encoding === 'base64'
                      ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
                      : data.content
                    : null;
                const currentVersion = readerAiContentVersion(currentContent ?? '');
                if (currentVersion !== change.expectedVersion) {
                  conflict = {
                    path: change.path,
                    reason: 'document_changed',
                    message: 'The file changed after the AI generated this edit.',
                    ...(typeof currentContent === 'string' ? { current_content: currentContent } : {}),
                    current_sha: data.sha,
                    expected_version: change.expectedVersion,
                    current_version: currentVersion,
                  };
                  json(ctx.res, 200, { applied, failed, conflict });
                  return;
                }
              }
            }
          }
        }
        const putRes = await githubFetchWithInstallationToken(installationId, contentsPath, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: normalizedPath,
            message: commitMessage,
            content: Buffer.from(content, 'utf8').toString('base64'),
            ...(sha ? { sha } : {}),
          }),
        });
        if (!putRes.ok) {
          const message = await readGitHubErrorMessage(putRes);
          throw new Error(message);
        }
        applied.push(change.path);
      } catch (err) {
        failed.push({ path: change.path, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    json(ctx.res, 200, { applied, failed, ...(conflict ? { conflict } : {}) });
    return;
  }

  throw new ClientError('context.kind must be "gist" or "repo"', 400);
}

async function handleReaderAiChat(ctx: RouteContext): Promise<void> {
  const session = getSession(ctx.req);
  if (!checkRateLimitForSession(ctx, session)) return;
  ensureReaderAiConfigured(session);

  const body = (await readJson(ctx.req)) as ReaderAiChatBody | null;
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  const mode = body?.mode === 'prompt_list' ? 'prompt_list' : 'default';
  const rawSource = typeof body?.source === 'string' ? body.source : '';
  const source = stripCriticMarkupComments(rawSource).trim();
  if (!model) throw new ClientError('model is required', 400);
  if (!source && mode !== 'prompt_list') throw new ClientError('source is required', 400);
  if (!canAccessReaderAiModel(model, session !== null, paidReaderAiModelIds)) {
    throw new ClientError('Selected paid model requires sign in', 401);
  }
  const allowedModels = await fetchReaderAiModels(ctx.req, session);
  if (!allowedModels.some((m) => m.id === model)) {
    throw new ClientError('Selected model is not available', 400);
  }
  const allMessages = normalizeReaderAiMessages(body?.messages);
  const existingSummary =
    typeof body?.summary === 'string' ? body.summary.trim().slice(0, READER_AI_MAX_SUMMARY_CHARS) : '';

  const currentDocPath = typeof body?.current_doc_path === 'string' ? body.current_doc_path : null;
  const editModeCurrentDocOnly = body?.edit_mode_current_doc_only === true;
  const allowDocumentEdits = body?.allow_document_edits !== false;
  const aiLines = source.split('\n');

  let chatMessages: ReaderAiChatMessage[];
  let newSummary: string | null = null;
  let summarizationFailed = false;
  if (mode === 'prompt_list') {
    chatMessages = allMessages;
  } else if (allMessages.length <= READER_AI_CONTEXT_WINDOW_MESSAGES) {
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
      newSummary = await summarizeReaderAiConversation(model, evicted, existingSummary, ctx.req, session);
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
  const documentEditState = {
    source: rawSource,
    lines: rawSource.split('\n'),
    currentDocPath,
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  const modelEntry = allowedModels.find((m) => m.id === model);
  const contextTokens = modelEntry?.context_length || 0;

  // Build system prompt and tool set based on mode
  let systemPrompt: string;
  let tools: Array<(typeof READER_AI_TOOLS)[number]>;
  if (mode === 'prompt_list') {
    systemPrompt = buildReaderAiPromptListSystemPrompt();
    tools = [];
  } else {
    const maxPreviewChars =
      contextTokens > 0
        ? Math.min(READER_AI_DOC_PREVIEW_CHARS, Math.floor(contextTokens * 3 * 0.25))
        : READER_AI_DOC_PREVIEW_CHARS;
    systemPrompt = buildReaderAiSystemPrompt(source, aiLines, maxPreviewChars, currentDocPath, allowDocumentEdits);
    tools = !allowDocumentEdits
      ? READER_AI_TOOLS.filter((tool) => {
          const name = tool.function.name;
          return name === 'read_document' || name === 'search_document' || name === 'task';
        })
      : editModeCurrentDocOnly
        ? READER_AI_TOOLS.filter((tool) => {
            const name = tool.function.name;
            return name === 'read_document' || name === 'search_document' || name === 'propose_edit_document';
          })
        : READER_AI_TOOLS;
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

  const upstreamHeaders = openRouterHeaders(ctx.req, getOpenRouterApiKeyForModel(model, session));

  const callUpstream = (timeoutMs: number) =>
    fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify({
        model,
        stream: true,
        messages: openRouterMessages,
        tools,
        ...(openRouterPromptCacheControl(model) ? { cache_control: openRouterPromptCacheControl(model) } : {}),
      }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), abortController.signal]),
    });

  const remainingMs = () => Math.max(0, READER_AI_TIMEOUT_MS - (Date.now() - requestStart));
  const callTimeout = () => Math.min(READER_AI_PER_CALL_TIMEOUT_MS, remainingMs());

  // Token budget management — reserve space for system prompt, keep tool results within budget
  const maxContextTokens = contextTokens > 0 ? contextTokens : 32_000;
  // Reserve 25% for system prompt + file tree, 15% for output, 60% for conversation + tool results
  const conversationBudgetTokens = Math.floor(maxContextTokens * 0.6);

  const executeSyncToolCall = (tc: ReaderAiToolCall, argsJsonOverride?: string): string => {
    const toolArgsJson = argsJsonOverride ?? tc.arguments;
    if (tc.name === 'propose_edit_document') return executeReaderAiEditDocumentTool(toolArgsJson, documentEditState);
    return executeReaderAiSyncTool(tc.name, toolArgsJson, aiLines);
  };

  const writeSseEvent = (event: string, data: unknown) => {
    if (ctx.res.writableEnded) return;
    ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let lastStagedChangesSignature: string | null = null;
  let stagedChangesRevision = 0;
  const serializeReaderAiChange = (change: {
    id: string;
    path: string;
    type: 'edit' | 'create' | 'delete';
    diff: string;
    revision?: number;
    original: string | null;
    modified: string | null;
    hunks?: ReturnType<typeof parseUnifiedDiffHunks>;
  }) => ({
    id: change.id,
    path: change.path,
    type: change.type,
    diff: change.diff,
    revision: change.revision,
    original_content: change.original,
    modified_content: change.modified,
    hunks: change.hunks ?? parseUnifiedDiffHunks(change.diff),
  });
  const getCurrentDocumentStagedChange = () =>
    documentEditState.stagedContent && documentEditState.stagedDiff
      ? {
          id: `change:${currentDocPath || 'current-document.md'}`,
          path: currentDocPath || 'current-document.md',
          type: 'edit' as const,
          original: documentEditState.stagedOriginalContent ?? rawSource,
          modified: documentEditState.stagedContent,
          diff: documentEditState.stagedDiff,
          revision: documentEditState.stagedRevision,
          hunks: parseUnifiedDiffHunks(documentEditState.stagedDiff),
        }
      : null;
  const getChangeForToolCall = (toolName: string) => {
    if (toolName === 'propose_edit_document') return getCurrentDocumentStagedChange();
    return null;
  };
  const emitEditProposal = (toolCallId: string, toolName: string) => {
    const change = getChangeForToolCall(toolName);
    if (!change) return;
    writeSseEvent('edit_proposal', {
      proposal_id: `proposal:${stagedChangesRevision}:${toolCallId}`,
      tool_call_id: toolCallId,
      revision: stagedChangesRevision,
      change: serializeReaderAiChange(change),
    });
  };
  const emitStagedChangesSnapshot = () => {
    const hasDocumentStagedChange = Boolean(documentEditState.stagedContent && documentEditState.stagedDiff);
    const allChanges = hasDocumentStagedChange ? [getCurrentDocumentStagedChange()!] : [];
    const changes = allChanges.map((change) => serializeReaderAiChange({ ...change, revision: stagedChangesRevision }));
    const fileContents = Object.fromEntries(
      allChanges.filter((c) => typeof c.modified === 'string').map((c) => [c.path, c.modified as string]),
    );
    const suggestedCommitMessage =
      allChanges.length === 1 ? `Update ${allChanges[0].path}` : 'Apply AI-suggested changes';
    const payload = {
      changes,
      file_contents: fileContents,
      suggested_commit_message: suggestedCommitMessage,
      ...(documentEditState.stagedContent ? { document_content: documentEditState.stagedContent } : {}),
    };
    const signature = JSON.stringify(payload);
    if (signature === lastStagedChangesSignature || ctx.res.writableEnded) return;
    writeSseEvent('staged_changes', payload);
    lastStagedChangesSignature = signature;
  };

  let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

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
    keepaliveInterval = setInterval(() => {
      if (ctx.res.writableEnded) return;
      ctx.res.write(': keepalive\n\n');
    }, 15_000);

    // Agentic tool-call loop
    let currentBody: ReadableStream<Uint8Array> | null = firstUpstream.body;
    for (let iteration = 0; iteration < READER_AI_MAX_TOOL_ITERATIONS; iteration++) {
      writeSseEvent('turn_start', { iteration });
      let result: ReaderAiStreamParseResult;
      try {
        result = await parseReaderAiUpstreamStream(currentBody, writeSseDelta, {
          repairBoundaries: getReaderAiModelSource(model, paidReaderAiModelIds) === 'free',
        });
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
      const syncCalls: Array<{
        tc: ReaderAiToolCall;
        parsedArgs: Record<string, unknown> | undefined;
        parseError?: string;
        repaired?: boolean;
      }> = [];

      for (const tc of result.toolCalls) {
        const parsedArgsResult = parseToolArgumentsWithRepair(tc.arguments);
        const parsedArgs = parsedArgsResult.parsedArgs;
        if (parsedArgsResult.error) {
          console.warn('[reader-ai-tool-json]', {
            toolCallId: tc.id,
            toolName: tc.name,
            repaired: parsedArgsResult.repaired,
            error: parsedArgsResult.error,
            rawArgumentsPreview: tc.arguments.length > 300 ? `${tc.arguments.slice(0, 300)}…` : tc.arguments,
          });
        }
        writeSseEvent('tool_call', {
          id: tc.id,
          name: tc.name,
          arguments: parsedArgs ?? tc.arguments,
          parse_error: parsedArgsResult.error,
          repaired: parsedArgsResult.repaired,
        });

        if (tc.name === 'task') {
          if (parsedArgs) {
            taskCalls.push({ tc, parsedArgs });
          } else {
            // Task call with malformed JSON — return an error tool result rather than
            // silently falling through to the sync tool path (which would return "unknown tool: task").
            const retryMessage =
              'Arguments could not be parsed as JSON. Retry the task call with a valid JSON object that includes a "prompt" field.';
            openRouterMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: retryMessage,
            });
            writeSseEvent('tool_result', {
              id: tc.id,
              name: 'task',
              preview: '(invalid JSON arguments)',
              error: parsedArgsResult.error ?? 'Invalid JSON arguments',
              error_code: 'invalid_arguments',
            });
          }
        } else {
          syncCalls.push({
            tc,
            parsedArgs,
            parseError: parsedArgsResult.error ?? undefined,
            repaired: parsedArgsResult.repaired,
          });
        }
      }

      // Run sync tools first
      for (const { tc, parsedArgs, parseError, repaired } of syncCalls) {
        if (!parsedArgs && parseError) {
          const retryMessage = `Tool arguments could not be parsed as JSON. Retry ${tc.name} with valid JSON arguments.`;
          openRouterMessages.push({ role: 'tool', tool_call_id: tc.id, content: retryMessage });
          writeSseEvent('tool_result', {
            id: tc.id,
            name: tc.name,
            preview: '(invalid JSON arguments)',
            error: parseError,
            error_code: 'invalid_arguments',
            repaired,
          });
          continue;
        }

        const toolResult = executeSyncToolCall(tc, repaired && parsedArgs ? JSON.stringify(parsedArgs) : undefined);

        openRouterMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
        const resultPreview = toolResult.length > 200 ? `${toolResult.slice(0, 200)}...` : toolResult;
        const toolFailed =
          /^\((invalid JSON|unknown tool|file not found|old_text not found|path is required|content is required|new_text is required|old_text is required)/.test(
            toolResult,
          );
        writeSseEvent('tool_result', {
          id: tc.id,
          name: tc.name,
          preview: resultPreview,
          ...(toolFailed ? { error: toolResult } : {}),
          ...(toolFailed ? { error_code: classifyReaderAiToolErrorCode(toolResult) } : {}),
          ...(repaired ? { repaired: true } : {}),
        });
        if (tc.name === 'propose_edit_document') {
          stagedChangesRevision += 1;
          emitEditProposal(tc.id, tc.name);
          emitStagedChangesSnapshot();
        }
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
                lines: aiLines,
                source,
                openRouterHeaders: upstreamHeaders,
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
                error_code: classifyReaderAiTaskErrorCode(taskErr),
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
        const payload = rateLimitMsg ? null : ((await nextUpstream.json().catch(() => null)) as unknown);
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
        emitStagedChangesSnapshot();
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
        emitStagedChangesSnapshot();
        ctx.res.write('data: [DONE]\n\n');
        ctx.res.end();
      }
      return;
    }
    throw err;
  } finally {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    ctx.req.off('close', onClientClose);
  }

  // Emit the latest staged-change snapshot, including an empty payload if staged edits were reverted.
  emitStagedChangesSnapshot();

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
  if (!ghRes.ok) {
    const err = (await ghRes.json().catch(() => null)) as GitHubApiError | null;
    if (isEmptyGitRepositoryError(ghRes.status, err?.message ?? '')) {
      copyGitHubRateLimitHeaders(ctx.res, ghRes);
      json(ctx.res, 200, { files: [] });
      return;
    }
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }

  if (!ghRes.body) throw new ClientError('GitHub did not return a tarball body', 502);
  const files = await extractTarball(ghRes.body);
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
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
    if (isEmptyGitRepositoryError(ghRes.status, err?.message ?? '')) {
      copyGitHubRateLimitHeaders(ctx.res, ghRes);
      json(ctx.res, 200, { files: [] });
      return;
    }
    respondGitHubError(ctx.res, ghRes, err?.message ?? 'GitHub API error', ghPath);
    return;
  }
  if (!ghRes.body) throw new ClientError('GitHub did not return a tarball body', 502);
  const files = await extractTarball(ghRes.body);
  copyGitHubRateLimitHeaders(ctx.res, ghRes);
  json(ctx.res, 200, { files });
}

const CONTENTS_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/contents$/;
const RAW_CONTENT_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/raw$/;
const TREE_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/tree$/;
const COMMITS_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/commits$/;
const GIT_BATCH_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/git-batch$/;
const COMPACT_COMMITS_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/compact-commits$/;
const PUBLIC_REPO_CONTENTS_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/contents$/;
const PUBLIC_REPO_RAW_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/raw$/;
const PUBLIC_REPO_TREE_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/tree$/;
const TARBALL_PATTERN = /^\/api\/github-app\/installations\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/tarball$/;
const PUBLIC_REPO_TARBALL_PATTERN = /^\/api\/public\/repos\/([^/]+)\/([^/]+)\/tarball$/;
const SHARE_REPO_FILE_LIST_PATTERN = /^\/api\/share\/repo-file-links$/;
const SHARE_REPO_FILE_PATTERN = /^\/api\/share\/repo-file\/([^/]+)$/;
const SHARE_REPO_FILE_REF_PATTERN = /^\/api\/share\/repo-file\/([^/]+)\/([^/]+)\/(.+)$/;
const EDITOR_SHARE_REPO_FILE_PATTERN = /^\/api\/editor-share\/repo-file\/([^/]+)\/([^/]+)\/(.+)$/;

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
  { method: 'POST', pattern: /^\/api\/github-app\/installations\/select$/, handler: handleSelectInstallation },
  { method: 'POST', pattern: /^\/api\/github-app\/disconnect$/, handler: handleDisconnectInstallation },
  { method: 'POST', pattern: /^\/api\/share\/repo-file$/, handler: handleCreateRepoFileShare },
  { method: 'GET', pattern: SHARE_REPO_FILE_LIST_PATTERN, handler: handleListRepoFileShares },
  { method: 'GET', pattern: SHARE_REPO_FILE_PATTERN, handler: handleGetSharedRepoFile },
  { method: 'GET', pattern: SHARE_REPO_FILE_REF_PATTERN, handler: handleGetSharedRepoFileByRef },
  { method: 'GET', pattern: EDITOR_SHARE_REPO_FILE_PATTERN, handler: handleGetEditorSharedRepoFile },
  { method: 'PUT', pattern: EDITOR_SHARE_REPO_FILE_PATTERN, handler: handlePutEditorSharedRepoFile },
  { method: 'GET', pattern: /^\/api\/github-app\/installations\/([^/]+)\/repositories$/, handler: handleListRepos },
  { method: 'GET', pattern: CONTENTS_PATTERN, handler: handleGetContents },
  { method: 'PUT', pattern: CONTENTS_PATTERN, handler: handlePutContents },
  { method: 'DELETE', pattern: CONTENTS_PATTERN, handler: handleDeleteContents },
  { method: 'GET', pattern: RAW_CONTENT_PATTERN, handler: handleGetRawContent },
  { method: 'GET', pattern: TREE_PATTERN, handler: handleGetTree },
  { method: 'GET', pattern: COMMITS_PATTERN, handler: handleListRecentCommits },
  { method: 'POST', pattern: GIT_BATCH_PATTERN, handler: handleGitBatchMutation },
  { method: 'POST', pattern: COMPACT_COMMITS_PATTERN, handler: handleCompactRecentCommits },
  { method: 'GET', pattern: TARBALL_PATTERN, handler: handleRepoTarball },
  { method: 'GET', pattern: PUBLIC_REPO_CONTENTS_PATTERN, handler: handleGetPublicRepoContents },
  { method: 'GET', pattern: PUBLIC_REPO_RAW_PATTERN, handler: handleGetPublicRepoRaw },
  { method: 'GET', pattern: PUBLIC_REPO_TREE_PATTERN, handler: handleGetPublicTree },
  { method: 'GET', pattern: PUBLIC_REPO_TARBALL_PATTERN, handler: handlePublicRepoTarball },
  { method: 'GET', pattern: /^\/api\/gists\/([a-f0-9]+)$/i, handler: handleGetPublicGist },
  { method: 'GET', pattern: /^\/api\/ai\/models$/, handler: handleReaderAiModels },
  { method: 'POST', pattern: /^\/api\/ai\/apply$/, handler: handleReaderAiApply },
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
