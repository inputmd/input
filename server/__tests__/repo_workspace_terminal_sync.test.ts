import test from 'ava';
import {
  applyTerminalImportDiffToWorkspaceChanges,
  buildTerminalImportDiff,
  shouldImportTerminalPath,
} from '../../src/repo_workspace/terminal_sync.ts';

test('shouldImportTerminalPath skips common generated directories', (t) => {
  t.false(shouldImportTerminalPath('node_modules/react/index.js'));
  t.false(shouldImportTerminalPath('.git/config'));
  t.false(shouldImportTerminalPath('dist/app.js'));
  t.false(shouldImportTerminalPath('.input-home-overlay-provision.cjs'));
  t.false(shouldImportTerminalPath('.input-home-overlay.tar'));
  t.false(shouldImportTerminalPath('.input-persisted-home-sync.cjs'));
  t.false(shouldImportTerminalPath('.input-persisted-home-seed.json'));
  t.false(shouldImportTerminalPath('.input-webcontainer-home-overlay.json'));
  t.true(shouldImportTerminalPath('src/app.tsx'));
  t.true(shouldImportTerminalPath('.github/workflows/ci.yml'));
});

test('buildTerminalImportDiff returns changed created and deleted files', (t) => {
  const diff = buildTerminalImportDiff({
    managedFiles: {
      'src/app.tsx': 'before',
      'src/old.ts': 'old',
    },
    actualFiles: {
      'src/app.tsx': 'after',
      'src/new.ts': 'new',
    },
  });

  t.deepEqual(diff, {
    upserts: {
      'src/app.tsx': 'after',
      'src/new.ts': 'new',
    },
    deletes: ['src/old.ts'],
  });
});

test('buildTerminalImportDiff ignores the active editor path', (t) => {
  const diff = buildTerminalImportDiff({
    managedFiles: {
      'src/app.tsx': 'editor',
      'src/keep.ts': 'same',
    },
    actualFiles: {
      'src/app.tsx': 'terminal',
      'src/keep.ts': 'same',
    },
    activeEditPath: 'src/app.tsx',
  });

  t.deepEqual(diff, {
    upserts: {},
    deletes: [],
  });
});

test('buildTerminalImportDiff can include the active editor path when requested', (t) => {
  const diff = buildTerminalImportDiff({
    managedFiles: {
      'src/app.tsx': 'editor',
      'src/keep.ts': 'same',
    },
    actualFiles: {
      'src/app.tsx': 'terminal',
      'src/keep.ts': 'same',
    },
    activeEditPath: 'src/app.tsx',
    includeActiveEditPath: true,
  });

  t.deepEqual(diff, {
    upserts: {
      'src/app.tsx': 'terminal',
    },
    deletes: [],
  });
});

test('applyTerminalImportDiffToWorkspaceChanges stages terminal upserts and clears base deletes', (t) => {
  const imported = applyTerminalImportDiffToWorkspaceChanges({
    overlayFiles: [],
    deletedBaseFiles: [{ path: 'src/app.tsx', source: 'sidebar' }],
    renamedBaseFiles: [],
    diff: {
      upserts: {
        'src/app.tsx': 'terminal',
      },
      deletes: [],
    },
    resolveRepoBasePath: (path) => (path === 'src/app.tsx' ? path : null),
  });

  t.deepEqual(imported.overlayFiles, [{ path: 'src/app.tsx', content: 'terminal', source: 'terminal' }]);
  t.deepEqual(imported.deletedBaseFiles, []);
  t.deepEqual(imported.renamedBaseFiles, []);
  t.is(imported.importedCount, 1);
});

test('applyTerminalImportDiffToWorkspaceChanges converts deleted renamed targets into base deletes', (t) => {
  const imported = applyTerminalImportDiffToWorkspaceChanges({
    overlayFiles: [{ path: 'docs/renamed.md', content: 'draft', source: 'editor' }],
    deletedBaseFiles: [],
    renamedBaseFiles: [{ from: 'docs/base.md', to: 'docs/renamed.md', source: 'sidebar' }],
    diff: {
      upserts: {},
      deletes: ['docs/renamed.md'],
    },
    resolveRepoBasePath: (path) => (path === 'docs/renamed.md' ? 'docs/base.md' : null),
  });

  t.deepEqual(imported.overlayFiles, []);
  t.deepEqual(imported.deletedBaseFiles, [{ path: 'docs/base.md', source: 'terminal' }]);
  t.deepEqual(imported.renamedBaseFiles, []);
  t.is(imported.importedCount, 1);
});
