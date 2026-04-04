import test from 'ava';
import {
  buildUnifiedDiffFromHunk,
  findUnifiedDiffReplacementPair,
  getUnifiedDiffLineParts,
} from '../../src/components/diff_viewer_utils.ts';

test('findUnifiedDiffReplacementPair matches adjacent delete/add replacements', (t) => {
  const lines = ['@@ -1,1 +1,1 @@', '-before', '+after'];

  t.is(findUnifiedDiffReplacementPair(lines, 1), 2);
});

test('findUnifiedDiffReplacementPair collapses delete plus blank-context plus empty-add pattern', (t) => {
  const lines = ['@@ -1,2 +1,2 @@', '-removed line', ' ', '+'];

  t.is(findUnifiedDiffReplacementPair(lines, 1), 3);
});

test('findUnifiedDiffReplacementPair ignores plain deletions', (t) => {
  const lines = ['@@ -1,1 +0,0 @@', '-removed line'];

  t.is(findUnifiedDiffReplacementPair(lines, 1), null);
});

test('getUnifiedDiffLineParts splits the sign column from added content', (t) => {
  t.deepEqual(getUnifiedDiffLineParts('+added line'), {
    content: 'added line',
    hasSignColumn: true,
    sign: '+',
  });
});

test('getUnifiedDiffLineParts preserves intentional leading spaces in diff content', (t) => {
  t.deepEqual(getUnifiedDiffLineParts('+ added line'), {
    content: ' added line',
    hasSignColumn: true,
    sign: '+',
  });
});

test('buildUnifiedDiffFromHunk serializes a review hunk without file headers', (t) => {
  t.is(
    buildUnifiedDiffFromHunk({
      id: 'hunk:1',
      header: '@@ -2,2 +2,3 @@',
      oldStart: 2,
      oldLines: 2,
      newStart: 2,
      newLines: 3,
      lines: [
        { type: 'context', content: 'before' },
        { type: 'del', content: 'old value' },
        { type: 'add', content: 'new value' },
        { type: 'add', content: 'extra value' },
      ],
    }),
    '@@ -2,2 +2,3 @@\n before\n-old value\n+new value\n+extra value',
  );
});
