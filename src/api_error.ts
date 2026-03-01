export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type ErrorBody = {
  error?: string;
  message?: string;
};

export async function responseToApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null;
  const message = body?.error ?? body?.message ?? `${res.status} ${res.statusText}`;
  return new ApiError(res.status, message);
}

export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = err instanceof ApiError ? err.status : null;
  if (status === 429) return true;
  if (status === 403 && /rate limit|abuse|secondary/i.test(err.message)) return true;
  return /(^|\b)429(\b|$)|too many requests|rate limit|abuse detection|secondary rate limit/i.test(err.message);
}

export function rateLimitToastMessage(err: unknown): string {
  const base = 'GitHub API rate limit reached. Please wait a bit and try again.';
  if (!(err instanceof Error)) return base;
  if (/secondary rate limit/i.test(err.message)) {
    return 'GitHub secondary rate limit reached. Please slow down and try again shortly.';
  }
  return base;
}
