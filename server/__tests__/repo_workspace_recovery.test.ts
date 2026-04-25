import test from 'ava';
import {
  buildRepoWorkspaceRecoverySnapshot,
  validateRepoWorkspaceRecoverySnapshot,
} from '../../src/repo_workspace/recovery.ts';
import type {
  RepoWorkspaceDeletedFile,
  RepoWorkspaceOverlayFile,
  RepoWorkspaceRenamedFile,
} from '../../src/repo_workspace/types.ts';

const baseFiles = [
  { name: 'a.md', path: 'docs/a.md', sha: 'sha-a', size: 6 },
  { name: 'b.md', path: 'docs/b.md', sha: 'sha-b', size: 6 },
];

function findBaseFile(path: string) {
  return baseFiles.find((file) => file.path === path);
}

test('repo workspace recovery restores when base shas still match', (t) => {
  const snapshot = buildRepoWorkspaceRecoverySnapshot({
    workspaceKey: 'repo:owner/name',
    backend: 'repo',
    overlayFiles: [{ path: 'docs/a.md', content: 'changed', source: 'terminal' }],
    deletedBaseFiles: [],
    renamedBaseFiles: [],
    findBaseFile,
    resolveBasePath: (path) => path,
    baseFileContents: {},
    now: 123,
  });

  t.truthy(snapshot);
  t.true(
    validateRepoWorkspaceRecoverySnapshot({
      snapshot: snapshot!,
      findBaseFile,
      baseFileContents: {},
    }),
  );
});

test('repo workspace recovery keeps a confirmed hard-leave snapshot restorable after in-memory discard', (t) => {
  const stagedChanges = {
    overlayFiles: [{ path: 'docs/a.md', content: 'changed', source: 'terminal' }] as RepoWorkspaceOverlayFile[],
    deletedBaseFiles: [{ path: 'docs/b.md', source: 'terminal' }] as RepoWorkspaceDeletedFile[],
    renamedBaseFiles: [] as RepoWorkspaceRenamedFile[],
  };
  const snapshot = buildRepoWorkspaceRecoverySnapshot({
    workspaceKey: 'repo:owner/name',
    backend: 'repo',
    ...stagedChanges,
    findBaseFile,
    resolveBasePath: (path) => path,
    baseFileContents: {},
  });

  t.truthy(snapshot);
  const discardedInMemoryChanges = { overlayFiles: [], deletedBaseFiles: [], renamedBaseFiles: [] };
  t.deepEqual(discardedInMemoryChanges.overlayFiles, []);
  t.true(validateRepoWorkspaceRecoverySnapshot({ snapshot: snapshot!, findBaseFile, baseFileContents: {} }));
  t.deepEqual(snapshot!.overlayFiles, stagedChanges.overlayFiles);
  t.deepEqual(snapshot!.deletedBaseFiles, stagedChanges.deletedBaseFiles);
});

test('repo workspace recovery rejects edited files when base sha changes', (t) => {
  const snapshot = buildRepoWorkspaceRecoverySnapshot({
    workspaceKey: 'repo:owner/name',
    backend: 'repo',
    overlayFiles: [{ path: 'docs/a.md', content: 'changed', source: 'terminal' }],
    deletedBaseFiles: [],
    renamedBaseFiles: [],
    findBaseFile,
    resolveBasePath: (path) => path,
    baseFileContents: {},
  });

  t.truthy(snapshot);
  t.false(
    validateRepoWorkspaceRecoverySnapshot({
      snapshot: snapshot!,
      findBaseFile: (path) => (path === 'docs/a.md' ? { name: 'a.md', path, sha: 'sha-new', size: 6 } : undefined),
      baseFileContents: {},
    }),
  );
});

test('repo workspace recovery rejects new files when destination appears', (t) => {
  const snapshot = buildRepoWorkspaceRecoverySnapshot({
    workspaceKey: 'repo:owner/name',
    backend: 'repo',
    overlayFiles: [{ path: 'docs/new.md', content: 'new', source: 'terminal' }],
    deletedBaseFiles: [],
    renamedBaseFiles: [],
    findBaseFile,
    resolveBasePath: () => null,
    baseFileContents: {},
  });

  t.truthy(snapshot);
  t.false(
    validateRepoWorkspaceRecoverySnapshot({
      snapshot: snapshot!,
      findBaseFile: (path) => (path === 'docs/new.md' ? { name: 'new.md', path, sha: 'sha-new', size: 3 } : undefined),
      baseFileContents: {},
    }),
  );
});

test('repo workspace recovery checks rename source and destination', (t) => {
  const renamedBaseFiles: RepoWorkspaceRenamedFile[] = [
    { from: 'docs/a.md', to: 'docs/renamed.md', source: 'terminal' },
  ];
  const snapshot = buildRepoWorkspaceRecoverySnapshot({
    workspaceKey: 'repo:owner/name',
    backend: 'repo',
    overlayFiles: [],
    deletedBaseFiles: [],
    renamedBaseFiles,
    findBaseFile,
    resolveBasePath: (path) => path,
    baseFileContents: {},
  });

  t.truthy(snapshot);
  t.true(validateRepoWorkspaceRecoverySnapshot({ snapshot: snapshot!, findBaseFile, baseFileContents: {} }));
  t.false(
    validateRepoWorkspaceRecoverySnapshot({
      snapshot: snapshot!,
      findBaseFile: (path) =>
        path === 'docs/renamed.md' ? { name: 'renamed.md', path, sha: 'sha-dest', size: 1 } : findBaseFile(path),
      baseFileContents: {},
    }),
  );
});

test('gist workspace recovery uses content hashes for existing files', (t) => {
  const overlayFiles: RepoWorkspaceOverlayFile[] = [{ path: 'notes.md', content: 'after', source: 'terminal' }];
  const snapshot = buildRepoWorkspaceRecoverySnapshot({
    workspaceKey: 'gist:abc',
    backend: 'gist',
    overlayFiles,
    deletedBaseFiles: [],
    renamedBaseFiles: [],
    findBaseFile: (path) => (path === 'notes.md' ? { name: 'notes.md', path, sha: '', size: 6 } : undefined),
    resolveBasePath: (path) => path,
    baseFileContents: { 'notes.md': 'before' },
  });

  t.truthy(snapshot);
  t.true(
    validateRepoWorkspaceRecoverySnapshot({
      snapshot: snapshot!,
      findBaseFile: (path) => (path === 'notes.md' ? { name: 'notes.md', path, sha: '', size: 6 } : undefined),
      baseFileContents: { 'notes.md': 'before' },
    }),
  );
  t.false(
    validateRepoWorkspaceRecoverySnapshot({
      snapshot: snapshot!,
      findBaseFile: (path) => (path === 'notes.md' ? { name: 'notes.md', path, sha: '', size: 7 } : undefined),
      baseFileContents: { 'notes.md': 'changed' },
    }),
  );
});

test('repo workspace recovery refuses snapshots with unknown existing base fingerprints', (t) => {
  const deletedBaseFiles: RepoWorkspaceDeletedFile[] = [{ path: 'docs/a.md', source: 'terminal' }];
  const snapshot = buildRepoWorkspaceRecoverySnapshot({
    workspaceKey: 'repo:owner/name',
    backend: 'repo',
    overlayFiles: [],
    deletedBaseFiles,
    renamedBaseFiles: [],
    findBaseFile: (path) => (path === 'docs/a.md' ? { name: 'a.md', path, sha: '', size: 6 } : undefined),
    resolveBasePath: (path) => path,
    baseFileContents: {},
  });

  t.is(snapshot, null);
});
