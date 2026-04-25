import test from 'ava';
import { countRepoWorkspaceSidebarFiles, filterRepoWorkspaceSidebarFiles } from '../../src/repo_workspace/helpers.ts';
import {
  isWorkspaceTransition,
  workspaceKeyFromRoute,
  workspaceKeysMatch,
} from '../../src/repo_workspace/workspace_transition.ts';

interface TestSidebarFile {
  path: string;
  active: boolean;
  editable: boolean;
  deemphasized: boolean;
}

function createSidebarFile(path: string): TestSidebarFile {
  return {
    path,
    active: false,
    editable: true,
    deemphasized: false,
  };
}

const sidebarFiles = [
  createSidebarFile('notes.md'),
  createSidebarFile('scripts/app.ts'),
  createSidebarFile('.env'),
  createSidebarFile('.keep'),
  createSidebarFile('.config/hidden.md'),
];

test('filterRepoWorkspaceSidebarFiles hides hidden files and folders by default', (t) => {
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(sidebarFiles, 'all').map((file) => file.path),
    ['notes.md', 'scripts/app.ts'],
  );
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(sidebarFiles, 'text').map((file) => file.path),
    ['notes.md', 'scripts/app.ts'],
  );
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(sidebarFiles, 'markdown').map((file) => file.path),
    ['notes.md'],
  );
});

test('filterRepoWorkspaceSidebarFiles shows hidden files and folders when enabled', (t) => {
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(sidebarFiles, 'all', true).map((file) => file.path),
    ['notes.md', 'scripts/app.ts', '.env', '.keep', '.config/hidden.md'],
  );
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(sidebarFiles, 'text', true).map((file) => file.path),
    ['notes.md', 'scripts/app.ts', '.keep', '.config/hidden.md'],
  );
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(sidebarFiles, 'markdown', true).map((file) => file.path),
    ['notes.md', '.config/hidden.md'],
  );
});

test('filterRepoWorkspaceSidebarFiles always shows input workspace files', (t) => {
  const files = [
    createSidebarFile('notes.md'),
    createSidebarFile('.input/.pi/agent/sessions/example.jsonl'),
    createSidebarFile('.input/.claude/sessions/example.json'),
    createSidebarFile('.config/hidden.md'),
  ];

  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(files, 'all').map((file) => file.path),
    ['notes.md', '.input/.pi/agent/sessions/example.jsonl', '.input/.claude/sessions/example.json'],
  );
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(files, 'text').map((file) => file.path),
    ['notes.md', '.input/.pi/agent/sessions/example.jsonl', '.input/.claude/sessions/example.json'],
  );
  t.deepEqual(
    filterRepoWorkspaceSidebarFiles(files, 'markdown').map((file) => file.path),
    ['notes.md', '.input/.pi/agent/sessions/example.jsonl', '.input/.claude/sessions/example.json'],
  );
  t.deepEqual(countRepoWorkspaceSidebarFiles(files), {
    markdown: 1,
    text: 3,
    total: 3,
  });
});

test('countRepoWorkspaceSidebarFiles tracks hidden visibility and includes .keep in text counts', (t) => {
  t.deepEqual(countRepoWorkspaceSidebarFiles(sidebarFiles), {
    markdown: 1,
    text: 2,
    total: 2,
  });
  t.deepEqual(countRepoWorkspaceSidebarFiles(sidebarFiles, true), {
    markdown: 2,
    text: 4,
    total: 5,
  });
});

test('workspaceKeyFromRoute groups files and edit routes by workspace', (t) => {
  t.is(
    workspaceKeyFromRoute({
      name: 'repofile',
      params: { owner: 'Owner', repo: 'Repo', path: 'README.md' },
    }),
    'repo:Owner/Repo',
  );
  t.is(
    workspaceKeyFromRoute({
      name: 'repoedit',
      params: { owner: 'Owner', repo: 'Repo', path: 'README.md' },
    }),
    'repo:Owner/Repo',
  );
  t.is(
    workspaceKeyFromRoute({
      name: 'gist',
      params: { id: 'abc123ef', filename: 'README.md' },
    }),
    'gist:abc123ef',
  );
  t.is(workspaceKeyFromRoute({ name: 'workspaces', params: {} }), 'workspace:none');
});

test('workspace transition detection ignores casing for repo-like keys', (t) => {
  t.true(workspaceKeysMatch('repo:Owner/Repo', 'repo:owner/repo'));
  t.false(isWorkspaceTransition('repo:Owner/Repo', 'repo:owner/repo'));
  t.true(isWorkspaceTransition('repo:owner/repo', 'gist:abc123ef'));
  t.true(isWorkspaceTransition('gist:abc123ef', 'workspace:none'));
});
