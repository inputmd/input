import https from 'node:https';

const originalHttpsRequest = https.request;

export const REQUEST_HEADER_RULES = [
  {
    id: 'anthropic-direct-browser-access',
    match: {
      protocol: 'https:',
      hostname: 'api.anthropic.com',
      pathnamePrefix: '/',
    },
    headers: {
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  },
];

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function mergeHeaders(headers, overrides) {
  if (Array.isArray(headers)) {
    return [...headers, ...Object.entries(overrides).flatMap(([key, value]) => [key, value])];
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const nextHeaders = new Headers(headers);
    for (const [key, value] of Object.entries(overrides)) {
      nextHeaders.set(key, value);
    }
    return nextHeaders;
  }
  return {
    ...(isPlainObject(headers) ? headers : {}),
    ...overrides,
  };
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

export function matchesRequestHeaderRule(url, rule) {
  if (!(url instanceof URL)) return false;
  if (rule.match.protocol && url.protocol !== rule.match.protocol) return false;
  if (rule.match.hostname && url.hostname !== rule.match.hostname) return false;
  if (rule.match.pathnamePrefix && !url.pathname.startsWith(rule.match.pathnamePrefix)) return false;
  return true;
}

export function resolveHttpsRequestHeaderOverrides(url) {
  const headers = {};
  for (const rule of REQUEST_HEADER_RULES) {
    if (!matchesRequestHeaderRule(url, rule)) continue;
    Object.assign(headers, rule.headers);
  }
  return Object.keys(headers).length > 0 ? headers : null;
}

export function buildPatchedHttpsRequestArgs(args) {
  const nextArgs = [...args];
  const primary = nextArgs[0];
  const secondary = nextArgs[1];
  const requestUrl = normalizeHttpsRequestUrl(primary, secondary);
  if (!requestUrl) return nextArgs;

  const headerOverrides = resolveHttpsRequestHeaderOverrides(requestUrl);
  if (!headerOverrides) return nextArgs;

  if (isPlainObject(primary)) {
    nextArgs[0] = {
      ...primary,
      headers: mergeHeaders(primary.headers, headerOverrides),
    };
    return nextArgs;
  }

  if (isPlainObject(secondary)) {
    nextArgs[1] = {
      ...secondary,
      headers: mergeHeaders(secondary.headers, headerOverrides),
    };
    return nextArgs;
  }

  const injectedOptions = { headers: { ...headerOverrides } };
  if (typeof secondary === 'function') {
    nextArgs.splice(1, 0, injectedOptions);
  } else {
    nextArgs[1] = injectedOptions;
  }
  return nextArgs;
}

https.request = function (...args) {
  return Reflect.apply(originalHttpsRequest, this, buildPatchedHttpsRequestArgs(args));
};
