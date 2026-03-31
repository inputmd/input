export interface AutoRestoreDocumentDraftInput {
  draftContent: string | null;
  savedContent: string | null;
  editorContent: string;
  hasPendingRestore: boolean;
}

export function shouldAutoRestoreDocumentDraft({
  draftContent,
  savedContent,
  editorContent,
  hasPendingRestore,
}: AutoRestoreDocumentDraftInput): boolean {
  if (hasPendingRestore) return false;
  if (draftContent === null || savedContent === null) return false;
  if (draftContent === savedContent) return false;
  return editorContent === savedContent;
}
