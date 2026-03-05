export class ApiError extends Error {
  status: number;
  code?: string;
  github?: GitHubErrorInfo;

  constructor(status: number, message: string, code?: string, github?: GitHubErrorInfo) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.github = github;
  }
}

interface GitHubRateLimitInfo {
  limit?: number | null;
  remaining?: number | null;
  used?: number | null;
  reset?: number | null;
  resetAt?: string | null;
  resource?: string | null;
  retryAfterSeconds?: number | null;
}

interface GitHubErrorInfo {
  status?: number;
  requestId?: string | null;
  isRateLimited?: boolean;
  isBadCredentials?: boolean;
  rateLimit?: GitHubRateLimitInfo;
}

type ErrorBody = {
  error?: string;
  message?: string;
  code?: string;
  github?: GitHubErrorInfo;
};

export async function responseToApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null;
  const message = body?.error ?? body?.message ?? `${res.status} ${res.statusText}`;
  return new ApiError(res.status, message, body?.code, body?.github);
}

export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = err instanceof ApiError ? err.status : null;
  const githubRateLimited = err instanceof ApiError ? err.github?.isRateLimited : false;
  if (githubRateLimited) return true;
  if (status === 429) return true;
  if (status === 403 && /rate limit|abuse|secondary/i.test(err.message)) return true;
  return /(^|\b)429(\b|$)|too many requests|rate limit|abuse detection|secondary rate limit/i.test(err.message);
}

export function rateLimitToastMessage(err: unknown): string {
  const base = 'GitHub API rate limit reached. Wait 60 seconds and try again.';
  if (!(err instanceof Error)) return base;
  if (err instanceof ApiError) {
    const resetAt = err.github?.rateLimit?.resetAt;
    if (typeof resetAt === 'string' && resetAt) {
      const parsedReset = new Date(resetAt);
      if (!Number.isNaN(parsedReset.valueOf())) {
        return `GitHub API rate limit reached. Wait 60 seconds and try again. (Reset at ${parsedReset.toLocaleTimeString()}.)`;
      }
    }
  }
  if (/secondary rate limit/i.test(err.message)) {
    return 'GitHub secondary rate limit reached. Wait 60 seconds and try again.';
  }
  return base;
}
