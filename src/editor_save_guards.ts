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
