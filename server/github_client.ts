import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GITHUB_FETCH_TIMEOUT_MS } from './config';
import { ClientError } from './errors';
import { base64url, requireEnv } from './http_helpers';
import type { TokenCacheRecord } from './types';

const installationTokenCache = new Map<string, TokenCacheRecord>();
const MAX_TOKEN_CACHE_SIZE = 1000;
const RATE_LIMIT_RE = /rate limit|secondary rate limit|abuse/i;

export function startInstallationTokenCacheCleanup(): void {
  setInterval(
    () => {
      const now = Date.now();
      for (const [key, record] of installationTokenCache) {
        if (record.expiresAtMs <= now) installationTokenCache.delete(key);
      }
    },
    5 * 60 * 1000,
  ).unref();
}

function cacheKey(installationId: string, repositoryIds?: number[]): string {
  if (!repositoryIds?.length) return `${installationId}:all`;
  return `${installationId}:${repositoryIds
    .map((n) => String(n))
    .sort()
    .join(',')}`;
}

async function getAppPrivateKeyPem(): Promise<string> {
  const keyInline = process.env.GITHUB_APP_PRIVATE_KEY;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (keyInline?.trim()) {
    return normalizeInlinePem(keyInline);
  }
  if (keyPath?.trim()) return readFile(keyPath, 'utf8');
  throw new Error('Missing GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH');
}

function normalizeInlinePem(rawValue: string): string {
  const trimmed = rawValue.trim();
  const withoutWrappingQuotes =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return withoutWrappingQuotes.replace(/\\n/g, '\n');
}

function readHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function parseGitHubErrorDetails(res: Response): Promise<{
  message: string;
  requestId: string | null;
  remaining: number | null;
  resetAt: string | null;
  isRateLimited: boolean;
}> {
  const text = await res.text().catch(() => '');
  let message = `GitHub API error: ${res.status}`;
  if (text) {
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        message = parsed.message.trim();
      }
    } catch {
      message = text.trim() || message;
    }
  }

  const requestId = res.headers.get('x-github-request-id');
  const remaining = readHeaderInt(res.headers, 'x-ratelimit-remaining');
  const reset = readHeaderInt(res.headers, 'x-ratelimit-reset');
  const resetAt = reset ? new Date(reset * 1000).toISOString() : null;
  const isRateLimited =
    res.status === 429 || RATE_LIMIT_RE.test(message) || ((remaining ?? 1) <= 0 && res.status >= 400);

  return { message, requestId, remaining, resetAt, isRateLimited };
}

export async function createAppJwt(): Promise<string> {
  const appId = requireEnv('GITHUB_APP_ID');
  const privateKeyPem = await getAppPrivateKeyPem();
  const now = Math.floor(Date.now() / 1000);

  const encodedHeader = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encodedPayload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);

  return `${signingInput}.${base64url(signature)}`;
}

async function getInstallationToken(installationId: string, repositoryIds?: number[]): Promise<TokenCacheRecord> {
  const key = cacheKey(installationId, repositoryIds);
  const cached = installationTokenCache.get(key);
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached;

  const jwt = await createAppJwt();
  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'input-github-app-auth-server',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(repositoryIds?.length ? { repository_ids: repositoryIds } : {}),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    const details = await parseGitHubErrorDetails(res);
    console.error(
      `Failed to mint installation token: ${res.status} ${details.message} request_id=${details.requestId ?? '-'} rate_limited=${details.isRateLimited} remaining=${details.remaining ?? '-'} reset=${details.resetAt ?? '-'}`,
    );
    throw new ClientError(details.message, 502);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  const record: TokenCacheRecord = {
    token: data.token,
    expires_at: data.expires_at,
    expiresAtMs: Date.parse(data.expires_at),
  };

  if (installationTokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
    const oldest = installationTokenCache.keys().next().value;
    if (oldest !== undefined) installationTokenCache.delete(oldest);
  }
  installationTokenCache.set(key, record);
  return record;
}

export async function githubFetchWithInstallationToken(
  installationId: string,
  ghPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const tokenRec = await getInstallationToken(installationId);
  const res = await fetch(`https://api.github.com${ghPath}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${tokenRec.token}`,
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
      ...((init.headers as Record<string, string>) ?? {}),
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const details = await parseGitHubErrorDetails(res);
    console.error(
      `GitHub API error on ${ghPath}: ${res.status} ${details.message} request_id=${details.requestId ?? '-'} rate_limited=${details.isRateLimited} remaining=${details.remaining ?? '-'} reset=${details.resetAt ?? '-'}`,
    );
    const statusCode = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw new ClientError(details.message, statusCode);
  }

  return res;
}

export function encodePathPreserveSlashes(path: string): string {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
