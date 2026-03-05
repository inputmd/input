import { responseToApiError } from './api_error';
import { type CacheEntry, readCacheTtlMs } from './util';

const API_BASE = '/api/github';
const DEFAULT_GISTS_CACHE_TTL_MS = 120_000;
const DEFAULT_GIST_DETAIL_CACHE_TTL_MS = 120_000;
const GISTS_CACHE_KEY_PREFIX = 'input_cache_v1:gists:';
const GIST_DETAIL_CACHE_KEY_PREFIX = 'input_cache_v1:gist:';
const GISTS_CACHE_CHANNEL = 'input_cache_sync_v1';

const gistListCache = new Map<string, CacheEntry<GistSummary[]>>();
const gistDetailCache = new Map<string, CacheEntry<GistDetail>>();
let gistsCacheChannel: BroadcastChannel | null = null;

let gistsCacheTtlMs = readCacheTtlMs('VITE_GISTS_CACHE_TTL_MS', DEFAULT_GISTS_CACHE_TTL_MS);
let gistDetailCacheTtlMs = readCacheTtlMs('VITE_GIST_DETAIL_CACHE_TTL_MS', DEFAULT_GIST_DETAIL_CACHE_TTL_MS);

function gistListCacheKey(page: number, perPage: number): string {
  return `${page}:${perPage}`;
}

function gistStorageKey(cacheKey: string): string {
  return `${GISTS_CACHE_KEY_PREFIX}${cacheKey}`;
}

function gistDetailStorageKey(cacheKey: string): string {
  return `${GIST_DETAIL_CACHE_KEY_PREFIX}${cacheKey}`;
}

