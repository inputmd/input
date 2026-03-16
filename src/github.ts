import { responseToApiError } from './api_error';
import { recordGitHubRateLimitFromResponse, recordServerLocalRateLimitFromResponse } from './github_rate_limit';
import { SyncedCache } from './synced_cache';
import { readCacheTtlMs } from './util';

const API_BASE = '/api/github';
const GISTS_CACHE_CHANNEL = 'input_cache_sync_v1';

function cloneGistList(value: GistSummary[]): GistSummary[] {
  return value.map((gist) => ({ ...gist, files: { ...gist.files } }));
}

function cloneGistDetail(value: GistDetail): GistDetail {
  const files: Record<string, GistFile> = {};
  for (const [name, file] of Object.entries(value.files)) {
    files[name] = { ...file };
  }
  return { ...value, files };
}

const gistListCache = new SyncedCache<GistSummary[]>({
  storageKeyPrefix: 'input_cache_v1:gists:',
  channelName: GISTS_CACHE_CHANNEL,
  messagePrefix: 'gists',
  clone: cloneGistList,
  validate: (entry) => Array.isArray(entry.value),
  ttlMs: readCacheTtlMs('VITE_GISTS_CACHE_TTL_MS', 120_000),
});

const gistDetailCache = new SyncedCache<GistDetail>({
  storageKeyPrefix: 'input_cache_v1:gist:',
  channelName: GISTS_CACHE_CHANNEL,
  messagePrefix: 'gist-detail',
  clone: cloneGistDetail,
  validate: (entry) => !!entry.value,
  ttlMs: readCacheTtlMs('VITE_GIST_DETAIL_CACHE_TTL_MS', 120_000),
});

function gistListCacheKey(page: number, perPage: number): string {
  return `${page}:${perPage}`;
}

export function setGistsCacheTtlMs(ttlMs: number): void {
  gistListCache.setTtlMs(ttlMs);
}

export function setGistDetailCacheTtlMs(ttlMs: number): void {
  gistDetailCache.setTtlMs(ttlMs);
}

export function clearGitHubCaches(): void {
  gistListCache.clearAll();
  gistDetailCache.clearAll();
}

export interface GistFile {
  filename: string;
  content: string;
  raw_url: string;
  size: number;
  truncated: boolean;
}

export interface GistSummary {
  id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  public: boolean;
  files: Record<string, { filename: string; size: number }>;
}

export interface GistDetail {
  id: string;
  description: string | null;
  public: boolean;
  files: Record<string, GistFile>;
  created_at: string;
  updated_at: string;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

interface AuthSessionResponse {
  authenticated: boolean;
  user?: GitHubUser;
  installationId?: string | null;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...(options.headers as Record<string, string>),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'same-origin' });
  recordServerLocalRateLimitFromResponse(res);
  recordGitHubRateLimitFromResponse(res);
  if (res.status === 401) {
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw await responseToApiError(res);
  return res;
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
  recordServerLocalRateLimitFromResponse(res);
  recordGitHubRateLimitFromResponse(res);
  if (!res.ok) throw await responseToApiError(res);
  return res.json();
}

export async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  recordServerLocalRateLimitFromResponse(res);
  recordGitHubRateLimitFromResponse(res);
  if (!res.ok) throw await responseToApiError(res);
}

export async function listGists(page = 1, perPage = 30): Promise<GistSummary[]> {
  const cacheKey = gistListCacheKey(page, perPage);
  const cached = gistListCache.get(cacheKey);
  if (cached) return cached;

  const res = await apiFetch(`/gists?per_page=${perPage}&page=${page}`);
  const data = (await res.json()) as GistSummary[];
  gistListCache.set(cacheKey, data);
  return data;
}

export async function getGist(id: string, options?: { forceRefresh?: boolean }): Promise<GistDetail> {
  if (!options?.forceRefresh) {
    const cached = gistDetailCache.get(id);
    if (cached) return cached;
  }

  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`);
  const data = (await res.json()) as GistDetail;
  gistDetailCache.set(id, data);
  return data;
}

export async function createGist(content: string, filename = 'untitled.md', description?: string): Promise<GistDetail> {
  const res = await apiFetch('/gists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: description ?? '',
      public: false,
      files: { [filename]: { content } },
    }),
  });
  const data = (await res.json()) as GistDetail;
  gistListCache.clearAll();
  gistDetailCache.set(data.id, data);
  return data;
}

export async function updateGist(
  id: string,
  content: string,
  filename: string,
  description?: string,
): Promise<GistDetail> {
  const body: Record<string, unknown> = {
    files: { [filename]: { content } },
  };
  if (description !== undefined) body.description = description;
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as GistDetail;
  gistListCache.clearAll();
  gistDetailCache.set(id, data);
  return data;
}

export async function updateGistDescription(id: string, description: string): Promise<GistDetail> {
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  const data = (await res.json()) as GistDetail;
  gistListCache.clearAll();
  gistDetailCache.set(id, data);
  return data;
}

type GistFileUpdate = { content: string } | { filename: string } | null;

export async function updateGistFiles(
  id: string,
  files: Record<string, GistFileUpdate>,
  description?: string,
): Promise<GistDetail> {
  const body: Record<string, unknown> = { files };
  if (description !== undefined) body.description = description;
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as GistDetail;
  gistListCache.clearAll();
  gistDetailCache.set(id, data);
  return data;
}

export async function addFileToGist(id: string, filename: string, content: string): Promise<GistDetail> {
  return updateGistFiles(id, { [filename]: { content } });
}

export async function deleteFileFromGist(id: string, filename: string): Promise<GistDetail> {
  return updateGistFiles(id, { [filename]: null });
}

export async function renameFileInGist(id: string, oldName: string, newName: string): Promise<GistDetail> {
  return updateGistFiles(id, { [oldName]: { filename: newName } });
}

export async function deleteGist(id: string): Promise<void> {
  await apiFetch(`/gists/${encodeURIComponent(id)}`, { method: 'DELETE' });
  gistListCache.clearAll();
  gistDetailCache.delete(id);
}
