import test from 'ava';
import {
  buildInlineDiffSegments,
  buildUnifiedDiffFromHunk,
  clipInlineDiffSegmentsForDisplay,
  findUnifiedDiffReplacementPair,
  getUnifiedDiffLineParts,
  limitUnifiedDiffContextLines,
  prepareUnifiedDiffLines,
  selectInlineDiffSegments,
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

test('findUnifiedDiffReplacementPair collapses delete plus blank-context plus non-empty-add pattern', (t) => {
  const lines = ['@@ -1,2 +1,2 @@', '-removed line', ' ', '+replacement line'];

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

test('buildInlineDiffSegments keeps unchanged context around identifier edits', (t) => {
  t.deepEqual(buildInlineDiffSegments('const fooBar = 1;', 'const fooBaz = 2;'), {
    left: [
      { value: 'const fooBa', changed: false },
      { value: 'r', changed: true },
      { value: ' = ', changed: false },
      { value: '1', changed: true },
      { value: ';', changed: false },
    ],
    right: [
      { value: 'const fooBa', changed: false },
      { value: 'z', changed: true },
      { value: ' = ', changed: false },
      { value: '2', changed: true },
      { value: ';', changed: false },
    ],
  });
});

test('buildInlineDiffSegments uses word-aware grouping for prose edits', (t) => {
  t.deepEqual(buildInlineDiffSegments('Alpha beta gamma', 'Alpha bold gamma'), {
    left: [
      { value: 'Alpha b', changed: false },
      { value: 'eta', changed: true },
      { value: ' gamma', changed: false },
    ],
    right: [
      { value: 'Alpha b', changed: false },
      { value: 'old', changed: true },
      { value: ' gamma', changed: false },
    ],
  });
});

test('clipInlineDiffSegmentsForDisplay clips long unchanged middle spans between changes', (t) => {
  const segments = [
    { value: 'prefix', changed: true },
    { value: ' '.repeat(120), changed: false },
    { value: 'suffix', changed: true },
  ];

  t.deepEqual(clipInlineDiffSegmentsForDisplay(segments), [
    { value: 'prefix', changed: true },
    { value: ' '.repeat(48), changed: false },
    { value: '…', changed: false, ellipsis: true },
    { value: ' '.repeat(48), changed: false },
    { value: 'suffix', changed: true },
  ]);
});

test('clipInlineDiffSegmentsForDisplay clips long leading and trailing unchanged runs', (t) => {
  const segments = [
    { value: 'x'.repeat(90), changed: false },
    { value: 'changed', changed: true },
    { value: 'y'.repeat(90), changed: false },
  ];

  t.deepEqual(clipInlineDiffSegmentsForDisplay(segments), [
    { value: '…', changed: false, ellipsis: true },
    { value: 'x'.repeat(48), changed: false },
    { value: 'changed', changed: true },
    { value: 'y'.repeat(48), changed: false },
    { value: '…', changed: false, ellipsis: true },
  ]);
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

test('selectInlineDiffSegments keeps removed words off the updated side', (t) => {
  t.deepEqual(selectInlineDiffSegments('alpha beta gamma', 'alpha gamma', 'left'), [
    { value: 'alpha ', changed: false },
    { value: 'beta ', changed: true },
    { value: 'gamma', changed: false },
  ]);

  t.deepEqual(selectInlineDiffSegments('alpha beta gamma', 'alpha gamma', 'right'), [
    { value: 'alpha gamma', changed: false },
  ]);
});
