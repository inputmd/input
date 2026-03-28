import test from 'ava';
import { findUnifiedDiffReplacementPair } from '../../src/components/diff_viewer_utils.ts';

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
