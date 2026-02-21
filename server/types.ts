export interface Session {
  installationId: string;
}

export interface TokenCacheRecord {
  token: string;
  expires_at: string;
  expiresAtMs: number;
}

export interface RateLimitEntry {
  count: number;
  resetAtMs: number;
}

export interface GistCacheEntry {
  data: unknown;
  etag: string | null;
  cachedAt: number;
  size: number;
}
