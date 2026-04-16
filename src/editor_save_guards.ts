export interface EditSaveShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
  loading: boolean;
  locked: boolean;
  readOnly: boolean;
  canSave: boolean;
  saving: boolean;
}

export function shouldTriggerEditSaveShortcut(input: EditSaveShortcutInput): boolean {
  return (
    (input.metaKey || input.ctrlKey) &&
    input.key.toLowerCase() === 's' &&
    !input.repeat &&
    !input.loading &&
    !input.locked &&
    !input.readOnly &&
    input.canSave &&
    !input.saving
  );
}

export interface RedundantExistingDocumentSaveInput {
  editingBackend: 'gist' | 'repo' | null;
  currentRepoDocPath: string | null;
  currentFileName: string | null;
  content: string;
  savedContent: string | null;
}

export function shouldSkipRedundantExistingDocumentSave(input: RedundantExistingDocumentSaveInput): boolean {
  const hasPersistedTarget =
    input.editingBackend === 'repo'
      ? input.currentRepoDocPath !== null
      : input.editingBackend === 'gist'
        ? input.currentFileName !== null
        : false;
  return hasPersistedTarget && input.savedContent !== null && input.content === input.savedContent;
}

export function resolveRepoSaveExpectedSha(
  currentRepoDocSha: string | null,
  fallbackSha?: string | null,
): string | undefined {
  return currentRepoDocSha ?? fallbackSha ?? undefined;
}
