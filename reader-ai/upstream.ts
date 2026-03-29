// ── LLM Provider Abstraction ──

import type { OpenRouterMessage, ReaderAiProviderConfig } from './types.ts';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export function buildUpstreamHeaders(config: ReaderAiProviderConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': config.referer || 'https://input.md',
    'X-Title': 'Input Reader AI',
    ...config.headers,
  };
}

export function buildPromptCacheControl(config: ReaderAiProviderConfig): { type: 'ephemeral' } | undefined {
  if (!config.promptCaching) return undefined;
  if (config.model.trim().toLowerCase().startsWith('anthropic/')) {
    return { type: 'ephemeral' };
  }
  return undefined;
}

export function isFreeTierModel(model: string): boolean {
  return model.trim().toLowerCase().endsWith(':free');
}

export async function callUpstream(
  config: ReaderAiProviderConfig,
  messages: OpenRouterMessage[],
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = buildUpstreamHeaders(config);
  const cacheControl = buildPromptCacheControl(config);

  return fetchFn(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      stream: true,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    }),
    signal,
  });
}

export async function callUpstreamNonStreaming(
  config: ReaderAiProviderConfig,
  messages: OpenRouterMessage[],
  maxTokens: number,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = buildUpstreamHeaders(config);
  const cacheControl = buildPromptCacheControl(config);

  return fetchFn(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      stream: false,
      max_tokens: maxTokens,
      messages,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    }),
    signal,
  });
}

/** Extract error message from an OpenRouter-style error response. */
export function readUpstreamError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const errorField = 'error' in payload ? (payload as { error?: unknown }).error : null;
  if (typeof errorField === 'string' && errorField) return errorField;
  if (errorField && typeof errorField === 'object') {
    const message = (errorField as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  const topMessage = 'message' in payload ? (payload as { message?: unknown }).message : null;
  if (typeof topMessage === 'string' && topMessage) return topMessage;
  return null;
}

/** Extract rate limit info from upstream response headers. */
export function readUpstreamRateLimitMessage(headers: Headers): string | null {
  const remaining = headers.get('x-ratelimit-remaining');
  const resetStr = headers.get('x-ratelimit-reset');
  if (remaining !== null && Number(remaining) <= 0 && resetStr) {
    const resetMs = Number(resetStr) * 1000;
    const now = Date.now();
    const waitSeconds = Math.max(1, Math.ceil((resetMs - now) / 1000));
    return `Rate limited by upstream provider. Try again in ${waitSeconds}s.`;
  }
  return null;
}
