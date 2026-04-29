'use strict';

const { spawnSync } = require('node:child_process');

const DEFAULT_HOST_BRIDGE_URL = 'http://127.0.0.1:4318';
const REWRITE_HOSTS = new Set([
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
  'npmjs.org',
  'opencode.ai',
  'oauth2.googleapis.com',
  'openrouter.ai',
  'platform.claude.com',
  'registry.npmjs.org',
  'router.huggingface.co',
  'www.googleapis.com',
]);
const REWRITE_HOST_PATTERNS = ['*.openai.azure.com', '*-aiplatform.googleapis.com'];

const OPTIONS_WITH_VALUES = new Set([
  '--aws-sigv4',
  '--cacert',
  '--capath',
  '--cert',
  '--cert-type',
  '--ciphers',
  '--compressed-ssh',
  '--connect-timeout',
  '--connect-to',
  '--cookie',
  '--cookie-jar',
  '--data',
  '--data-ascii',
  '--data-binary',
  '--data-raw',
  '--data-urlencode',
  '--dns-interface',
  '--dns-ipv4-addr',
  '--dns-ipv6-addr',
  '--dns-servers',
  '--form',
  '--form-string',
  '--header',
  '--hostpubsha256',
  '--interface',
  '--key',
  '--key-type',
  '--limit-rate',
  '--local-port',
  '--mail-auth',
  '--mail-from',
  '--mail-rcpt',
  '--max-filesize',
  '--max-redirs',
  '--oauth2-bearer',
  '--output',
  '--pass',
  '--preproxy',
  '--proxy',
  '--proxy-cacert',
  '--proxy-capath',
  '--proxy-cert',
  '--proxy-ciphers',
  '--proxy-header',
  '--proxy-key',
  '--proxy-pass',
  '--proxy-service-name',
  '--proxy-tls13-ciphers',
  '--proxy-user',
  '--quote',
  '--range',
  '--referer',
  '--request',
  '--resolve',
  '--service-name',
  '--speed-limit',
  '--speed-time',
  '--time-cond',
  '--tls13-ciphers',
  '--upload-file',
  '--url-query',
  '--user',
  '--user-agent',
  '--variable',
  '--write-out',
]);
const SHORT_OPTIONS_WITH_VALUES = new Set(['A', 'b', 'c', 'd', 'e', 'F', 'H', 'K', 'm', 'o', 'Q', 'r', 'T', 'u', 'w', 'X', 'Y', 'y', 'z']);

function hostnameMatchesPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
  return new RegExp(`^${escapedPattern}$`, 'i').test(hostname);
}

function shouldRewriteHost(hostname) {
  const normalized = hostname.toLowerCase();
  return REWRITE_HOSTS.has(normalized) || REWRITE_HOST_PATTERNS.some((pattern) => hostnameMatchesPattern(normalized, pattern));
}

function parseCurlUrl(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) return null;
  try {
    const parsed = new URL(rawValue);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    // curl accepts bare host/path values. Only infer https for allowlisted hosts.
  }

  if (rawValue.startsWith('-') || rawValue.includes('://') || rawValue.startsWith('/')) return null;
  const host = rawValue.split(/[/?#]/, 1)[0]?.toLowerCase() ?? '';
  if (!shouldRewriteHost(host)) return null;
  try {
    return new URL(`https://${rawValue}`);
  } catch {
    return null;
  }
}

function buildHostBridgeProxyUrl(url, rawBaseUrl = process.env.INPUT_HOST_BRIDGE_URL) {
  const baseUrl = new URL(rawBaseUrl || DEFAULT_HOST_BRIDGE_URL);
  const nextUrl = new URL(baseUrl.href);
  const scheme = url.protocol.replace(/:$/, '');
  nextUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/proxy/${encodeURIComponent(scheme)}/${encodeURIComponent(url.host)}${url.pathname}`;
  nextUrl.search = url.search;
  return nextUrl.toString();
}

function rewriteCurlUrlArg(value, rawBaseUrl = process.env.INPUT_HOST_BRIDGE_URL) {
  const url = parseCurlUrl(value);
  return url ? buildHostBridgeProxyUrl(url, rawBaseUrl) : value;
}

function longOptionName(arg) {
  const equalsIndex = arg.indexOf('=');
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
}

function shortOptionRequiresValue(arg) {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg === '-') return false;
  const cluster = arg.slice(1);
  if (!cluster) return false;
  return SHORT_OPTIONS_WITH_VALUES.has(cluster[cluster.length - 1]);
}

function rewriteCurlArgs(args, rawBaseUrl = process.env.INPUT_HOST_BRIDGE_URL) {
  const nextArgs = [];
  let skipNextValue = false;
  let rewriteNextValue = false;

  for (const arg of args) {
    if (rewriteNextValue) {
      nextArgs.push(rewriteCurlUrlArg(arg, rawBaseUrl));
      rewriteNextValue = false;
      continue;
    }
    if (skipNextValue) {
      nextArgs.push(arg);
      skipNextValue = false;
      continue;
    }
    if (arg === '--') {
      nextArgs.push(arg);
      continue;
    }
    if (arg === '--url') {
      nextArgs.push(arg);
      rewriteNextValue = true;
      continue;
    }
    if (arg.startsWith('--url=')) {
      nextArgs.push(`--url=${rewriteCurlUrlArg(arg.slice('--url='.length), rawBaseUrl)}`);
      continue;
    }
    if (arg.startsWith('--')) {
      nextArgs.push(arg);
      const name = longOptionName(arg);
      skipNextValue = !arg.includes('=') && OPTIONS_WITH_VALUES.has(name);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      nextArgs.push(arg);
      skipNextValue = shortOptionRequiresValue(arg) && arg.length === 2;
      continue;
    }
    nextArgs.push(rewriteCurlUrlArg(arg, rawBaseUrl));
  }

  return nextArgs;
}

function resolveRealCurl(env = process.env) {
  if (env.INPUT_REAL_CURL) return env.INPUT_REAL_CURL;
  return '/usr/bin/curl';
}

function runCurl(args, options = {}) {
  const realCurl = resolveRealCurl(options.env ?? process.env);
  const rewrittenArgs = rewriteCurlArgs(args, options.hostBridgeUrl ?? process.env.INPUT_HOST_BRIDGE_URL);
  const result = spawnSync(realCurl, rewrittenArgs, {
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

module.exports = {
  buildHostBridgeProxyUrl,
  parseCurlUrl,
  rewriteCurlArgs,
  rewriteCurlUrlArg,
  runCurl,
  shouldRewriteHost,
};
