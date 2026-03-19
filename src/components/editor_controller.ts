export interface EditorSelectionRange {
  anchor: number;
  head: number;
}

export interface ExternalEditorChange {
  from: number;
  to: number;
  insert: string;
  selection?: EditorSelectionRange | null;
}

export interface EditorController {
  applyExternalChange: (change: ExternalEditorChange) => boolean;
}
