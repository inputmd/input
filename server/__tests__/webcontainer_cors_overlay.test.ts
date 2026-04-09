import https from 'node:https';
import test from 'ava';

async function loadCorsOverlayModule() {
  const originalHttpsRequest = https.request;
  const url = new URL('../../vendor/overlay/cors.mjs', import.meta.url);
  url.searchParams.set('test', `${Date.now()}-${Math.random()}`);
  const module = (await import(url.href)) as typeof import('../../vendor/overlay/cors.mjs');
  return {
    module,
    restore() {
      https.request = originalHttpsRequest;
    },
  };
}

test('cors overlay extracts header rules into declarative URL match config', async (t) => {
  const { module, restore } = await loadCorsOverlayModule();
  t.teardown(restore);

  t.deepEqual(module.REQUEST_HEADER_RULES, [
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
  ]);
});

test('cors overlay injects headers for https.request(url, callback)', async (t) => {
  const { module, restore } = await loadCorsOverlayModule();
  t.teardown(restore);

  const callback = () => {};
  const patchedArgs = module.buildPatchedHttpsRequestArgs(['https://api.anthropic.com/v1/messages', callback]);

  t.is(patchedArgs[0], 'https://api.anthropic.com/v1/messages');
  t.deepEqual(patchedArgs[1], {
    headers: {
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  t.is(patchedArgs[2], callback);
});

test('cors overlay injects headers for https.request(url, options) without mutating input options', async (t) => {
  const { module, restore } = await loadCorsOverlayModule();
  t.teardown(restore);

  const options = {
    headers: {
      authorization: 'Bearer test',
    },
    method: 'POST',
  };
  const patchedArgs = module.buildPatchedHttpsRequestArgs(['https://api.anthropic.com/v1/messages', options]);

  t.deepEqual(options, {
    headers: {
      authorization: 'Bearer test',
    },
    method: 'POST',
  });
  t.deepEqual(patchedArgs[1], {
    headers: {
      authorization: 'Bearer test',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    method: 'POST',
  });
  t.not(patchedArgs[1], options);
});

test('cors overlay injects headers for https.request(options) by hostname and pathname', async (t) => {
  const { module, restore } = await loadCorsOverlayModule();
  t.teardown(restore);

  const options = {
    headers: {
      authorization: 'Bearer test',
    },
    hostname: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
  };
  const patchedArgs = module.buildPatchedHttpsRequestArgs([options]);

  t.deepEqual(patchedArgs[0], {
    headers: {
      authorization: 'Bearer test',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    hostname: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
  });
  t.not(patchedArgs[0], options);
});

test('cors overlay leaves unrelated requests unchanged', async (t) => {
  const { module, restore } = await loadCorsOverlayModule();
  t.teardown(restore);

  const options = { hostname: 'example.com', path: '/v1/messages' };
  const patchedArgs = module.buildPatchedHttpsRequestArgs([options]);

  t.is(patchedArgs[0], options);
  t.is(module.resolveHttpsRequestHeaderOverrides(new URL('https://example.com/v1/messages')), null);
});
