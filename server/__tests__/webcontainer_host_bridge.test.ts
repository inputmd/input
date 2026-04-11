import test from 'ava';
import { buildWebContainerSpawnEnv } from '../../src/webcontainer_host_bridge.ts';

test('buildWebContainerSpawnEnv prefixes the overlay bin directory', (t) => {
  t.deepEqual(buildWebContainerSpawnEnv('/home/project', '/usr/bin:/bin'), {
    INPUT_HOST_BRIDGE_URL: 'http://127.0.0.1:4318',
    NODE_OPTIONS: '--require=/home/project/host_rewrite.mjs',
    PATH: '/home/project/.local/bin:/usr/bin:/bin',
  });
});

test('buildWebContainerSpawnEnv does not duplicate the overlay bin directory', (t) => {
  t.deepEqual(buildWebContainerSpawnEnv('/home/project/', '/home/project/.local/bin:/usr/bin:/bin'), {
    INPUT_HOST_BRIDGE_URL: 'http://127.0.0.1:4318',
    NODE_OPTIONS: '--require=/home/project/host_rewrite.mjs',
    PATH: '/home/project/.local/bin:/usr/bin:/bin',
  });
});
