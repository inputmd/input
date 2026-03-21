export interface EditorSelectionRange {
  anchor: number;
  head: number;
}

export interface ExternalEditorChange {
  from: number;
  to: number;
  insert: string;
  selection?: EditorSelectionRange | null;
  addToHistory?: boolean;
  isolateHistory?: 'before' | 'after' | 'full';
}

export interface EditorController {
  applyExternalChange: (change: ExternalEditorChange) => boolean;
  startStreamingCursorTracking: (position: number) => void;
  updateStreamingCursorTracking: (position: number) => void;
  stopStreamingCursorTracking: () => void;
}
