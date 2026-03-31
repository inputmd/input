import test from 'ava';
import { buildEditorChangeMarkers } from '../../src/components/codemirror_change_markers.ts';

test('buildEditorChangeMarkers marks inserted lines as additions', (t) => {
  t.deepEqual(buildEditorChangeMarkers('alpha\nomega\n', 'alpha\nbeta\ngamma\nomega\n'), [
    { lineNumber: 2, kind: 'add' },
    { lineNumber: 3, kind: 'add' },
  ]);
});

test('buildEditorChangeMarkers marks replaced lines as modifications', (t) => {
  t.deepEqual(buildEditorChangeMarkers('alpha\nbeta\nomega\n', 'alpha\nbeta changed\nomega\n'), [
    { lineNumber: 2, kind: 'modify' },
  ]);
});

test('buildEditorChangeMarkers adds a top deletion anchor for removed middle lines', (t) => {
  t.deepEqual(buildEditorChangeMarkers('alpha\nbeta\ngamma\nomega\n', 'alpha\nomega\n'), [
    { lineNumber: 2, deletedBefore: true },
  ]);
});

test('buildEditorChangeMarkers anchors deleted first lines at the top of the file', (t) => {
  t.deepEqual(buildEditorChangeMarkers('alpha\nbeta\ngamma\n', 'gamma\n'), [{ lineNumber: 1, deletedBefore: true }]);
});

test('buildEditorChangeMarkers anchors deleted trailing lines at the bottom of the previous line', (t) => {
  t.deepEqual(buildEditorChangeMarkers('alpha\nbeta\ngamma\n', 'alpha\n'), [{ lineNumber: 1, deletedAfter: true }]);
});

test('buildEditorChangeMarkers splits uneven replacements into modify, add, and delete markers', (t) => {
  t.deepEqual(buildEditorChangeMarkers('alpha\nbeta\ngamma\nomega\n', 'alpha\none\ntwo\nthree\nomega\n'), [
    { lineNumber: 2, kind: 'modify' },
    { lineNumber: 3, kind: 'modify' },
    { lineNumber: 4, kind: 'add' },
  ]);
});
