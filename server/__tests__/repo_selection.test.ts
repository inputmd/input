import test from 'ava';
import {
  renameSelectedRepoFilePath,
  renameSelectedRepoFolderPath,
  shouldKeepRepoSelectionEmpty,
  withKeepRepoSelectionEmpty,
} from '../../src/repo_selection.ts';

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

test('withKeepRepoSelectionEmpty marks route state to preserve an empty repo selection', (t) => {
  const nextState = withKeepRepoSelectionEmpty({ restoreDraft: { documentDraftKey: 'draft-1' } });

  t.true(shouldKeepRepoSelectionEmpty(nextState));
  t.deepEqual(nextState, {
    restoreDraft: { documentDraftKey: 'draft-1' },
    keepRepoSelectionEmpty: true,
  });
  t.false(shouldKeepRepoSelectionEmpty(null));
});
