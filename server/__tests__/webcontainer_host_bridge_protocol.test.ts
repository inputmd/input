import test from 'ava';
import {
  encodeHostBridgeFrame,
  type HostBridgeRequestStartFrame,
  parseHostBridgeFrame,
} from '../../src/webcontainer_host_bridge_protocol.ts';

test('host bridge protocol encodes and decodes newline-delimited frames', (t) => {
  const frame: HostBridgeRequestStartFrame = {
    headers: { authorization: 'Bearer test' },
    method: 'POST',
    path: '/v1/messages',
    requestId: '123',
    targetHost: 'api.anthropic.com',
    type: 'request-start',
  };

  const encoded = encodeHostBridgeFrame(frame);

  t.true(encoded.endsWith('\n'));
  t.deepEqual(parseHostBridgeFrame(encoded.trim()), frame);
});

test('host bridge protocol ignores malformed lines', (t) => {
  t.is(parseHostBridgeFrame('not-json'), null);
  t.is(parseHostBridgeFrame('{"missingType":true}'), null);
});