function readStoredGistList(cacheKey: string): CacheEntry<GistSummary[]> | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(gistStorageKey(cacheKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEntry<GistSummary[]>;
    if (!Array.isArray(parsed.value) || !Number.isFinite(parsed.expiresAt)) return null;
    if (Date.now() > parsed.expiresAt) {
      localStorage.removeItem(gistStorageKey(cacheKey));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredGistList(cacheKey: string, entry: CacheEntry<GistSummary[]>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(gistStorageKey(cacheKey), JSON.stringify(entry));
  } catch {
    // Ignore storage quota and serialization failures.
  }
}

function readStoredGistDetail(cacheKey: string): CacheEntry<GistDetail> | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(gistDetailStorageKey(cacheKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEntry<GistDetail>;
    if (!parsed.value || !Number.isFinite(parsed.expiresAt)) return null;
    if (Date.now() > parsed.expiresAt) {
      localStorage.removeItem(gistDetailStorageKey(cacheKey));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredGistDetail(cacheKey: string, entry: CacheEntry<GistDetail>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(gistDetailStorageKey(cacheKey), JSON.stringify(entry));
  } catch {
    // Ignore storage quota and serialization failures.
  }
}

function removeStoredGistLists(): void {
  if (typeof window === 'undefined') return;
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(GISTS_CACHE_KEY_PREFIX)) keysToRemove.push(key);
  }
  for (const key of keysToRemove) localStorage.removeItem(key);
}

function removeStoredGistDetail(cacheKey: string): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(gistDetailStorageKey(cacheKey));
}

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

function gistDetailCacheKey(id: string): string {
  return id;
}

function getCachedGistList(key: string): GistSummary[] | null {
  const cached = gistListCache.get(key);
  if (cached) {
    if (Date.now() > cached.expiresAt) {
      gistListCache.delete(key);
    } else {
      return cloneGistList(cached.value);
    }
  }
  const stored = readStoredGistList(key);
  if (!stored) return null;
  gistListCache.set(key, { value: cloneGistList(stored.value), expiresAt: stored.expiresAt });
  return cloneGistList(stored.value);
}

function setCachedGistList(key: string, value: GistSummary[]): void {
  const entry = {
    value: cloneGistList(value),
    expiresAt: Date.now() + gistsCacheTtlMs,
  };
  gistListCache.set(key, entry);
  writeStoredGistList(key, entry);
  gistsCacheChannel?.postMessage({ type: 'gists-key-updated', cacheKey: key });
}

function getCachedGistDetail(key: string): GistDetail | null {
  const cached = gistDetailCache.get(key);
  if (cached) {
    if (Date.now() > cached.expiresAt) {
      gistDetailCache.delete(key);
    } else {
      return cloneGistDetail(cached.value);
    }
  }
  const stored = readStoredGistDetail(key);
  if (!stored) return null;
  gistDetailCache.set(key, { value: cloneGistDetail(stored.value), expiresAt: stored.expiresAt });
  return cloneGistDetail(stored.value);
}

function setCachedGistDetail(key: string, value: GistDetail): void {
  const entry = {
    value: cloneGistDetail(value),
    expiresAt: Date.now() + gistDetailCacheTtlMs,
  };
  gistDetailCache.set(key, entry);
  writeStoredGistDetail(key, entry);
  gistsCacheChannel?.postMessage({ type: 'gist-detail-key-updated', cacheKey: key });
}

function clearGistListCache(): void {
  gistListCache.clear();
  removeStoredGistLists();
  gistsCacheChannel?.postMessage({ type: 'gists-cleared' });
}

function clearGistDetailCacheById(id: string): void {
  const key = gistDetailCacheKey(id);
  gistDetailCache.delete(key);
  removeStoredGistDetail(key);
  gistsCacheChannel?.postMessage({ type: 'gist-detail-key-cleared', cacheKey: key });
}

function setupGistsCacheSync(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('storage', (event) => {
    if (!event.key) return;
    if (event.key.startsWith(GISTS_CACHE_KEY_PREFIX)) {
      const cacheKey = event.key.slice(GISTS_CACHE_KEY_PREFIX.length);
      if (!cacheKey) return;
      const stored = readStoredGistList(cacheKey);
      if (!stored) {
        gistListCache.delete(cacheKey);
        return;
      }
      gistListCache.set(cacheKey, { value: cloneGistList(stored.value), expiresAt: stored.expiresAt });
      return;
    }
    if (event.key.startsWith(GIST_DETAIL_CACHE_KEY_PREFIX)) {
      const cacheKey = event.key.slice(GIST_DETAIL_CACHE_KEY_PREFIX.length);
      if (!cacheKey) return;
      const stored = readStoredGistDetail(cacheKey);
      if (!stored) {
        gistDetailCache.delete(cacheKey);
        return;
      }
      gistDetailCache.set(cacheKey, { value: cloneGistDetail(stored.value), expiresAt: stored.expiresAt });
    }
  });

  if ('BroadcastChannel' in window) {
    gistsCacheChannel = new BroadcastChannel(GISTS_CACHE_CHANNEL);
    gistsCacheChannel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const msg = event.data as { type?: string; cacheKey?: string } | null;
      if (!msg) return;
      if (msg.type === 'gists-cleared') {
        gistListCache.clear();
        return;
      }
      if (msg.type === 'gists-key-updated' && msg.cacheKey) {
        const stored = readStoredGistList(msg.cacheKey);
        if (!stored) {
          gistListCache.delete(msg.cacheKey);
          return;
        }
        gistListCache.set(msg.cacheKey, { value: cloneGistList(stored.value), expiresAt: stored.expiresAt });
        return;
      }
      if (msg.type === 'gist-detail-key-updated' && msg.cacheKey) {
        const stored = readStoredGistDetail(msg.cacheKey);
        if (!stored) {
          gistDetailCache.delete(msg.cacheKey);
          return;
        }
        gistDetailCache.set(msg.cacheKey, { value: cloneGistDetail(stored.value), expiresAt: stored.expiresAt });
        return;
      }
      if (msg.type === 'gist-detail-key-cleared' && msg.cacheKey) {
        gistDetailCache.delete(msg.cacheKey);
      }
    });
  }
}

export function setGistsCacheTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('Gists cache TTL must be a non-negative number');
  }
  gistsCacheTtlMs = Math.floor(ttlMs);
}

export function setGistDetailCacheTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('Gist detail cache TTL must be a non-negative number');
  }
  gistDetailCacheTtlMs = Math.floor(ttlMs);
}

setupGistsCacheSync();

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
  if (!res.ok) throw await responseToApiError(res);
  return res;
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (!res.ok) throw await responseToApiError(res);
  return res.json();
}

export async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw await responseToApiError(res);
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
  const cacheKey = gistDetailCacheKey(id);
  const cached = getCachedGistDetail(cacheKey);
  if (cached) return cached;

  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`);
  const data = (await res.json()) as GistDetail;
  setCachedGistDetail(cacheKey, data);
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
  clearGistListCache();
  setCachedGistDetail(gistDetailCacheKey(data.id), data);
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
  setCachedGistDetail(gistDetailCacheKey(id), data);
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
  setCachedGistDetail(gistDetailCacheKey(id), data);
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
  setCachedGistDetail(gistDetailCacheKey(id), data);
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
  clearGistDetailCacheById(id);
}
