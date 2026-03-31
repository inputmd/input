import test from 'ava';
import { shouldAutoRestoreDocumentDraft } from '../../src/document_draft_restore.ts';

test('shouldAutoRestoreDocumentDraft only restores when the editor is still showing the backend content', (t) => {
  t.true(
    shouldAutoRestoreDocumentDraft({
      draftContent: 'local draft',
      savedContent: 'backend content',
      editorContent: 'backend content',
      hasPendingRestore: false,
    }),
  );

  t.false(
    shouldAutoRestoreDocumentDraft({
      draftContent: 'local draft',
      savedContent: 'backend content',
      editorContent: 'already changed',
      hasPendingRestore: false,
    }),
  );

  t.false(
    shouldAutoRestoreDocumentDraft({
      draftContent: 'backend content',
      savedContent: 'backend content',
      editorContent: 'backend content',
      hasPendingRestore: false,
    }),
  );

  t.false(
    shouldAutoRestoreDocumentDraft({
      draftContent: 'local draft',
      savedContent: 'backend content',
      editorContent: 'backend content',
      hasPendingRestore: true,
    }),
  );
});
