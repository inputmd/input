import test from 'ava';
import { JSDOM } from 'jsdom';
import {
  loadSidebarCollapsedFoldersState,
  persistSidebarCollapsedFolders,
  readPersistedSidebarCollapsedFolders,
} from '../../src/sidebar_state.ts';

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

test('sidebar collapsed folders read legacy object-shaped localStorage entries', (t) => {
  withDom(() => {
    window.localStorage.setItem(
      'sidebar_collapsed_folders_v1:repo:owner/name',
      JSON.stringify({
        docs: true,
        'docs/guides': true,
        src: false,
      }),
    );

    t.deepEqual(readPersistedSidebarCollapsedFolders('repo:owner/name'), {
      docs: true,
      'docs/guides': true,
    });
  });
});

test('sidebar collapsed folders preserve an explicit expand-all state', (t) => {
  withDom(() => {
    persistSidebarCollapsedFolders('repo:owner/name', {});

    t.deepEqual(readPersistedSidebarCollapsedFolders('repo:owner/name'), {});
  });
});

test('sidebar collapsed folders state prefers persisted values over active ancestor expansion', (t) => {
  withDom(() => {
    persistSidebarCollapsedFolders('repo:owner/name', {
      docs: true,
      src: true,
    });

    t.deepEqual(loadSidebarCollapsedFoldersState('repo:owner/name', new Set(['docs', 'src']), ['docs']), {
      collapsedFolders: {
        docs: true,
        src: true,
      },
      loadedFromPersistence: true,
    });
  });
});
