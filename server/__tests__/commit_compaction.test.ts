import test from 'ava';
import { resolveCommitCompactionSelection } from '../commit_compaction.ts';

const commits = [
  { sha: 'head', parents: ['c2'] },
  { sha: 'c2', parents: ['c1'] },
  { sha: 'c1', parents: ['base'] },
  { sha: 'base', parents: ['root'] },
];

test('resolveCommitCompactionSelection accepts a contiguous HEAD prefix', (t) => {
  const result = resolveCommitCompactionSelection(commits, ['head', 'c2', 'c1']);

  t.deepEqual(result, {
    baseParentSha: 'base',
    headSha: 'head',
    selectedCount: 3,
    selectedShas: ['head', 'c2', 'c1'],
  });
});

test('resolveCommitCompactionSelection rejects selections that do not include HEAD', (t) => {
  const error = t.throws(() => resolveCommitCompactionSelection(commits, ['c2', 'c1']));

  t.is(error?.message, 'Compaction must include the current HEAD commit');
});

test('resolveCommitCompactionSelection rejects non-contiguous selections', (t) => {
  const error = t.throws(() => resolveCommitCompactionSelection(commits, ['head', 'c1']));

  t.is(error?.message, 'Selected commits must form a contiguous range from HEAD');
});

test('resolveCommitCompactionSelection rejects merge commits', (t) => {
  const error = t.throws(() =>
    resolveCommitCompactionSelection(
      [
        { sha: 'head', parents: ['merge'] },
        { sha: 'merge', parents: ['left', 'right'] },
        { sha: 'base', parents: ['root'] },
      ],
      ['head', 'merge'],
    ),
  );

  t.is(error?.message, 'Merge commits and root commits cannot be compacted');
});
