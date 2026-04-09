import test from 'ava';
import type { RepoDocFile } from '../../src/document_store.ts';
import { buildRepoWorkspaceTextSavePlan } from '../../src/repo_workspace/commit.ts';
import {
  applyRepoWorkspaceMutationsToDocFiles,
  applyRepoWorkspaceMutationsToTerminalFiles,
  findRepoRenamedBaseSourcePath,
} from '../../src/repo_workspace/helpers.ts';

const baseFiles: RepoDocFile[] = [
  { name: 'a.md', path: 'docs/a.md', sha: 'sha-a', size: 5 },
  { name: 'b.md', path: 'docs/b.md', sha: 'sha-b', size: 7 },
];

function findBaseRepoSidebarFile(path: string): RepoDocFile | undefined {
  return baseFiles.find((file) => file.path === path);
}

function resolveRepoBasePath(path: string): string | null {
  if (findBaseRepoSidebarFile(path)) return path;
  if (path === 'docs/renamed.md') return 'docs/a.md';
  return null;
}

test('buildRepoWorkspaceTextSavePlan updates modified base files', (t) => {
  const plan = buildRepoWorkspaceTextSavePlan({
    overlayFiles: [{ path: 'docs/a.md', content: 'updated', source: 'editor' }],
    deletedBaseFiles: [],
    renamedBaseFiles: [],
    findBaseRepoSidebarFile,
    resolveRepoBasePath,
  });

  t.deepEqual(plan.mutation, {
    message: 'Update docs/a.md',
    updates: [{ path: 'docs/a.md', content: 'updated', expectedSha: 'sha-a' }],
  });
  t.is(plan.changeCount, 1);
});

test('buildRepoWorkspaceTextSavePlan keeps pure base renames as renames', (t) => {
  const plan = buildRepoWorkspaceTextSavePlan({
    overlayFiles: [],
    deletedBaseFiles: [],
    renamedBaseFiles: [{ from: 'docs/a.md', to: 'docs/renamed.md', source: 'sidebar' }],
    findBaseRepoSidebarFile,
    resolveRepoBasePath,
  });

  t.deepEqual(plan.mutation, {
    message: 'Rename docs/a.md to docs/renamed.md',
    renames: [{ from: 'docs/a.md', to: 'docs/renamed.md' }],
  });
  t.is(plan.changeCount, 1);
});

test('buildRepoWorkspaceTextSavePlan keeps pure base deletes as deletes', (t) => {
  const plan = buildRepoWorkspaceTextSavePlan({
    overlayFiles: [],
    deletedBaseFiles: [{ path: 'docs/b.md', source: 'sidebar' }],
    renamedBaseFiles: [],
    findBaseRepoSidebarFile,
    resolveRepoBasePath,
  });

  t.deepEqual(plan.mutation, {
    message: 'Delete docs/b.md',
    deletes: ['docs/b.md'],
  });
  t.is(plan.changeCount, 1);
});

test('buildRepoWorkspaceTextSavePlan degrades rename plus edit into delete plus create', (t) => {
  const plan = buildRepoWorkspaceTextSavePlan({
    overlayFiles: [{ path: 'docs/renamed.md', content: 'changed', source: 'editor' }],
    deletedBaseFiles: [],
    renamedBaseFiles: [{ from: 'docs/a.md', to: 'docs/renamed.md', source: 'sidebar' }],
    findBaseRepoSidebarFile,
    resolveRepoBasePath,
  });

  t.deepEqual(plan.mutation, {
    message: 'Apply 2 workspace changes',
    deletes: ['docs/a.md'],
    creates: [{ path: 'docs/renamed.md', content: 'changed' }],
  });
  t.is(plan.changeCount, 2);
  t.deepEqual(plan.touchedFiles, [{ path: 'docs/renamed.md', content: 'changed' }]);
});

test('applyRepoWorkspaceMutationsToDocFiles projects deletes renames and overlay content', (t) => {
  const projectedFiles = applyRepoWorkspaceMutationsToDocFiles(baseFiles, {
    overlayFiles: [{ path: 'docs/renamed.md', content: 'changed', source: 'editor' }],
    deletedBaseFiles: [{ path: 'docs/b.md', source: 'sidebar' }],
    renamedBaseFiles: [{ from: 'docs/a.md', to: 'docs/renamed.md', source: 'sidebar' }],
  });

  t.deepEqual(projectedFiles, [{ name: 'renamed.md', path: 'docs/renamed.md', sha: 'sha-a', size: 7 }]);
});

test('applyRepoWorkspaceMutationsToTerminalFiles projects delete rename and overlay content', (t) => {
  const projectedFiles = applyRepoWorkspaceMutationsToTerminalFiles(
    {
      'docs/a.md': 'base-a',
      'docs/b.md': 'base-b',
    },
    {
      overlayFiles: [
        { path: 'docs/renamed.md', content: 'edited-a' },
        { path: 'docs/new.md', content: 'new-file' },
      ],
      deletedBaseFiles: [{ path: 'docs/b.md', source: 'sidebar' }],
      renamedBaseFiles: [{ from: 'docs/a.md', to: 'docs/renamed.md', source: 'sidebar' }],
    },
  );

  t.deepEqual(projectedFiles, {
    'docs/new.md': 'new-file',
    'docs/renamed.md': 'edited-a',
  });
});

test('findRepoRenamedBaseSourcePath returns the base source for a renamed path', (t) => {
  t.is(findRepoRenamedBaseSourcePath([{ from: 'docs/a.md', to: 'docs/renamed.md' }], 'docs/renamed.md'), 'docs/a.md');
  t.is(findRepoRenamedBaseSourcePath([{ from: 'docs/a.md', to: 'docs/renamed.md' }], 'docs/missing.md'), null);
});
