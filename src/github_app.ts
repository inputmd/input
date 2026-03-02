import { responseToApiError } from './api_error';

const INSTALLATION_ID_KEY = 'github_app_installation_id';
const SELECTED_REPO_KEY = 'github_app_selected_repo';
const PENDING_INSTALLATION_ID_KEY = 'github_app_pending_installation_id';
const INSTALL_STATE_KEY = 'github_app_install_state';
const INSTALL_STATES_FALLBACK_KEY = 'github_app_install_states';
const INSTALL_STATE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REPO_CONTENTS_CACHE_TTL_MS = 120_000;
const REPO_CONTENTS_CACHE_KEY_PREFIX = 'input_cache_v2:repo_contents:';
const REPO_CONTENTS_CACHE_CHANNEL = 'input_cache_sync_v1';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export function getInstallationId(): string | null {
  return localStorage.getItem(INSTALLATION_ID_KEY);
}

export function setInstallationId(id: string): void {
  localStorage.setItem(INSTALLATION_ID_KEY, id);
}

export function clearInstallationId(): void {
  localStorage.removeItem(INSTALLATION_ID_KEY);
}

export function getPendingInstallationId(): string | null {
  return localStorage.getItem(PENDING_INSTALLATION_ID_KEY);
}

export function setPendingInstallationId(id: string): void {
  localStorage.setItem(PENDING_INSTALLATION_ID_KEY, id);
}

export function clearPendingInstallationId(): void {
  localStorage.removeItem(PENDING_INSTALLATION_ID_KEY);
}

export interface SelectedRepo {
  full_name: string; // owner/name
  id?: number;
  private?: boolean;
}

export function getSelectedRepo(): SelectedRepo | null {
  const raw = localStorage.getItem(SELECTED_REPO_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SelectedRepo;
    if (!parsed?.full_name) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setSelectedRepo(repo: SelectedRepo): void {
  localStorage.setItem(SELECTED_REPO_KEY, JSON.stringify(repo));
}

export function clearSelectedRepo(): void {
  localStorage.removeItem(SELECTED_REPO_KEY);
}

// --- Error types ---

export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

// --- Fetch helpers ---

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    throw new SessionExpiredError();
  }
  if (!res.ok) throw await responseToApiError(res);
  return res;
}

async function publicFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw await responseToApiError(res);
  return res;
}

// --- Public endpoints (no auth) ---

export async function createSession(installationId: string): Promise<void> {
  const res = await fetch('/api/github-app/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ installationId }),
  });
  if (!res.ok) throw await responseToApiError(res);
  await res.json();
}

