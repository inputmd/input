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
  t.deepEqual(
    docsFolder.children.map((child) => child.path),
    ['docs/.keep'],
  );
});

test('buildSidebarTree keeps .keep files visible and preserves active folder ancestry', (t) => {
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
    ['docs/.keep', 'docs/readme.md'],
  );
});

test('buildSidebarTree merges a folder with a same-name markdown sibling into one folder row', (t) => {
  const tree = buildSidebarTree([
    createSidebarFile('guides.md'),
    createSidebarFile('guides/getting-started.md'),
    createSidebarFile('notes.md'),
  ]);

  t.deepEqual(
    tree.children.map((child) => child.path),
    ['guides', 'notes.md'],
  );

  const guidesFolder = tree.children[0];
  t.truthy(guidesFolder);
  t.is(guidesFolder?.kind, 'folder');
  if (!guidesFolder || guidesFolder.kind !== 'folder') return;

  t.truthy(guidesFolder.combinedFile);
  t.is(guidesFolder.combinedFile?.path, 'guides.md');
  t.deepEqual(
    guidesFolder.children.map((child) => child.path),
    ['guides/getting-started.md'],
  );
});

test('buildSidebarTree does not merge non-markdown siblings', (t) => {
  const tree = buildSidebarTree([createSidebarFile('guides.txt'), createSidebarFile('guides/getting-started.md')]);

  t.deepEqual(
    tree.children.map((child) => child.path),
    ['guides', 'guides.txt'],
  );
});

test('buildSidebarTree treats a combined markdown file as active on the merged folder row', (t) => {
  const tree = buildSidebarTree([
    createSidebarFile('guides.md', { active: true }),
    createSidebarFile('guides/getting-started.md'),
  ]);

  const guidesFolder = tree.children[0];
  t.truthy(guidesFolder);
  t.is(guidesFolder?.kind, 'folder');
  if (!guidesFolder || guidesFolder.kind !== 'folder') return;

  t.true(guidesFolder.hasActiveDescendant);
  t.is(guidesFolder.combinedFile?.path, 'guides.md');
});

test('buildSidebarTree preserves descendant activity on a merged folder row', (t) => {
  const tree = buildSidebarTree([
    createSidebarFile('guides.md'),
    createSidebarFile('guides/getting-started.md', { active: true }),
  ]);

  const guidesFolder = tree.children[0];
  t.truthy(guidesFolder);
  t.is(guidesFolder?.kind, 'folder');
  if (!guidesFolder || guidesFolder.kind !== 'folder') return;

  t.true(guidesFolder.hasActiveDescendant);
  t.is(guidesFolder.combinedFile?.path, 'guides.md');
});

test('buildSidebarTree sorts merged folder rows with files instead of folders', (t) => {
  const tree = buildSidebarTree([
    createSidebarFile('zeta/overview.md'),
    createSidebarFile('guides.md'),
    createSidebarFile('guides/getting-started.md'),
    createSidebarFile('alpha.md'),
    createSidebarFile('notes.md'),
  ]);

  t.deepEqual(
    tree.children.map((child) => child.path),
    ['zeta', 'alpha.md', 'guides', 'notes.md'],
  );
});
