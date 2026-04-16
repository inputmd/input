import test from 'ava';
import {
  resolveRepoSaveExpectedSha,
  shouldSkipRedundantExistingDocumentSave,
  shouldTriggerEditSaveShortcut,
} from '../../src/editor_save_guards.ts';

test('shouldTriggerEditSaveShortcut ignores repeated save keydown events', (t) => {
  t.false(
    shouldTriggerEditSaveShortcut({
      key: 's',
      metaKey: true,
      ctrlKey: false,
      repeat: true,
      loading: false,
      locked: false,
      readOnly: false,
      canSave: true,
      saving: false,
    }),
  );
});

test('shouldTriggerEditSaveShortcut accepts a single save shortcut when the editor can save', (t) => {
  t.true(
    shouldTriggerEditSaveShortcut({
      key: 'S',
      metaKey: true,
      ctrlKey: false,
      repeat: false,
      loading: false,
      locked: false,
      readOnly: false,
      canSave: true,
      saving: false,
    }),
  );
});

test('shouldSkipRedundantExistingDocumentSave skips re-saving an unchanged repo file', (t) => {
  t.true(
    shouldSkipRedundantExistingDocumentSave({
      editingBackend: 'repo',
      currentRepoDocPath: 'notes/today.md',
      currentFileName: null,
      content: 'same',
      savedContent: 'same',
    }),
  );
});

test('shouldSkipRedundantExistingDocumentSave keeps new documents saveable', (t) => {
  t.false(
    shouldSkipRedundantExistingDocumentSave({
      editingBackend: 'repo',
      currentRepoDocPath: null,
      currentFileName: null,
      content: 'same',
      savedContent: 'same',
    }),
  );
});

test('resolveRepoSaveExpectedSha prefers the latest editor sha over a stale sidebar sha', (t) => {
  t.is(resolveRepoSaveExpectedSha('fresh-sha', 'stale-sha'), 'fresh-sha');
  t.is(resolveRepoSaveExpectedSha(null, 'stale-sha'), 'stale-sha');
  t.is(resolveRepoSaveExpectedSha(null, null), undefined);
});
