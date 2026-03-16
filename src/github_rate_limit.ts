export interface GitHubRateLimitSnapshot {
  limit: number;
  remaining: number;
  resetAtUnixSeconds: number | null;
  observedAtMs: number;
}

export type GitHubRateLimitSource = 'server' | 'serverLocal';

interface RateLimitUpdateEventDetail {
  source: GitHubRateLimitSource;
  snapshot: GitHubRateLimitSnapshot;
}

const RATE_LIMIT_EVENT = 'github-rate-limit-update';
const RATE_LIMIT_STORAGE_KEY_PREFIX = 'github_rate_limit_snapshot';

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function storageKey(source: GitHubRateLimitSource): string {
  return `${RATE_LIMIT_STORAGE_KEY_PREFIX}:${source}`;
}

export function readStoredGitHubRateLimitSnapshot(source: GitHubRateLimitSource): GitHubRateLimitSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(source));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GitHubRateLimitSnapshot>;
    if (typeof parsed.limit !== 'number' || !Number.isFinite(parsed.limit)) return null;
    if (typeof parsed.remaining !== 'number' || !Number.isFinite(parsed.remaining)) return null;
    return {
      limit: Math.max(0, Math.floor(parsed.limit)),
      remaining: Math.max(0, Math.floor(parsed.remaining)),
      resetAtUnixSeconds:
        typeof parsed.resetAtUnixSeconds === 'number' && Number.isFinite(parsed.resetAtUnixSeconds)
          ? Math.floor(parsed.resetAtUnixSeconds)
          : null,
      observedAtMs:
        typeof parsed.observedAtMs === 'number' && Number.isFinite(parsed.observedAtMs)
          ? Math.floor(parsed.observedAtMs)
          : Date.now(),
    };
  } catch {
    return null;
  }
}

function storeSnapshot(source: GitHubRateLimitSource, snapshot: GitHubRateLimitSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures.
  }
  window.dispatchEvent(
    new CustomEvent<RateLimitUpdateEventDetail>(RATE_LIMIT_EVENT, {
      detail: { source, snapshot },
    }),
  );
}

export function recordGitHubRateLimitFromResponse(res: Response): void {
  const limit = parseHeaderInt(res.headers.get('x-ratelimit-limit'));
  const remaining = parseHeaderInt(res.headers.get('x-ratelimit-remaining'));
  if (limit == null || remaining == null || limit <= 0) return;

  storeSnapshot('server', {
    limit,
    remaining: Math.min(remaining, limit),
    resetAtUnixSeconds: parseHeaderInt(res.headers.get('x-ratelimit-reset')),
    observedAtMs: Date.now(),
  });
}

export function recordServerLocalRateLimitFromResponse(res: Response): void {
  const limit = parseHeaderInt(res.headers.get('x-input-ratelimit-limit'));
  const remaining = parseHeaderInt(res.headers.get('x-input-ratelimit-remaining'));
  if (limit == null || remaining == null || limit <= 0) return;

  storeSnapshot('serverLocal', {
    limit,
    remaining: Math.min(remaining, limit),
    resetAtUnixSeconds: parseHeaderInt(res.headers.get('x-input-ratelimit-reset')),
    observedAtMs: Date.now(),
  });
}

export function subscribeGitHubRateLimitUpdates(
  onUpdate: (source: GitHubRateLimitSource, snapshot: GitHubRateLimitSnapshot) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const custom = event as CustomEvent<RateLimitUpdateEventDetail>;
    if (custom.detail) onUpdate(custom.detail.source, custom.detail.snapshot);
  };
  window.addEventListener(RATE_LIMIT_EVENT, handler);
  return () => window.removeEventListener(RATE_LIMIT_EVENT, handler);
}
