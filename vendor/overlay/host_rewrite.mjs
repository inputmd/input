import http from 'node:http';
import https from 'node:https';

const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;

export const DEFAULT_HOST_BRIDGE_URL = 'http://127.0.0.1:4318';
export const REWRITE_HOSTS = [
  'accounts.google.com',
  'ai-gateway.vercel.sh',
  'api.anthropic.com',
  'api.cerebras.ai',
  'api.github.com',
  'api.groq.com',
  'api.individual.githubcopilot.com',
  'api.kimi.com',
  'api.minimax.io',
  'api.minimaxi.com',
  'api.mistral.ai',
  'api.openai.com',
  'api.x.ai',
  'api.z.ai',
  'auth.openai.com',
  'autopush-cloudcode-pa.sandbox.googleapis.com',
  'chatgpt.com',
  'claude.ai',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
  'downloads.claude.ai',
  'generativelanguage.googleapis.com',
  'github.com',
  'mcp-proxy.anthropic.com',
  'opencode.ai',
  'oauth2.googleapis.com',
  'openrouter.ai',
  'platform.claude.com',
  'router.huggingface.co',
  'www.googleapis.com',
];
export const REWRITE_HOST_PATTERNS = ['*.openai.azure.com', '*-aiplatform.googleapis.com'];
export const SWALLOW_HOST_PATTERNS = ['*.logs.*.datadoghq.com'];

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function stripHostHeaders(headers) {
  if (Array.isArray(headers)) {
    const next = [];
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index];
      const value = headers[index + 1];
      if (typeof name === 'string' && name.toLowerCase() === 'host') continue;
      next.push(name, value);
    }
    return next;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const nextHeaders = new Headers(headers);
    nextHeaders.delete('host');
    return nextHeaders;
  }
  if (!isPlainObject(headers)) return headers;
  const nextHeaders = { ...headers };
  delete nextHeaders.host;
  delete nextHeaders.Host;
  return nextHeaders;
}

function buildRequestUrlFromOptions(options) {
  if (!isPlainObject(options)) return null;
  const protocol = typeof options.protocol === 'string' && options.protocol ? options.protocol : 'https:';
  const authority =
    typeof options.hostname === 'string' && options.hostname
      ? options.port
        ? `${options.hostname}:${options.port}`
        : options.hostname
      : typeof options.host === 'string' && options.host
        ? options.host
        : '';
  if (!authority) return null;
  const path = typeof options.path === 'string' && options.path ? options.path : '/';
  try {
    return new URL(path, `${protocol}//${authority}`);
  } catch {
    try {
      return new URL(`${protocol}//${authority}`);
    } catch {
      return null;
    }
  }
}

function hostnameMatchesPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const escapedPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^.]+');
  return new RegExp(`^${escapedPattern}$`, 'i').test(hostname);
}

export function normalizeHttpsRequestUrl(primary, secondary) {
  if (primary instanceof URL) return primary;
  if (typeof primary === 'string') {
    try {
      return new URL(primary);
    } catch {
      return null;
    }
  }
  return buildRequestUrlFromOptions(secondary) ?? buildRequestUrlFromOptions(primary);
}

export function resolveHostBridgeBaseUrl(rawBaseUrl = process.env.INPUT_HOST_BRIDGE_URL) {
  try {
    return new URL(rawBaseUrl || DEFAULT_HOST_BRIDGE_URL);
  } catch {
    return new URL(DEFAULT_HOST_BRIDGE_URL);
  }
}

export function shouldRewriteHostBridgeUrl(url) {
  return (
    url instanceof URL &&
    (REWRITE_HOSTS.includes(url.hostname) ||
      REWRITE_HOST_PATTERNS.some((pattern) => hostnameMatchesPattern(url.hostname, pattern)))
  );
}

export function shouldSwallowHostBridgeUrl(url) {
  return url instanceof URL && SWALLOW_HOST_PATTERNS.some((pattern) => hostnameMatchesPattern(url.hostname, pattern));
}

export function buildHostBridgeProxyUrl(url, rawBaseUrl = process.env.INPUT_HOST_BRIDGE_URL) {
  const baseUrl = resolveHostBridgeBaseUrl(rawBaseUrl);
  const nextUrl = new URL(baseUrl.href);
  nextUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/proxy/${encodeURIComponent(url.hostname)}${url.pathname}`;
  nextUrl.search = url.search;
  return nextUrl;
}

export function buildPatchedHttpsRequestArgs(args, rawBaseUrl = process.env.INPUT_HOST_BRIDGE_URL) {
  const nextArgs = [...args];
  const primary = nextArgs[0];
  const secondary = nextArgs[1];
  const requestUrl = normalizeHttpsRequestUrl(primary, secondary);
  if (!requestUrl) return nextArgs;

  if (!shouldRewriteHostBridgeUrl(requestUrl)) return nextArgs;
  const bridgeUrl = buildHostBridgeProxyUrl(requestUrl, rawBaseUrl);

  if (isPlainObject(primary)) {
    nextArgs[0] = {
      ...primary,
      headers: stripHostHeaders(primary.headers),
      host: bridgeUrl.host,
      hostname: bridgeUrl.hostname,
      path: `${bridgeUrl.pathname}${bridgeUrl.search}`,
      port: bridgeUrl.port || '80',
      protocol: bridgeUrl.protocol,
      servername: bridgeUrl.hostname,
    };
    return nextArgs;
  }

  nextArgs[0] = bridgeUrl;
  if (isPlainObject(secondary) && secondary.headers) {
    nextArgs[1] = {
      ...secondary,
      headers: stripHostHeaders(secondary.headers),
    };
  }
  return nextArgs;
}

export function rewriteFetchInput(input, rawBaseUrl = process.env.INPUT_HOST_BRIDGE_URL) {
  let requestUrl = null;
  try {
    requestUrl =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : input && input.url
            ? new URL(input.url)
            : null;
  } catch {
    requestUrl = null;
  }
  if (!requestUrl || !shouldRewriteHostBridgeUrl(requestUrl)) return null;
  return buildHostBridgeProxyUrl(requestUrl, rawBaseUrl);
}

https.request = function (...args) {
  const patchedArgs = buildPatchedHttpsRequestArgs(args);
  const patchedUrl = normalizeHttpsRequestUrl(patchedArgs[0], patchedArgs[1]);
  if (patchedUrl?.protocol === 'http:') {
    return Reflect.apply(originalHttpRequest, this, patchedArgs);
  }
  return Reflect.apply(originalHttpsRequest, this, patchedArgs);
};

const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = function (input, init) {
    let requestUrl = null;
    try {
      requestUrl =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : input && input.url
              ? new URL(input.url)
              : null;
    } catch {
      requestUrl = null;
    }
    if (shouldSwallowHostBridgeUrl(requestUrl)) {
      return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }));
    }
    const bridgeUrl = rewriteFetchInput(input);
    if (!bridgeUrl) {
      return originalFetch.call(this, input, init);
    }
    if (typeof input === 'string' || input instanceof URL) {
      return originalFetch.call(this, bridgeUrl, init);
    }
    return originalFetch.call(this, new Request(bridgeUrl, input), init);
  };
}
