import test from 'ava';
import { UPSTREAM_PROXY_SESSION_HEADER, UPSTREAM_PROXY_USER_AGENT_HEADER } from '../../shared/upstream_proxy.ts';
import {
  attachUpstreamProxyCookies,
  buildUpstreamProxyRequestHeaders,
  buildUpstreamProxyUrl,
  getUpstreamProxyForwardedUserAgent,
  getUpstreamProxySessionId,
  storeUpstreamProxyResponseCookies,
  UPSTREAM_PROXY_ALLOWED_HOSTS,
} from '../upstream_proxy.ts';

test('upstream proxy helper exposes the allowed upstream hosts', (t) => {
  t.deepEqual([...UPSTREAM_PROXY_ALLOWED_HOSTS], ['api.anthropic.com', 'downloads.claude.ai', 'platform.claude.com']);
});

test('upstream proxy helper builds the upstream URL from the proxy pathname', (t) => {
  const upstream = buildUpstreamProxyUrl('/api/upstream-proxy/api.anthropic.com/v1/messages', '?beta=true');

  t.is(upstream.toString(), 'https://api.anthropic.com/v1/messages?beta=true');
});

test('upstream proxy helper strips hop-by-hop and local-only request headers', (t) => {
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

test('upstream proxy helper reads the proxy session id header', (t) => {
  t.is(getUpstreamProxySessionId({ [UPSTREAM_PROXY_SESSION_HEADER]: ' session-123 ' }), 'session-123');
  t.is(getUpstreamProxySessionId({ [UPSTREAM_PROXY_SESSION_HEADER]: '' }), null);
});

test('upstream proxy helper reads the forwarded user agent header', (t) => {
  t.is(
    getUpstreamProxyForwardedUserAgent({ [UPSTREAM_PROXY_USER_AGENT_HEADER]: ' Claude-Code/2.1.97 ' }),
    'Claude-Code/2.1.97',
  );
  t.is(getUpstreamProxyForwardedUserAgent({ [UPSTREAM_PROXY_USER_AGENT_HEADER]: '' }), null);
});

test('upstream proxy cookie jar replays matching cookies for a session and host', (t) => {
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

test('upstream proxy cookie jar drops expired cookies and deletion cookies', (t) => {
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
