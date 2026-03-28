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

export async function getRepoInstallationId(owner: string, repo: string): Promise<string> {
  const jwt = await createAppJwt();
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'input-github-app-auth-server',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    const details = await parseGitHubErrorDetails(res);
    console.error(
      `Failed to resolve installation for ${owner}/${repo}: ${res.status} ${details.message} request_id=${details.requestId ?? '-'} rate_limited=${details.isRateLimited} remaining=${details.remaining ?? '-'} reset=${details.resetAt ?? '-'}`,
    );
    throw new ClientError(details.message, res.status >= 400 && res.status < 500 ? res.status : 502);
  }

  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== 'number' && typeof data.id !== 'string') {
    throw new ClientError('Failed to resolve repository installation', 502);
  }
  return String(data.id);
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (details.requestId) headers['x-github-request-id'] = details.requestId;
    if (details.remaining !== null) headers['x-ratelimit-remaining'] = String(details.remaining);
    if (details.resetAt) headers['x-ratelimit-reset'] = String(Math.floor(new Date(details.resetAt).getTime() / 1000));
    return new Response(JSON.stringify({ message: details.message }), {
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
      headers,
    });
  }

  return res;
}

export async function githubGraphqlWithInstallationToken<T>(
  installationId: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: T; errors?: Array<{ message?: string; type?: string; path?: Array<string | number> }> }> {
  const tokenRec = await getInstallationToken(installationId);
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${tokenRec.token}`,
      'User-Agent': 'input-github-app-auth-server',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });

  const payload = (await res.json().catch(() => null)) as
    | {
        data?: T;
        errors?: Array<{ message?: string; type?: string; path?: Array<string | number> }>;
      }
    | null;

  if (!res.ok) {
    const details = await parseGitHubErrorDetails(
      new Response(JSON.stringify(payload ?? {}), {
        status: res.status,
        headers: res.headers,
      }),
    );
    console.error(
      `GitHub GraphQL error: ${res.status} ${details.message} request_id=${details.requestId ?? '-'} rate_limited=${details.isRateLimited} remaining=${details.remaining ?? '-'} reset=${details.resetAt ?? '-'}`,
    );
    throw new ClientError(details.message, res.status >= 400 && res.status < 500 ? res.status : 502);
  }

  return payload ?? {};
}

export interface GitHubBranchState {
  repositoryId: string;
  defaultBranch: string;
  headSha: string;
  baseTreeSha: string;
}

const REPOSITORY_BRANCH_STATE_QUERY = `
  query RepositoryBranchState($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      id
      defaultBranchRef {
        name
        target {
          ... on Commit {
            oid
            tree {
              oid
            }
          }
        }
      }
    }
  }
`;

export async function getGitHubRepositoryBranchState(
  installationId: string,
  owner: string,
  repo: string,
): Promise<GitHubBranchState> {
  const payload = await githubGraphqlWithInstallationToken<{
    repository?: {
      id?: string | null;
      defaultBranchRef?: {
        name?: string | null;
        target?: {
          oid?: string | null;
          tree?: { oid?: string | null } | null;
        } | null;
      } | null;
    } | null;
  }>(installationId, REPOSITORY_BRANCH_STATE_QUERY, { owner, repo });

  const graphqlMessage =
    payload.errors
      ?.map((entry) => entry.message)
      .filter((message): message is string => typeof message === 'string' && message.trim().length > 0)
      .join('; ') ?? '';
  if (graphqlMessage) throw new ClientError(graphqlMessage, 502);

  const repository = payload.data?.repository;
  const defaultBranchRef = repository?.defaultBranchRef;
  const target = defaultBranchRef?.target;
  const repositoryId = typeof repository?.id === 'string' ? repository.id : '';
  const defaultBranch = typeof defaultBranchRef?.name === 'string' ? defaultBranchRef.name : '';
  const headSha = typeof target?.oid === 'string' ? target.oid : '';
  const baseTreeSha = typeof target?.tree?.oid === 'string' ? target.tree.oid : '';
  if (!repositoryId || !defaultBranch || !headSha || !baseTreeSha) {
    throw new ClientError('Failed to load repository branch state', 502);
  }

  return { repositoryId, defaultBranch, headSha, baseTreeSha };
}

const ATOMIC_UPDATE_REF_MUTATION = `
  mutation ForceUpdateRefAtomically($input: UpdateRefsInput!) {
    updateRefs(input: $input) {
      clientMutationId
    }
  }
`;

export async function atomicForceUpdateGitHubRef(
  installationId: string,
  repositoryId: string,
  refName: string,
  beforeOid: string,
  afterOid: string,
): Promise<void> {
  const payload = await githubGraphqlWithInstallationToken<{
    updateRefs?: { clientMutationId?: string | null };
  }>(installationId, ATOMIC_UPDATE_REF_MUTATION, {
    input: {
      repositoryId,
      refUpdates: [
        {
          name: refName,
          beforeOid,
          afterOid,
          force: true,
        },
      ],
    },
  });

  const graphqlMessage =
    payload.errors
      ?.map((entry) => entry.message)
      .filter((message): message is string => typeof message === 'string' && message.trim().length > 0)
      .join('; ') ?? '';
  if (!graphqlMessage) return;
  if (/before oid|beforeOid|expected|stale|has moved|mismatch|not at/i.test(graphqlMessage)) {
    throw new ClientError('The branch changed while updating the ref. Reload and try again.', 409);
  }
  throw new ClientError(graphqlMessage, 502);
}

export function encodePathPreserveSlashes(path: string): string {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
