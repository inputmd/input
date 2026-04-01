import test from 'ava';
import { JSDOM } from 'jsdom';
import { persistSidebarCollapsedFolders, readPersistedSidebarCollapsedFolders } from '../../src/sidebar_state.ts';

function withDom<T>(callback: () => T): T {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://input.test/doc' });
  const previousWindow = globalThis.window;

  Object.assign(globalThis, {
    window: dom.window,
  });

  try {
    return callback();
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
    });
    dom.window.close();
  }
}

test('sidebar collapsed folders persist per workspace', (t) => {
  withDom(() => {
    persistSidebarCollapsedFolders('gist:abc123', {
      docs: true,
      'docs/guides': true,
    });

    t.deepEqual(readPersistedSidebarCollapsedFolders('gist:abc123'), {
      docs: true,
      'docs/guides': true,
    });
    t.is(readPersistedSidebarCollapsedFolders('gist:missing'), null);
  });
});

test('sidebar collapsed folders preserve an explicit expand-all state', (t) => {
  withDom(() => {
    persistSidebarCollapsedFolders('repo:owner/name', {});

    t.deepEqual(readPersistedSidebarCollapsedFolders('repo:owner/name'), {});
  });
});
