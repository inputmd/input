import test from 'ava';
import { renameSelectedRepoFilePath, renameSelectedRepoFolderPath } from '../../src/repo_selection.ts';

test('renameSelectedRepoFilePath updates the selected file when it is renamed', (t) => {
  t.is(renameSelectedRepoFilePath('docs/a.md', 'docs/a.md', 'docs/b.md'), 'docs/b.md');
  t.is(renameSelectedRepoFilePath('docs/other.md', 'docs/a.md', 'docs/b.md'), 'docs/other.md');
  t.is(renameSelectedRepoFilePath(null, 'docs/a.md', 'docs/b.md'), null);
});

test('renameSelectedRepoFolderPath updates selected descendants when a folder is renamed', (t) => {
  t.is(renameSelectedRepoFolderPath('docs/guides/a.md', 'docs', 'handbook'), 'handbook/guides/a.md');
  t.is(renameSelectedRepoFolderPath('notes/a.md', 'docs', 'handbook'), 'notes/a.md');
  t.is(renameSelectedRepoFolderPath(null, 'docs', 'handbook'), null);
});
