import test from 'ava';
import { countRepoWorkspaceSidebarFiles, filterRepoWorkspaceSidebarFiles } from '../../src/repo_workspace/helpers.ts';

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
