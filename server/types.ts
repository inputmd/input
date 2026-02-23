export interface Session {
  id: string;
  githubUserId: number;
  githubAccessToken: string;
  githubLogin: string;
  githubAvatarUrl: string;
  githubName: string | null;
  installationId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
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
