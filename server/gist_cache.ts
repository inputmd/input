import type { GistCacheEntry } from './types';

const GIST_CACHE_TTL_MS = 5 * 60 * 1000;
const GIST_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const GIST_CACHE_MAX_ENTRY_BYTES = 512 * 1024;

const gistCache = new Map<string, GistCacheEntry>();
let gistCacheTotalBytes = 0;

export function startGistCacheCleanup(): void {
  setInterval(() => {
    const cutoff = Date.now() - GIST_CACHE_TTL_MS * 10;
    for (const [key, entry] of gistCache) {
      if (entry.cachedAt < cutoff) {
        gistCacheTotalBytes -= entry.size;
        gistCache.delete(key);
      }
    }
  }, 10 * 60 * 1000).unref();
}

function gistCacheSet(id: string, entry: GistCacheEntry): void {
  const existing = gistCache.get(id);
  if (existing) gistCacheTotalBytes -= existing.size;

  while (gistCacheTotalBytes + entry.size > GIST_CACHE_MAX_BYTES && gistCache.size > 0) {
    const oldest = gistCache.keys().next().value;
    if (oldest === undefined) break;
    const removed = gistCache.get(oldest);
    if (!removed) break;
    gistCacheTotalBytes -= removed.size;
    gistCache.delete(oldest);
  }

  gistCache.set(id, entry);
  gistCacheTotalBytes += entry.size;
}

export function getGistCacheEntry(id: string): GistCacheEntry | undefined {
  return gistCache.get(id);
}

export function setGistCacheEntry(id: string, data: unknown, etag: string | null, now: number): void {
  const serialized = JSON.stringify(data);
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > GIST_CACHE_MAX_ENTRY_BYTES) return;
  gistCacheSet(id, { data, etag, cachedAt: now, size });
}

export function isFresh(entry: GistCacheEntry, now: number): boolean {
  return now - entry.cachedAt < GIST_CACHE_TTL_MS;
}

export function markRevalidated(entry: GistCacheEntry, now: number): void {
  entry.cachedAt = now;
}
