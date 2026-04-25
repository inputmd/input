import type { TarballFile } from './repo_tarball.ts';

const REPO_TARBALL_CACHE_TTL_MS = 30_000;
const REPO_TARBALL_CACHE_MAX_ENTRIES = 20;

type RepoTarballCacheStatus = 'hit' | 'miss' | 'deduped';

interface RepoTarballCacheEntry {
  files: TarballFile[];
  expiresAt: number;
}

const repoTarballCache = new Map<string, RepoTarballCacheEntry>();
const repoTarballInflightLoads = new Map<string, Promise<TarballFile[]>>();
let repoTarballCacheInvalidationVersion = 0;

function normalizeRepoName(owner: string, repo: string): string {
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}`;
}

function normalizeRef(ref: string): string {
  return ref.trim() || 'HEAD';
}

function installedRepoTarballCacheKey(installationId: string, owner: string, repo: string, ref: string): string {
  return `installed|${installationId}|${normalizeRepoName(owner, repo)}|${normalizeRef(ref)}`;
}

function publicRepoTarballCacheKey(owner: string, repo: string, ref: string): string {
  return `public|${normalizeRepoName(owner, repo)}|${normalizeRef(ref)}`;
}

function installedRepoTarballCachePrefix(installationId: string, owner: string, repo: string): string {
  return `installed|${installationId}|${normalizeRepoName(owner, repo)}|`;
}

function publicRepoTarballCachePrefix(owner: string, repo: string): string {
  return `public|${normalizeRepoName(owner, repo)}|`;
}

function cloneTarballFiles(files: readonly TarballFile[]): TarballFile[] {
  return files.map((file) => ({ ...file }));
}

function pruneExpiredRepoTarballCache(nowMs = Date.now()): void {
  for (const [key, entry] of repoTarballCache) {
    if (entry.expiresAt <= nowMs) repoTarballCache.delete(key);
  }
}

function enforceRepoTarballCacheLimit(): void {
  while (repoTarballCache.size > REPO_TARBALL_CACHE_MAX_ENTRIES) {
    const oldestKey = repoTarballCache.keys().next().value;
    if (typeof oldestKey !== 'string') return;
    repoTarballCache.delete(oldestKey);
  }
}

function getCachedRepoTarballFiles(key: string, nowMs = Date.now()): TarballFile[] | null {
  const cached = repoTarballCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= nowMs) {
    repoTarballCache.delete(key);
    return null;
  }
  repoTarballCache.delete(key);
  repoTarballCache.set(key, cached);
  return cloneTarballFiles(cached.files);
}

function setCachedRepoTarballFiles(key: string, files: readonly TarballFile[], nowMs = Date.now()): void {
  pruneExpiredRepoTarballCache(nowMs);
  repoTarballCache.delete(key);
  repoTarballCache.set(key, {
    files: cloneTarballFiles(files),
    expiresAt: nowMs + REPO_TARBALL_CACHE_TTL_MS,
  });
  enforceRepoTarballCacheLimit();
}

async function getOrLoadRepoTarballFiles(
  key: string,
  load: () => Promise<TarballFile[]>,
  nowMs = Date.now(),
): Promise<{ files: TarballFile[]; status: RepoTarballCacheStatus }> {
  const cached = getCachedRepoTarballFiles(key, nowMs);
  if (cached) return { files: cached, status: 'hit' };

  const inflight = repoTarballInflightLoads.get(key);
  if (inflight) {
    return { files: cloneTarballFiles(await inflight), status: 'deduped' };
  }

  const promise = load();
  repoTarballInflightLoads.set(key, promise);
  const invalidationVersion = repoTarballCacheInvalidationVersion;
  try {
    const files = await promise;
    if (repoTarballCacheInvalidationVersion === invalidationVersion) {
      setCachedRepoTarballFiles(key, files);
    }
    return { files: cloneTarballFiles(files), status: 'miss' };
  } finally {
    if (repoTarballInflightLoads.get(key) === promise) {
      repoTarballInflightLoads.delete(key);
    }
  }
}

export async function getOrLoadInstalledRepoTarballFiles(
  installationId: string,
  owner: string,
  repo: string,
  ref: string,
  load: () => Promise<TarballFile[]>,
): Promise<{ files: TarballFile[]; status: RepoTarballCacheStatus }> {
  return getOrLoadRepoTarballFiles(installedRepoTarballCacheKey(installationId, owner, repo, ref), load);
}

export async function getOrLoadPublicRepoTarballFiles(
  owner: string,
  repo: string,
  ref: string,
  load: () => Promise<TarballFile[]>,
): Promise<{ files: TarballFile[]; status: RepoTarballCacheStatus }> {
  return getOrLoadRepoTarballFiles(publicRepoTarballCacheKey(owner, repo, ref), load);
}

function clearRepoTarballCacheByPrefix(prefix: string): void {
  repoTarballCacheInvalidationVersion += 1;
  for (const key of repoTarballCache.keys()) {
    if (key.startsWith(prefix)) repoTarballCache.delete(key);
  }
  for (const key of repoTarballInflightLoads.keys()) {
    if (key.startsWith(prefix)) repoTarballInflightLoads.delete(key);
  }
}

export function clearInstalledRepoTarballCache(installationId: string, owner: string, repo: string): void {
  clearRepoTarballCacheByPrefix(installedRepoTarballCachePrefix(installationId, owner, repo));
}

export function clearPublicRepoTarballCache(owner: string, repo: string): void {
  clearRepoTarballCacheByPrefix(publicRepoTarballCachePrefix(owner, repo));
}

export function clearAllRepoTarballCache(): void {
  repoTarballCacheInvalidationVersion += 1;
  repoTarballCache.clear();
  repoTarballInflightLoads.clear();
}

export const repoTarballCacheTestUtils = {
  installedRepoTarballCacheKey,
  publicRepoTarballCacheKey,
  getOrLoadRepoTarballFiles,
  clearRepoTarballCacheByPrefix,
};
