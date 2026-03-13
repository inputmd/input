import { ApiError, responseToApiError } from './api_error';
import { SyncedCache } from './synced_cache';
import { type CacheEntry, readCacheTtlMs } from './util';

const INSTALLATION_ID_KEY = 'github_app_installation_id';
const SELECTED_REPO_KEY = 'github_app_selected_repo';
const PENDING_INSTALLATION_ID_KEY = 'github_app_pending_installation_id';
const INSTALL_STATE_KEY = 'github_app_install_state';
const INSTALL_STATES_FALLBACK_KEY = 'github_app_install_states';
const INSTALL_STATE_TTL_MS = 15 * 60 * 1000;

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

export interface RepoBatchRename {
  from: string;
  to: string;
}

export interface RepoBatchCreateFile {
  path: string;
  content: string;
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

function cloneRepoContents(contents: RepoContents): RepoContents {
  if (Array.isArray(contents)) {
    return contents.map((item) => ({ ...item }));
  }
  return { ...contents };
}

const repoContentsCacheTtlMs = readCacheTtlMs('VITE_REPO_CONTENTS_CACHE_TTL_MS', 30_000);

const repoContentsCache = new SyncedCache<RepoContents>({
  storageKeyPrefix: 'input_cache_v2:repo_contents:',
  channelName: 'input_cache_sync_v1',
  messagePrefix: 'repo',
  clone: cloneRepoContents,
  ttlMs: repoContentsCacheTtlMs,
});

function normalizeRepoFullNameForCache(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

function repoContentsCacheKey(identity: string, repoFullName: string, path: string, ref?: string): string {
  const normalizedRepo = normalizeRepoFullNameForCache(repoFullName);
  return `${identity}|${normalizedRepo}|${ref ?? ''}|${path}`;
}

function publicRepoContentsCacheIdentity(owner: string, repo: string): string {
  return `public:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function clearRepoContentsCacheForRepo(installationId: string, repoFullName: string): void {
  const normalizedRepo = normalizeRepoFullNameForCache(repoFullName);
  repoContentsCache.clearByPrefix(`${installationId}|${normalizedRepo}|`);
  // Best-effort: clear any legacy cache keys that were stored with non-normalized repo names.
  repoContentsCache.clearByPrefix(`${installationId}|${repoFullName}|`);

  const treeKeyPrefix = `tree|${installationId}|${normalizedRepo}|`;
  for (const key of repoTreeCache.keys()) {
    if (key.startsWith(treeKeyPrefix)) repoTreeCache.delete(key);
  }
}

export function setRepoContentsCacheTtlMs(ttlMs: number): void {
  repoContentsCache.setTtlMs(ttlMs);
}

export function clearGitHubAppCaches(): void {
  repoContentsCache.clearAll();
  repoTreeCache.clear();
}

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
  options?: { forceRefresh?: boolean },
): Promise<RepoContents> {
  const cacheKey = repoContentsCacheKey(installationId, repoFullName, path, ref);
  if (!options?.forceRefresh) {
    const cached = repoContentsCache.get(cacheKey);
    if (cached) return cached;
  }

  const { owner, repo } = splitFullName(repoFullName);
  const qs = new URLSearchParams({ path });
  if (ref) qs.set('ref', ref);
  const res = await authFetch(`${installationUrl(installationId, 'repos', owner, repo)}/contents?${qs.toString()}`);
  const data = (await res.json()) as RepoContents;
  repoContentsCache.set(cacheKey, data);
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
  const cached = repoContentsCache.get(cacheKey);
  if (cached) return cached;

  const qs = new URLSearchParams({ path });
  if (ref) qs.set('ref', ref);
  const res = await publicFetch(
    `/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?${qs.toString()}`,
  );
  const data = (await res.json()) as RepoContents;
  repoContentsCache.set(cacheKey, data);
  return data;
}

export interface RepoTreeResult {
  entries?: Array<{
    type: 'file' | 'dir' | 'symlink' | 'submodule';
    name: string;
    path: string;
    sha: string;
    size?: number;
  }>;
  files: Array<{ name: string; path: string; sha: string; size?: number }>;
  truncated: boolean;
}

const repoTreeCache = new Map<string, CacheEntry<RepoTreeResult>>();

function repoTreeCacheKey(identity: string, repoFullName: string, ref?: string): string {
  const normalizedRepo = normalizeRepoFullNameForCache(repoFullName);
  return `tree|${identity}|${normalizedRepo}|${ref ?? ''}|md`;
}

function repoTreeCacheKeyForMode(identity: string, repoFullName: string, markdownOnly: boolean, ref?: string): string {
  return `${repoTreeCacheKey(identity, repoFullName, ref)}:${markdownOnly ? '1' : '0'}`;
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

export async function getRepoTree(
  installationId: string,
  repoFullName: string,
  ref?: string,
  markdownOnly = true,
): Promise<RepoTreeResult> {
  const key = repoTreeCacheKeyForMode(installationId, repoFullName, markdownOnly, ref);
  const cached = getCachedRepoTree(key);
  if (cached) return cached;

  const { owner, repo } = splitFullName(repoFullName);
  const qs = new URLSearchParams();
  if (ref) qs.set('ref', ref);
  if (!markdownOnly) qs.set('markdown_only', '0');
  const qsStr = qs.toString();
  const url = `${installationUrl(installationId, 'repos', owner, repo)}/tree${qsStr ? `?${qsStr}` : ''}`;
  const res = await authFetch(url);
  const data = (await res.json()) as RepoTreeResult;
  setCachedRepoTree(key, data);
  return data;
}

export async function getPublicRepoTree(
  owner: string,
  repo: string,
  ref?: string,
  markdownOnly = true,
): Promise<RepoTreeResult> {
  const identity = publicRepoContentsCacheIdentity(owner, repo);
  const key = repoTreeCacheKeyForMode(identity, `${owner}/${repo}`, markdownOnly, ref);
  const cached = getCachedRepoTree(key);
  if (cached) return cached;

  const qs = new URLSearchParams();
  if (ref) qs.set('ref', ref);
  if (!markdownOnly) qs.set('markdown_only', '0');
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

export interface RepoFileEntry {
  path: string;
  content: string;
  size: number;
}

export async function getRepoTarball(
  installationId: string,
  repoFullName: string,
  ref?: string,
): Promise<RepoFileEntry[]> {
  const { owner, repo } = splitFullName(repoFullName);
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `${installationUrl(installationId, 'repos', owner, repo)}/tarball${qs}`;
  const res = await authFetch(url);
  const data = (await res.json()) as { files: RepoFileEntry[] };
  return data.files;
}

export async function getPublicRepoTarball(owner: string, repo: string, ref?: string): Promise<RepoFileEntry[]> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const url = `/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball${qs}`;
  const res = await publicFetch(url);
  const data = (await res.json()) as { files: RepoFileEntry[] };
  return data.files;
}

/**
 * Check if all files in the tree are already in the contents cache.
 * If so, return them as RepoFileEntry[]. Otherwise return null.
 *
 * For installed repos, pass `{ installationId, repoFullName }`.
 * For public repos, pass `{ owner, repo }`.
 */
export function tryBuildRepoFilesFromCache(
  identity: { installationId: string; repoFullName: string } | { owner: string; repo: string },
  tree: Array<{ path: string; size?: number }>,
): RepoFileEntry[] | null {
  const cacheIdentity =
    'installationId' in identity
      ? identity.installationId
      : publicRepoContentsCacheIdentity(identity.owner, identity.repo);
  const repoFullName = 'repoFullName' in identity ? identity.repoFullName : `${identity.owner}/${identity.repo}`;

  const files: RepoFileEntry[] = [];
  for (const entry of tree) {
    const cacheKey = repoContentsCacheKey(cacheIdentity, repoFullName, entry.path);
    const cached = repoContentsCache.get(cacheKey);
    if (!cached || Array.isArray(cached) || cached.type !== 'file' || !cached.content) return null;
    try {
      const content = atob(cached.content);
      files.push({ path: entry.path, content, size: content.length });
    } catch {
      return null;
    }
  }
  return files;
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

export async function renameRepoPathsAtomic(
  installationId: string,
  repoFullName: string,
  renames: RepoBatchRename[],
  message: string,
): Promise<void> {
  await runRepoGitBatchMutation(installationId, repoFullName, { renames, message });
}

async function runRepoGitBatchMutation(
  installationId: string,
  repoFullName: string,
  body: {
    message: string;
    renames?: RepoBatchRename[];
    deletes?: string[];
    creates?: RepoBatchCreateFile[];
  },
): Promise<void> {
  const { owner, repo } = splitFullName(repoFullName);
  const url = `${installationUrl(installationId, 'repos', owner, repo)}/git-batch`;
  let attemptedRetry = false;
  while (true) {
    try {
      await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      break;
    } catch (err) {
      const isRetryableRefConflict =
        err instanceof ApiError && err.status === 409 && err.code === 'repo_ref_conflict' && !attemptedRetry;
      if (!isRetryableRefConflict) throw err;
      attemptedRetry = true;
      console.warn(`[github-app] git-batch ref conflict for ${repoFullName}; retrying once`);
    }
  }
  clearRepoContentsCacheForRepo(installationId, repoFullName);
}

export async function deleteRepoPathsAtomic(
  installationId: string,
  repoFullName: string,
  paths: string[],
  message: string,
): Promise<void> {
  await runRepoGitBatchMutation(installationId, repoFullName, { deletes: paths, message });
}

export async function createRepoFilesAtomic(
  installationId: string,
  repoFullName: string,
  files: RepoBatchCreateFile[],
  message: string,
): Promise<void> {
  await runRepoGitBatchMutation(installationId, repoFullName, { creates: files, message });
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
