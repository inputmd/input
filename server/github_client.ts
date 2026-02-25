import { GITHUB_FETCH_TIMEOUT_MS } from './config';
import { ClientError } from './errors';
import { base64url, requireEnv } from './http_helpers';
import type { TokenCacheRecord } from './types';

const installationTokenCache = new Map<string, TokenCacheRecord>();
const MAX_TOKEN_CACHE_SIZE = 1000;

let cachedSigningKey: CryptoKey | null = null;
let cachedKeyPem: string | null = null;

function cacheKey(installationId: string, repositoryIds?: number[]): string {
  if (!repositoryIds?.length) return `${installationId}:all`;
  return `${installationId}:${repositoryIds
    .map((n) => String(n))
    .sort()
    .join(',')}`;
}

function getAppPrivateKeyPem(): string {
  const keyInline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!keyInline?.trim()) {
    throw new Error('Missing GITHUB_APP_PRIVATE_KEY');
  }
  return normalizeInlinePem(keyInline);
}

function normalizeInlinePem(rawValue: string): string {
  const trimmed = rawValue.trim();
  const withoutWrappingQuotes =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return withoutWrappingQuotes.replace(/\\n/g, '\n');
}

function pemToDer(pem: string): ArrayBuffer {
  const lines = pem.split('\n').filter((l) => !l.startsWith('-----'));
  const b64 = lines.join('');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getSigningKey(pem: string): Promise<CryptoKey> {
  if (cachedSigningKey && cachedKeyPem === pem) return cachedSigningKey;
  const der = pemToDer(pem);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  cachedSigningKey = key;
  cachedKeyPem = pem;
  return key;
}

export async function createAppJwt(): Promise<string> {
  const appId = requireEnv('GITHUB_APP_ID');
  const privateKeyPem = getAppPrivateKeyPem();
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

  const key = await getSigningKey(privateKeyPem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

async function getInstallationToken(installationId: string, repositoryIds?: number[]): Promise<TokenCacheRecord> {
  const key = cacheKey(installationId, repositoryIds);
  const cached = installationTokenCache.get(key);
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached;

  // Lazy eviction of expired tokens
  const now = Date.now();
  for (const [k, record] of installationTokenCache) {
    if (record.expiresAtMs <= now) installationTokenCache.delete(k);
  }

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
    const body = await res.text().catch(() => '');
    console.error(`Failed to mint installation token: ${res.status} ${res.statusText}`, body);
    throw new ClientError(`GitHub API error: ${res.status}`, 502);
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
    const body = await res.text().catch(() => '');
    console.error(`GitHub API error on ${ghPath}: ${res.status} ${res.statusText}`, body);
    const statusCode = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw new ClientError(`GitHub API error: ${res.status}`, statusCode);
  }

  return res;
}

export function encodePathPreserveSlashes(path: string): string {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
