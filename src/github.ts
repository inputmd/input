const API_BASE = '/api/github';
const DEFAULT_GISTS_CACHE_TTL_MS = 300_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const gistListCache = new Map<string, CacheEntry<GistSummary[]>>();

let gistsCacheTtlMs = readCacheTtlMs('VITE_GISTS_CACHE_TTL_MS', DEFAULT_GISTS_CACHE_TTL_MS);

function readCacheTtlMs(envVar: string, fallback: number): number {
  const raw = import.meta.env[envVar];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function gistListCacheKey(page: number, perPage: number): string {
  return `${page}:${perPage}`;
}

function getCachedGistList(key: string): GistSummary[] | null {
  const cached = gistListCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    gistListCache.delete(key);
    return null;
  }
  return cached.value.map((gist) => ({ ...gist, files: { ...gist.files } }));
}

function setCachedGistList(key: string, value: GistSummary[]): void {
  gistListCache.set(key, {
    value: value.map((gist) => ({ ...gist, files: { ...gist.files } })),
    expiresAt: Date.now() + gistsCacheTtlMs,
  });
}

function clearGistListCache(): void {
  gistListCache.clear();
}

export function setGistsCacheTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('Gists cache TTL must be a non-negative number');
  }
  gistsCacheTtlMs = Math.floor(ttlMs);
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
  if (res.status === 401) {
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res;
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Failed to fetch auth session: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Failed to logout: ${res.status} ${res.statusText}`);
}

export async function listGists(page = 1, perPage = 30): Promise<GistSummary[]> {
  const cacheKey = gistListCacheKey(page, perPage);
  const cached = getCachedGistList(cacheKey);
  if (cached) return cached;

  const res = await apiFetch(`/gists?per_page=${perPage}&page=${page}`);
  const data = (await res.json()) as GistSummary[];
  setCachedGistList(cacheKey, data);
  return data;
}

export async function getGist(id: string): Promise<GistDetail> {
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`);
  return res.json();
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
  clearGistListCache();
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
  clearGistListCache();
  return data;
}

export async function updateGistDescription(id: string, description: string): Promise<GistDetail> {
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  const data = (await res.json()) as GistDetail;
  clearGistListCache();
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
  clearGistListCache();
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
  clearGistListCache();
}
