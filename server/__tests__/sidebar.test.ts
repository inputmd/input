import test from 'ava';
import { JSDOM } from 'jsdom';
import { resolveSidebarFocusedPath } from '../../src/sidebar_focus.ts';
import {
  resolveSidebarFolderRowBehavior,
  resolveSidebarFolderRowClickAction,
  resolveSidebarFolderRowLabel,
} from '../../src/sidebar_row_behavior.ts';
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

test('resolveSidebarFocusedPath remaps a missing combined markdown focus target to its folder row', (t) => {
  const visibleNodes = [
    {
      kind: 'folder' as const,
      path: 'guides',
      parentPath: null,
      depth: 0,
      hasChildren: true,
      collapsed: false,
    },
    {
      kind: 'file' as const,
      path: 'notes.md',
      parentPath: null,
      depth: 0,
      hasChildren: false,
      collapsed: false,
    },
  ];

  t.is(resolveSidebarFocusedPath('guides.md', null, visibleNodes), 'guides');
});

test('resolveSidebarFocusedPath keeps a visible combined markdown alias focused', (t) => {
  const visibleNodes = [
    {
      kind: 'folder' as const,
      path: 'guides',
      parentPath: null,
      depth: 0,
      hasChildren: true,
      collapsed: false,
      combinedFilePath: 'guides.md',
    },
  ];

  t.is(resolveSidebarFocusedPath('guides.md', null, visibleNodes), 'guides.md');
});

test('resolveSidebarFolderRowClickAction selects the markdown file and expands the folder when it was not focused', (t) => {
  t.deepEqual(
    resolveSidebarFolderRowClickAction({
      folderPath: 'guides',
      combinedFilePath: 'guides.md',
      combinedFileVirtual: false,
      combinedFileFocused: false,
    }),
    { type: 'select-file', path: 'guides.md', expandFolderPath: 'guides' },
  );
});

test('resolveSidebarFolderRowBehavior keeps the caret toggle routed to the folder', (t) => {
  t.deepEqual(
    resolveSidebarFolderRowBehavior({
      folderPath: 'guides',
      combinedFilePath: 'guides.md',
      combinedFileVirtual: false,
      readOnly: false,
      isRenaming: false,
      isRenamePending: false,
      isMoving: false,
    }).caretAction,
    { type: 'toggle-folder', path: 'guides' },
  );
});

test('resolveSidebarFolderRowClickAction toggles the folder when the merged file was already focused', (t) => {
  t.deepEqual(
    resolveSidebarFolderRowClickAction({
      folderPath: 'guides',
      combinedFilePath: 'guides.md',
      combinedFileVirtual: false,
      combinedFileFocused: true,
    }),
    { type: 'toggle-folder', path: 'guides' },
  );
});

test('resolveSidebarFolderRowClickAction keeps virtual merged rows as folder toggles', (t) => {
  t.deepEqual(
    resolveSidebarFolderRowClickAction({
      folderPath: 'guides',
      combinedFilePath: 'guides.md',
      combinedFileVirtual: true,
      combinedFileFocused: false,
    }),
    { type: 'toggle-folder', path: 'guides' },
  );
});

test('resolveSidebarFolderRowBehavior routes rename delete and view targets to the markdown file', (t) => {
  const behavior = resolveSidebarFolderRowBehavior({
    folderPath: 'guides',
    combinedFilePath: 'guides.md',
    combinedFileVirtual: false,
    readOnly: false,
    isRenaming: false,
    isRenamePending: false,
    isMoving: false,
  });

  t.deepEqual(behavior.renameTarget, { kind: 'file', path: 'guides.md' });
  t.deepEqual(behavior.deleteTarget, { kind: 'file', path: 'guides.md' });
  t.deepEqual(behavior.viewTarget, { kind: 'file', path: 'guides.md' });
});

test('resolveSidebarFolderRowBehavior keeps create and drop targets on the folder', (t) => {
  const behavior = resolveSidebarFolderRowBehavior({
    folderPath: 'guides',
    combinedFilePath: 'guides.md',
    combinedFileVirtual: false,
    readOnly: false,
    isRenaming: false,
    isRenamePending: false,
    isMoving: false,
  });

  t.is(behavior.createParentPath, 'guides');
  t.is(behavior.dropTargetFolderPath, 'guides');
});

test('resolveSidebarFolderRowLabel uses the markdown filename for merged rows', (t) => {
  t.is(resolveSidebarFolderRowLabel('guides', 'guides.md'), 'guides.md');
  t.is(resolveSidebarFolderRowLabel('guides', null), 'guides');
});