export async function disconnectInstallation(): Promise<void> {
  const res = await fetch('/api/github-app/disconnect', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await responseToApiError(res);
}

export function createInstallState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type StoredInstallStates = Record<string, number>;

function readStoredInstallStates(): StoredInstallStates {
  const raw = localStorage.getItem(INSTALL_STATES_FALLBACK_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StoredInstallStates;
  } catch {
    return {};
  }
}

function writeStoredInstallStates(states: StoredInstallStates): void {
  localStorage.setItem(INSTALL_STATES_FALLBACK_KEY, JSON.stringify(states));
}

function pruneExpiredInstallStates(states: StoredInstallStates): StoredInstallStates {
  const now = Date.now();
  const next: StoredInstallStates = {};
  for (const [state, expiresAt] of Object.entries(states)) {
    if (expiresAt > now) next[state] = expiresAt;
  }
  return next;
}

export function rememberInstallState(state: string): void {
  sessionStorage.setItem(INSTALL_STATE_KEY, state);
  const next = pruneExpiredInstallStates(readStoredInstallStates());
  next[state] = Date.now() + INSTALL_STATE_TTL_MS;
  writeStoredInstallStates(next);
}

export function hasInstallState(actualState: string | null): boolean {
  if (!actualState) return false;
  const expectedState = sessionStorage.getItem(INSTALL_STATE_KEY);
  if (expectedState && expectedState === actualState) return true;

  const next = pruneExpiredInstallStates(readStoredInstallStates());
  writeStoredInstallStates(next);
  return typeof next[actualState] === 'number';
}

export function consumeInstallState(actualState: string | null): boolean {
  const expectedState = sessionStorage.getItem(INSTALL_STATE_KEY);
  sessionStorage.removeItem(INSTALL_STATE_KEY);
  if (!actualState) return false;
  if (expectedState && expectedState === actualState) {
    const next = pruneExpiredInstallStates(readStoredInstallStates());
    delete next[actualState];
    writeStoredInstallStates(next);
    return true;
  }

  const next = pruneExpiredInstallStates(readStoredInstallStates());
  const matched = typeof next[actualState] === 'number';
  if (matched) {
    delete next[actualState];
    writeStoredInstallStates(next);
    return true;
  }
  writeStoredInstallStates(next);
  return false;
}

export async function getInstallUrl(state: string): Promise<string> {
  const res = await fetch(`/api/github-app/install-url?state=${encodeURIComponent(state)}`);
  if (!res.ok) throw await responseToApiError(res);
  const data = (await res.json()) as { url: string };
  return data.url;
}

// --- Types ---

export interface InstallationRepoList {
  total_count: number;
  repositories: Array<{
    id: number;
    full_name: string;
    private: boolean;
    html_url: string;
    permissions?: Record<string, boolean>;
  }>;
}

export type InstallationRepo = InstallationRepoList['repositories'][number];

export interface RepoFile {
  type: 'file';
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: 'base64';
}

export function isRepoFile(contents: RepoContents): contents is RepoFile {
  return !Array.isArray(contents) && contents.type === 'file';
}

export type RepoContents =
  | RepoFile
  | Array<{
      type: 'file' | 'dir' | 'symlink' | 'submodule';
      name: string;
      path: string;
      sha: string;
      size: number;
      url: string;
      html_url: string;
      download_url: string | null;
    }>;

export interface PutFileResult {
  content: { path: string; sha: string };
  commit: { sha: string; html_url: string };
}

export interface RepoFileShareLink {
  token: string;
  url: string;
  expiresAt: string;
}

export interface SharedRepoFile {
  owner: string;
  repo: string;
  path: string;
  name: string;
  sha: string;
  content: string;
  encoding: 'base64';
  expiresAt: string;
}

const repoContentsCache = new Map<string, CacheEntry<RepoContents>>();
let repoContentsCacheChannel: BroadcastChannel | null = null;
let repoContentsCacheTtlMs = readCacheTtlMs('VITE_REPO_CONTENTS_CACHE_TTL_MS', DEFAULT_REPO_CONTENTS_CACHE_TTL_MS);

function readCacheTtlMs(envVar: string, fallback: number): number {
  const raw = import.meta.env[envVar];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function repoContentsCacheKey(installationId: string, repoFullName: string, path: string, ref?: string): string {
  return `${installationId}|${repoFullName}|${ref ?? ''}|${path}`;
}

function publicRepoContentsCacheIdentity(owner: string, repo: string): string {
  return `public:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function repoContentsStorageKey(cacheKey: string): string {
  return `${REPO_CONTENTS_CACHE_KEY_PREFIX}${cacheKey}`;
}

function readStoredRepoContents(cacheKey: string): CacheEntry<RepoContents> | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(repoContentsStorageKey(cacheKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEntry<RepoContents>;
    if (!Number.isFinite(parsed.expiresAt)) return null;
    if (Date.now() > parsed.expiresAt) {
      localStorage.removeItem(repoContentsStorageKey(cacheKey));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredRepoContents(cacheKey: string, entry: CacheEntry<RepoContents>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(repoContentsStorageKey(cacheKey), JSON.stringify(entry));
  } catch {
    // Ignore storage quota and serialization failures.
  }
}

function removeStoredRepoContentsByPrefix(cacheKeyPrefix: string): void {
  if (typeof window === 'undefined') return;
  const storagePrefix = `${REPO_CONTENTS_CACHE_KEY_PREFIX}${cacheKeyPrefix}`;
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(storagePrefix)) keysToRemove.push(key);
  }
  for (const key of keysToRemove) localStorage.removeItem(key);
}

function cloneRepoContents(contents: RepoContents): RepoContents {
  if (Array.isArray(contents)) {
    return contents.map((item) => ({ ...item }));
  }
  return { ...contents };
}

function getCachedRepoContents(key: string): RepoContents | null {
  const cached = repoContentsCache.get(key);
  if (cached) {
    if (Date.now() > cached.expiresAt) {
      repoContentsCache.delete(key);
    } else {
      return cloneRepoContents(cached.value);
    }
  }
  const stored = readStoredRepoContents(key);
  if (!stored) return null;
  repoContentsCache.set(key, { value: cloneRepoContents(stored.value), expiresAt: stored.expiresAt });
  return cloneRepoContents(stored.value);
}

function setCachedRepoContents(key: string, value: RepoContents): void {
  const entry = {
    value: cloneRepoContents(value),
    expiresAt: Date.now() + repoContentsCacheTtlMs,
  };
  repoContentsCache.set(key, entry);
  writeStoredRepoContents(key, entry);
  repoContentsCacheChannel?.postMessage({ type: 'repo-key-updated', cacheKey: key });
}

function clearRepoContentsCacheForRepo(installationId: string, repoFullName: string): void {
  const keyPrefix = `${installationId}|${repoFullName}|`;
  for (const key of repoContentsCache.keys()) {
    if (key.startsWith(keyPrefix)) repoContentsCache.delete(key);
  }
  removeStoredRepoContentsByPrefix(keyPrefix);
  repoContentsCacheChannel?.postMessage({ type: 'repo-prefix-cleared', cacheKeyPrefix: keyPrefix });

  const treeKeyPrefix = `tree|${installationId}|${repoFullName}|`;
  for (const key of repoTreeCache.keys()) {
    if (key.startsWith(treeKeyPrefix)) repoTreeCache.delete(key);
  }
}

export function setRepoContentsCacheTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('Repo contents cache TTL must be a non-negative number');
  }
  repoContentsCacheTtlMs = Math.floor(ttlMs);
}

function setupRepoContentsCacheSync(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(REPO_CONTENTS_CACHE_KEY_PREFIX)) return;
    const cacheKey = event.key.slice(REPO_CONTENTS_CACHE_KEY_PREFIX.length);
    if (!cacheKey) return;
    const stored = readStoredRepoContents(cacheKey);
    if (!stored) {
      repoContentsCache.delete(cacheKey);
      return;
    }
    repoContentsCache.set(cacheKey, { value: cloneRepoContents(stored.value), expiresAt: stored.expiresAt });
  });

  if ('BroadcastChannel' in window) {
    repoContentsCacheChannel = new BroadcastChannel(REPO_CONTENTS_CACHE_CHANNEL);
    repoContentsCacheChannel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const msg = event.data as { type?: string; cacheKey?: string; cacheKeyPrefix?: string } | null;
      if (!msg) return;
      if (msg.type === 'repo-prefix-cleared' && msg.cacheKeyPrefix) {
        for (const key of repoContentsCache.keys()) {
          if (key.startsWith(msg.cacheKeyPrefix)) repoContentsCache.delete(key);
        }
        return;
      }
      if (msg.type === 'repo-key-updated' && msg.cacheKey) {
        const stored = readStoredRepoContents(msg.cacheKey);
        if (!stored) {
          repoContentsCache.delete(msg.cacheKey);
          return;
        }
        repoContentsCache.set(msg.cacheKey, { value: cloneRepoContents(stored.value), expiresAt: stored.expiresAt });
      }
    });
  }
}

setupRepoContentsCacheSync();

// --- Authenticated API functions ---

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo: ${fullName}`);
  return { owner, repo };
}

function installationUrl(installationId: string, ...segments: string[]): string {
  const base = `/api/github-app/installations/${encodeURIComponent(installationId)}`;
  return segments.length ? `${base}/${segments.map(encodeURIComponent).join('/')}` : base;
}

export async function listInstallationRepos(installationId: string): Promise<InstallationRepoList> {
  const res = await authFetch(`${installationUrl(installationId)}/repositories`);
  return res.json();
}

export async function getRepoContents(
  installationId: string,
  repoFullName: string,
  path: string,
  ref?: string,
): Promise<RepoContents> {
  const cacheKey = repoContentsCacheKey(installationId, repoFullName, path, ref);
  const cached = getCachedRepoContents(cacheKey);
  if (cached) return cached;

  const { owner, repo } = splitFullName(repoFullName);
  const qs = new URLSearchParams({ path });
  if (ref) qs.set('ref', ref);
  const res = await authFetch(`${installationUrl(installationId, 'repos', owner, repo)}/contents?${qs.toString()}`);
  const data = (await res.json()) as RepoContents;
  setCachedRepoContents(cacheKey, data);
  return data;
}

export async function getPublicRepoContents(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<RepoContents> {
  const cacheIdentity = publicRepoContentsCacheIdentity(owner, repo);
  const cacheKey = repoContentsCacheKey(cacheIdentity, `${owner}/${repo}`, path, ref);
  const cached = getCachedRepoContents(cacheKey);
  if (cached) return cached;

  const qs = new URLSearchParams({ path });
  if (ref) qs.set('ref', ref);
  const res = await publicFetch(
    `/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?${qs.toString()}`,
  );
  const data = (await res.json()) as RepoContents;
  setCachedRepoContents(cacheKey, data);
  return data;
}

export interface RepoTreeResult {
  files: Array<{ name: string; path: string; sha: string }>;
  truncated: boolean;
}

const repoTreeCache = new Map<string, CacheEntry<RepoTreeResult>>();

function repoTreeCacheKey(identity: string, repoFullName: string, ref?: string): string {
  return `tree|${identity}|${repoFullName}|${ref ?? ''}`;
}

function getCachedRepoTree(key: string): RepoTreeResult | null {
  const cached = repoTreeCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    repoTreeCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedRepoTree(key: string, value: RepoTreeResult): void {
  repoTreeCache.set(key, { value, expiresAt: Date.now() + repoContentsCacheTtlMs });
}

export async function getRepoTree(installationId: string, repoFullName: string, ref?: string): Promise<RepoTreeResult> {
  const key = repoTreeCacheKey(installationId, repoFullName, ref);
  const cached = getCachedRepoTree(key);
  if (cached) return cached;

  const { owner, repo } = splitFullName(repoFullName);
  const qs = new URLSearchParams();
  if (ref) qs.set('ref', ref);
  const qsStr = qs.toString();
  const url = `${installationUrl(installationId, 'repos', owner, repo)}/tree${qsStr ? `?${qsStr}` : ''}`;
  const res = await authFetch(url);
  const data = (await res.json()) as RepoTreeResult;
  setCachedRepoTree(key, data);
  return data;
}

export async function getPublicRepoTree(owner: string, repo: string, ref?: string): Promise<RepoTreeResult> {
  const identity = publicRepoContentsCacheIdentity(owner, repo);
  const key = repoTreeCacheKey(identity, `${owner}/${repo}`, ref);
  const cached = getCachedRepoTree(key);
  if (cached) return cached;

  const qs = new URLSearchParams();
  if (ref) qs.set('ref', ref);
  const qsStr = qs.toString();
  const url = `/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree${qsStr ? `?${qsStr}` : ''}`;
  const res = await publicFetch(url);
  const data = (await res.json()) as RepoTreeResult;
  setCachedRepoTree(key, data);
  return data;
}

export function repoRawFileUrl(installationId: string, repoFullName: string, path: string): string {
  const { owner, repo } = splitFullName(repoFullName);
  const qs = new URLSearchParams({ path });
  return `${installationUrl(installationId, 'repos', owner, repo)}/raw?${qs.toString()}`;
}

export function publicRepoRawFileUrl(owner: string, repo: string, path: string): string {
  const qs = new URLSearchParams({ path });
  return `/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw?${qs.toString()}`;
}

export async function putRepoFile(
  installationId: string,
  repoFullName: string,
  path: string,
  message: string,
  contentBase64: string,
  sha?: string,
): Promise<PutFileResult> {
  const { owner, repo } = splitFullName(repoFullName);
  const res = await authFetch(`${installationUrl(installationId, 'repos', owner, repo)}/contents`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, message, content: contentBase64, sha }),
  });
  const data = (await res.json()) as PutFileResult;
  clearRepoContentsCacheForRepo(installationId, repoFullName);
  return data;
}

export async function deleteRepoFile(
  installationId: string,
  repoFullName: string,
  path: string,
  message: string,
  sha: string,
): Promise<void> {
  const { owner, repo } = splitFullName(repoFullName);
  await authFetch(`${installationUrl(installationId, 'repos', owner, repo)}/contents`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, message, sha }),
  });
  clearRepoContentsCacheForRepo(installationId, repoFullName);
}

export async function createRepoFileShareLink(
  installationId: string,
  repoFullName: string,
  path: string,
): Promise<RepoFileShareLink> {
  const res = await authFetch('/api/share/repo-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, repoFullName, path }),
  });
  return (await res.json()) as RepoFileShareLink;
}

export async function getSharedRepoFile(token: string): Promise<SharedRepoFile> {
  const res = await publicFetch(`/api/share/repo-file/${encodeURIComponent(token)}`);
  return (await res.json()) as SharedRepoFile;
}
