import test from 'ava';
import {
  addSessionReferenceChild,
  cleanupDeletedSessionReference,
  getSessionReferenceParents,
  parseSessionReferenceIndex,
  removeSessionReferenceChild,
  serializeSessionReferenceIndex,
} from '../../src/session_index.ts';

test('session reference index parses and filters stale paths', (t) => {
  const existingPaths = new Set(['.input/.notes/a.jsonl', '.input/.notes/b.jsonl']);
  const index = parseSessionReferenceIndex(
    JSON.stringify({
      version: 1,
      children: {
        '.input/.notes/a.jsonl': ['.input/.notes/b.jsonl', '.input/.notes/b.jsonl', '.input/.notes/missing.jsonl'],
        '.input/.notes/missing.jsonl': ['.input/.notes/a.jsonl'],
      },
    }),
    existingPaths,
  );

  t.deepEqual(index.children, {
    '.input/.notes/a.jsonl': ['.input/.notes/b.jsonl'],
  });
});

test('session reference index allows multiple parents', (t) => {
  const existingPaths = new Set(['parent-a', 'parent-b', 'child']);
  const first = addSessionReferenceChild(parseSessionReferenceIndex(null), 'parent-a', 'child', existingPaths);
  t.true(first.ok);
  if (!first.ok) return;

  const second = addSessionReferenceChild(first.index, 'parent-b', 'child', existingPaths);
  t.true(second.ok);
  if (!second.ok) return;

  t.deepEqual(getSessionReferenceParents(second.index, 'child'), ['parent-a', 'parent-b']);
});

test('session reference index rejects cycles', (t) => {
  const existingPaths = new Set(['a', 'b', 'c']);
  const first = addSessionReferenceChild(parseSessionReferenceIndex(null), 'a', 'b', existingPaths);
  t.true(first.ok);
  if (!first.ok) return;
  const second = addSessionReferenceChild(first.index, 'b', 'c', existingPaths);
  t.true(second.ok);
  if (!second.ok) return;

  const cycle = addSessionReferenceChild(second.index, 'c', 'a', existingPaths);
  t.deepEqual(cycle, { ok: false, reason: 'cycle' });
});

test('session reference index removes a single parent edge', (t) => {
  const index = parseSessionReferenceIndex(
    JSON.stringify({
      version: 1,
      children: {
        'parent-a': ['child'],
        'parent-b': ['child'],
      },
    }),
  );

  const result = removeSessionReferenceChild(index, 'parent-a', 'child');

  t.true(result.changed);
  t.deepEqual(result.index.children, {
    'parent-b': ['child'],
  });
});

test('session reference index cleanup removes deleted parent and child edges', (t) => {
  const index = parseSessionReferenceIndex(
    JSON.stringify({
      version: 1,
      children: {
        parent: ['child-a', 'child-b'],
        other: ['parent', 'child-a'],
      },
    }),
  );
  const existingPaths = new Set(['child-a', 'child-b', 'other']);

  const result = cleanupDeletedSessionReference(index, 'parent', existingPaths);

  t.true(result.changed);
  t.deepEqual(result.index.children, {
    other: ['child-a'],
  });
});

test('session reference index serializes stable json', (t) => {
  t.is(
    serializeSessionReferenceIndex({ version: 1, children: { parent: ['child'] } }),
    '{\n  "version": 1,\n  "children": {\n    "parent": [\n      "child"\n    ]\n  }\n}\n',
  );
});
