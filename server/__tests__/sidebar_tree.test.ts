import test from 'ava';
import { buildSidebarTree } from '../../src/sidebar_tree.ts';

interface TestSidebarFile {
  path: string;
  active: boolean;
  editable: boolean;
  deemphasized: boolean;
}

function createSidebarFile(path: string, options?: Partial<TestSidebarFile>): TestSidebarFile {
  return {
    path,
    active: false,
    editable: true,
    deemphasized: false,
    ...options,
  };
}

test('buildSidebarTree keeps folders backed only by .keep entries', (t) => {
  const tree = buildSidebarTree([createSidebarFile('docs/.keep')]);
  const docsFolder = tree.children[0];

  t.truthy(docsFolder);
  t.is(docsFolder?.kind, 'folder');
  if (!docsFolder || docsFolder.kind !== 'folder') return;

  t.is(docsFolder.path, 'docs');
  t.deepEqual(docsFolder.children, []);
});

test('buildSidebarTree hides .keep files but preserves active folder ancestry', (t) => {
  const tree = buildSidebarTree([
    createSidebarFile('docs/.keep', { active: true }),
    createSidebarFile('docs/readme.md'),
  ]);
  const docsFolder = tree.children[0];

  t.truthy(docsFolder);
  t.is(docsFolder?.kind, 'folder');
  if (!docsFolder || docsFolder.kind !== 'folder') return;

  t.true(docsFolder.hasActiveDescendant);
  t.deepEqual(
    docsFolder.children.map((child) => child.path),
    ['docs/readme.md'],
  );
});
