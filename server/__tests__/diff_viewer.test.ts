import test from 'ava';
import {
  buildUnifiedDiffFromHunk,
  findUnifiedDiffReplacementPair,
  getUnifiedDiffLineParts,
  limitUnifiedDiffContextLines,
  prepareUnifiedDiffLines,
  stripUnifiedDiffHunkHeaders,
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

test('limitUnifiedDiffContextLines truncates a long closest leading context line and drops farther leading context', (t) => {
  const longLeading = `before ${'x'.repeat(140)}`;
  const diffLines = ['@@ -1,4 +1,4 @@', ' older context', ` ${longLeading}`, '-before', '+after', ' tail'].join('\n');

  t.deepEqual(limitUnifiedDiffContextLines(diffLines.split('\n')), [
    '@@ -1,4 +1,4 @@',
    ` …${longLeading.slice(-100)}`,
    '-before',
    '+after',
    ' tail',
  ]);
});

test('limitUnifiedDiffContextLines truncates trailing context from the end and keeps the nearest budgeted lines', (t) => {
  const nearTrailing = `after ${'y'.repeat(60)}`;
  const farTrailing = `later ${'z'.repeat(80)}`;
  const diffLines = ['@@ -1,5 +1,5 @@', ' top', '-before', '+after', ` ${nearTrailing}`, ` ${farTrailing}`].join('\n');

  t.deepEqual(limitUnifiedDiffContextLines(diffLines.split('\n')), [
    '@@ -1,5 +1,5 @@',
    ' top',
    '-before',
    '+after',
    ` ${nearTrailing}`,
    ` ${farTrailing.slice(0, 34)}…`,
  ]);
});

test('limitUnifiedDiffContextLines trims blank leading context from the far side before a change', (t) => {
  const diffLines = ['@@ -1,4 +1,4 @@', ' ', ' keep me', '-before', '+after'].join('\n');

  t.deepEqual(limitUnifiedDiffContextLines(diffLines.split('\n')), [
    '@@ -1,4 +1,4 @@',
    ' keep me',
    '-before',
    '+after',
  ]);
});

test('limitUnifiedDiffContextLines trims blank trailing context from the far side after a change', (t) => {
  const diffLines = ['@@ -1,4 +1,4 @@', '-before', '+after', ' keep me', ' '].join('\n');

  t.deepEqual(limitUnifiedDiffContextLines(diffLines.split('\n')), [
    '@@ -1,4 +1,4 @@',
    '-before',
    '+after',
    ' keep me',
  ]);
});

test('stripUnifiedDiffHunkHeaders removes hunk headers while keeping diff body lines', (t) => {
  t.deepEqual(stripUnifiedDiffHunkHeaders(['@@ -2,2 +2,3 @@', ' before', '-old value', '+new value']), [
    ' before',
    '-old value',
    '+new value',
  ]);
});

test('prepareUnifiedDiffLines clips context before hiding hunk headers', (t) => {
  const longLeading = `before ${'x'.repeat(140)}`;
  const diff = ['@@ -1,4 +1,4 @@', ' older context', ` ${longLeading}`, '-before', '+after', ' tail'].join('\n');

  t.deepEqual(prepareUnifiedDiffLines(diff, { clipContextLines: true, hideHunkHeaders: true }), [
    ` …${longLeading.slice(-100)}`,
    '-before',
    '+after',
    ' tail',
  ]);
});
