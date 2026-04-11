import https from 'node:https';
import test from 'ava';

async function loadHostRewriteOverlayModule() {
  const originalHttpsRequest = https.request;
  const url = new URL('../../vendor/overlay/host_rewrite.mjs', import.meta.url);
  url.searchParams.set('test', `${Date.now()}-${Math.random()}`);
  const module = (await import(url.href)) as typeof import('../../vendor/overlay/host_rewrite.mjs');
  return {
    module,
    restore() {
      https.request = originalHttpsRequest;
    },
  };
}

test('host rewrite overlay exposes the upstream hosts rewritten through the local bridge', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  t.deepEqual(module.REWRITE_HOSTS, [
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
  ]);
  t.deepEqual(module.REWRITE_HOST_PATTERNS, ['*.openai.azure.com', '*-aiplatform.googleapis.com']);
  t.deepEqual(module.SWALLOW_HOST_PATTERNS, ['*.logs.*.datadoghq.com']);
});

test('host rewrite overlay builds the local host bridge URL for matching upstream requests', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  const nextUrl = module.buildHostBridgeProxyUrl(
    new URL('https://api.anthropic.com/v1/messages?beta=true'),
    'http://127.0.0.1:4318',
  );

  t.is(nextUrl.toString(), 'http://127.0.0.1:4318/proxy/api.anthropic.com/v1/messages?beta=true');
});

test('host rewrite overlay rewrites https.request(url, callback) to the local bridge URL', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  const callback = () => {};
  const patchedArgs = module.buildPatchedHttpsRequestArgs(
    ['https://api.anthropic.com/v1/messages', callback],
    'http://127.0.0.1:4318',
  );

  t.true(patchedArgs[0] instanceof URL);
  t.is(String(patchedArgs[0]), 'http://127.0.0.1:4318/proxy/api.anthropic.com/v1/messages');
  t.is(patchedArgs[1], callback);
});

test('host rewrite overlay rewrites https.request(options) without mutating input options', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  const options = {
    headers: {
      authorization: 'Bearer test',
      host: 'api.anthropic.com',
    },
    hostname: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
  };
  const patchedArgs = module.buildPatchedHttpsRequestArgs([options], 'http://127.0.0.1:4318');

  t.deepEqual(patchedArgs[0], {
    headers: {
      authorization: 'Bearer test',
    },
    host: '127.0.0.1:4318',
    hostname: '127.0.0.1',
    method: 'POST',
    path: '/proxy/api.anthropic.com/v1/messages',
    port: '4318',
    protocol: 'http:',
    servername: '127.0.0.1',
  });
  t.not(patchedArgs[0], options);
  t.deepEqual(options, {
    headers: {
      authorization: 'Bearer test',
      host: 'api.anthropic.com',
    },
    hostname: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
  });
});

test('host rewrite overlay leaves unrelated requests unchanged', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  const options = { hostname: 'example.com', path: '/v1/messages' };
  const patchedArgs = module.buildPatchedHttpsRequestArgs([options]);

  t.is(patchedArgs[0], options);
  t.false(module.shouldRewriteHostBridgeUrl(new URL('https://example.com/v1/messages')));
});

test('host rewrite overlay matches configured wildcard provider hosts', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  t.true(module.shouldRewriteHostBridgeUrl(new URL('https://workspace.openai.azure.com/openai/v1/responses')));
  t.true(module.shouldRewriteHostBridgeUrl(new URL('https://us-central1-aiplatform.googleapis.com/v1/projects/test')));
  t.false(module.shouldRewriteHostBridgeUrl(new URL('https://openai.azure.com/openai/v1/responses')));
});

test('host rewrite overlay swallows datadog logs hosts', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  t.true(module.shouldSwallowHostBridgeUrl(new URL('https://http-intake.logs.us5.datadoghq.com/api/v2/logs')));
  t.false(module.shouldSwallowHostBridgeUrl(new URL('https://datadoghq.com/api/v2/logs')));
});

test('host rewrite overlay rewrites downloads host requests through the local bridge URL', async (t) => {
  const { module, restore } = await loadHostRewriteOverlayModule();
  t.teardown(restore);

  const nextUrl = module.rewriteFetchInput(
    'https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official/latest',
    'http://127.0.0.1:4318',
  );

  t.is(
    nextUrl?.toString(),
    'http://127.0.0.1:4318/proxy/downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official/latest',
  );
});
