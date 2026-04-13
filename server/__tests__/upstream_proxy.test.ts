import { once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'ava';
import { UPSTREAM_PROXY_SESSION_HEADER, UPSTREAM_PROXY_USER_AGENT_HEADER } from '../../shared/upstream_proxy.ts';
import { ClientError } from '../errors.ts';
import {
  acquireUpstreamProxyConcurrency,
  assertUpstreamProxyContentLengthWithinLimit,
  attachUpstreamProxyCookies,
  buildUpstreamProxyRequestHeaders,
  buildUpstreamProxyUrl,
  createUpstreamProxyBodyLimitTransform,
  getUpstreamProxyForwardedUserAgent,
  getUpstreamProxySessionId,
  resetUpstreamProxyStateForTests,
  storeUpstreamProxyResponseCookies,
  UPSTREAM_PROXY_ALLOWED_HOST_PATTERNS,
  UPSTREAM_PROXY_ALLOWED_HOSTS,
} from '../upstream_proxy.ts';

test.afterEach.always(() => {
  resetUpstreamProxyStateForTests();
});

test.serial('upstream proxy helper exposes the allowed upstream hosts', (t) => {
  t.deepEqual(
    [...UPSTREAM_PROXY_ALLOWED_HOSTS],
    [
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
    ],
  );
  t.deepEqual(UPSTREAM_PROXY_ALLOWED_HOST_PATTERNS, ['*.openai.azure.com', '*-aiplatform.googleapis.com']);
});

test.serial('upstream proxy helper builds the upstream URL from the proxy pathname', (t) => {
  const upstream = buildUpstreamProxyUrl('/api/upstream-proxy/api.anthropic.com/v1/messages', '?beta=true');

  t.is(upstream.toString(), 'https://api.anthropic.com/v1/messages?beta=true');
});

test.serial('upstream proxy helper allows configured wildcard provider hosts', (t) => {
  const azureUpstream = buildUpstreamProxyUrl('/api/upstream-proxy/my-resource.openai.azure.com/openai/v1/responses');
  t.is(azureUpstream.toString(), 'https://my-resource.openai.azure.com/openai/v1/responses');

  const vertexUpstream = buildUpstreamProxyUrl('/api/upstream-proxy/us-central1-aiplatform.googleapis.com/v1/projects');
  t.is(vertexUpstream.toString(), 'https://us-central1-aiplatform.googleapis.com/v1/projects');
});

test.serial('upstream proxy helper strips hop-by-hop and local-only request headers', (t) => {
  const headers = buildUpstreamProxyRequestHeaders({
    authorization: 'Bearer test',
    connection: 'keep-alive',
    cookie: 'session=abc',
    'content-type': 'application/json',
    dnt: '1',
    host: 'localhost:8787',
    origin: 'https://example.com',
    referer: 'https://example.com/login',
    'sec-ch-ua': '"Chromium";v="135"',
    'sec-fetch-mode': 'cors',
    'sec-gpc': '1',
    [UPSTREAM_PROXY_SESSION_HEADER]: 'proxy-session-1',
    [UPSTREAM_PROXY_USER_AGENT_HEADER]: 'Claude-Code/2.1.97',
  });

  t.is(headers.get('authorization'), 'Bearer test');
  t.is(headers.get('content-type'), 'application/json');
  t.is(headers.get('connection'), null);
  t.is(headers.get('cookie'), null);
  t.is(headers.get('dnt'), null);
  t.is(headers.get('host'), null);
  t.is(headers.get('origin'), null);
  t.is(headers.get('referer'), null);
  t.is(headers.get('sec-ch-ua'), null);
  t.is(headers.get('sec-fetch-mode'), null);
  t.is(headers.get('sec-gpc'), null);
  t.is(headers.get(UPSTREAM_PROXY_SESSION_HEADER), null);
  t.is(headers.get(UPSTREAM_PROXY_USER_AGENT_HEADER), null);
});

test.serial('upstream proxy helper reads the proxy session id header', (t) => {
  t.is(getUpstreamProxySessionId({ [UPSTREAM_PROXY_SESSION_HEADER]: ' session-123 ' }), 'session-123');
  t.is(getUpstreamProxySessionId({ [UPSTREAM_PROXY_SESSION_HEADER]: '' }), null);
  t.is(getUpstreamProxySessionId({ [UPSTREAM_PROXY_SESSION_HEADER]: 'x'.repeat(129) }), null);
});

test.serial('upstream proxy helper reads the forwarded user agent header', (t) => {
  t.is(
    getUpstreamProxyForwardedUserAgent({ [UPSTREAM_PROXY_USER_AGENT_HEADER]: ' Claude-Code/2.1.97 ' }),
    'Claude-Code/2.1.97',
  );
  t.is(getUpstreamProxyForwardedUserAgent({ [UPSTREAM_PROXY_USER_AGENT_HEADER]: '' }), null);
});

test.serial('upstream proxy cookie jar replays matching cookies for a session and host', (t) => {
  const nowMs = 1_000;
  const responseHeaders = new Headers();
  const typedHeaders = responseHeaders as Headers & { getSetCookie: () => string[] };
  typedHeaders.getSetCookie = () => [
    'session=abc; Path=/api/oauth; HttpOnly',
    'roles=writer; Path=/api/oauth/claude_cli',
  ];

  storeUpstreamProxyResponseCookies('session-a', 'api.anthropic.com', responseHeaders, nowMs);

  const profileHeaders = new Headers();
  attachUpstreamProxyCookies(profileHeaders, 'session-a', 'api.anthropic.com', '/api/oauth/profile', nowMs + 1);
  t.is(profileHeaders.get('cookie'), 'session=abc');

  const rolesHeaders = new Headers();
  attachUpstreamProxyCookies(rolesHeaders, 'session-a', 'api.anthropic.com', '/api/oauth/claude_cli/roles', nowMs + 1);
  t.is(rolesHeaders.get('cookie'), 'roles=writer; session=abc');

  const differentHostHeaders = new Headers();
  attachUpstreamProxyCookies(differentHostHeaders, 'session-a', 'platform.claude.com', '/api/oauth/profile', nowMs + 1);
  t.is(differentHostHeaders.get('cookie'), null);
});

test.serial('upstream proxy cookie jar drops expired cookies and deletion cookies', (t) => {
  const sessionId = 'session-b';
  const initialHeaders = new Headers();
  const initialTypedHeaders = initialHeaders as Headers & { getSetCookie: () => string[] };
  initialTypedHeaders.getSetCookie = () => ['session=abc; Path=/api/oauth; Max-Age=60'];
  storeUpstreamProxyResponseCookies(sessionId, 'api.anthropic.com', initialHeaders, 2_000);

  const deleteHeaders = new Headers();
  const deleteTypedHeaders = deleteHeaders as Headers & { getSetCookie: () => string[] };
  deleteTypedHeaders.getSetCookie = () => ['session=deleted; Path=/api/oauth; Max-Age=0'];
  storeUpstreamProxyResponseCookies(sessionId, 'api.anthropic.com', deleteHeaders, 2_500);

  const replayHeaders = new Headers();
  attachUpstreamProxyCookies(replayHeaders, sessionId, 'api.anthropic.com', '/api/oauth/profile', 2_501);
  t.is(replayHeaders.get('cookie'), null);
});

test.serial('upstream proxy cookie jar evicts least-recently-used sessions when the session cap is exceeded', (t) => {
  const limits = { maxSessions: 1 };
  const headersA = new Headers();
  const typedHeadersA = headersA as Headers & { getSetCookie: () => string[] };
  typedHeadersA.getSetCookie = () => ['session=alpha; Path=/'];
  storeUpstreamProxyResponseCookies('session-a', 'api.anthropic.com', headersA, 1_000, limits);

  const headersB = new Headers();
  const typedHeadersB = headersB as Headers & { getSetCookie: () => string[] };
  typedHeadersB.getSetCookie = () => ['session=beta; Path=/'];
  storeUpstreamProxyResponseCookies('session-b', 'api.anthropic.com', headersB, 2_000, limits);

  const replayA = new Headers();
  attachUpstreamProxyCookies(replayA, 'session-a', 'api.anthropic.com', '/', 2_001);
  t.is(replayA.get('cookie'), null);

  const replayB = new Headers();
  attachUpstreamProxyCookies(replayB, 'session-b', 'api.anthropic.com', '/', 2_001);
  t.is(replayB.get('cookie'), 'session=beta');
});

test.serial('upstream proxy cookie jar evicts least-recently-used hosts within a session', (t) => {
  const limits = { maxHostsPerSession: 1 };
  const apiHeaders = new Headers();
  const typedApiHeaders = apiHeaders as Headers & { getSetCookie: () => string[] };
  typedApiHeaders.getSetCookie = () => ['session=alpha; Path=/'];
  storeUpstreamProxyResponseCookies('session-a', 'api.anthropic.com', apiHeaders, 1_000, limits);

  const platformHeaders = new Headers();
  const typedPlatformHeaders = platformHeaders as Headers & { getSetCookie: () => string[] };
  typedPlatformHeaders.getSetCookie = () => ['session=beta; Path=/'];
  storeUpstreamProxyResponseCookies('session-a', 'platform.claude.com', platformHeaders, 2_000, limits);

  const replayApi = new Headers();
  attachUpstreamProxyCookies(replayApi, 'session-a', 'api.anthropic.com', '/', 2_001);
  t.is(replayApi.get('cookie'), null);

  const replayPlatform = new Headers();
  attachUpstreamProxyCookies(replayPlatform, 'session-a', 'platform.claude.com', '/', 2_001);
  t.is(replayPlatform.get('cookie'), 'session=beta');
});

test.serial('upstream proxy cookie jar caps cookies per host', (t) => {
  const limits = { maxCookiesPerHost: 1 };
  const responseHeaders = new Headers();
  const typedHeaders = responseHeaders as Headers & { getSetCookie: () => string[] };
  typedHeaders.getSetCookie = () => ['first=one; Path=/', 'second=two; Path=/'];
  storeUpstreamProxyResponseCookies('session-a', 'api.anthropic.com', responseHeaders, 1_000, limits);

  const replayHeaders = new Headers();
  attachUpstreamProxyCookies(replayHeaders, 'session-a', 'api.anthropic.com', '/', 1_001);
  t.is(replayHeaders.get('cookie'), 'second=two');
});

test.serial('upstream proxy cookie jar caps total bytes per session', (t) => {
  const limits = { maxCookieBytesPerSession: 90 };
  const firstHeaders = new Headers();
  const typedFirstHeaders = firstHeaders as Headers & { getSetCookie: () => string[] };
  typedFirstHeaders.getSetCookie = () => ['first=1234567890; Path=/'];
  storeUpstreamProxyResponseCookies('session-a', 'api.anthropic.com', firstHeaders, 1_000, limits);

  const secondHeaders = new Headers();
  const typedSecondHeaders = secondHeaders as Headers & { getSetCookie: () => string[] };
  typedSecondHeaders.getSetCookie = () => ['second=abcdefghij; Path=/'];
  storeUpstreamProxyResponseCookies('session-a', 'api.anthropic.com', secondHeaders, 2_000, limits);

  const replayHeaders = new Headers();
  attachUpstreamProxyCookies(replayHeaders, 'session-a', 'api.anthropic.com', '/', 2_001);
  t.is(replayHeaders.get('cookie'), 'second=abcdefghij');
});

test.serial('upstream proxy cookie jar ignores oversized cookie values', (t) => {
  const limits = { maxCookieValueBytes: 3 };
  const responseHeaders = new Headers();
  const typedHeaders = responseHeaders as Headers & { getSetCookie: () => string[] };
  typedHeaders.getSetCookie = () => ['token=abcd; Path=/'];
  storeUpstreamProxyResponseCookies('session-a', 'api.anthropic.com', responseHeaders, 1_000, limits);

  const replayHeaders = new Headers();
  attachUpstreamProxyCookies(replayHeaders, 'session-a', 'api.anthropic.com', '/', 1_001);
  t.is(replayHeaders.get('cookie'), null);
});

test.serial('upstream proxy helper rejects oversized content-length headers', (t) => {
  t.notThrows(() => assertUpstreamProxyContentLengthWithinLimit('5', 5, 'request'));
  const err = t.throws(() => assertUpstreamProxyContentLengthWithinLimit('6', 5, 'response'), {
    instanceOf: ClientError,
  });
  t.is(err?.statusCode, 413);
  t.is(err?.message, 'Upstream proxy response body too large');
});

test.serial('upstream proxy helper caps streaming request bodies', async (t) => {
  const transform = createUpstreamProxyBodyLimitTransform(4, 'request');
  Readable.from([Buffer.from('hello')]).pipe(transform);

  const [err] = await once(transform, 'error');
  t.true(err instanceof ClientError);
  t.is((err as ClientError).statusCode, 413);
  t.is((err as ClientError).message, 'Upstream proxy request body too large');
});

test.serial('upstream proxy helper caps concurrent anonymous requests and releases slots', (t) => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.10' },
    socket: { remoteAddress: '127.0.0.1' },
  } as const;

  const releaseA = acquireUpstreamProxyConcurrency(req as never, null);
  const releaseB = acquireUpstreamProxyConcurrency(req as never, null);
  const err = t.throws(() => acquireUpstreamProxyConcurrency(req as never, null), { instanceOf: ClientError });
  t.is(err?.statusCode, 429);

  releaseA();
  const releaseC = acquireUpstreamProxyConcurrency(req as never, null);
  releaseB();
  releaseC();
});
