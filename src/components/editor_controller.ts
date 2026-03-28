export interface EditorSelectionRange {
  anchor: number;
  head: number;
}

export interface ExternalEditorChange {
  from: number;
  to: number;
  insert: string;
  selection?: EditorSelectionRange | null;
  scrollIntoView?: boolean;
  addToHistory?: boolean;
  isolateHistory?: 'before' | 'after' | 'full';
}

export interface EditorController {
  applyExternalChange: (change: ExternalEditorChange) => boolean;
  getSelectionText: (maxChars?: number) => string | null;
  getTopVisibleText: (maxChars?: number) => string | null;
  getViewportAnchorPosition: (anchorRatio?: number) => number;
  scrollToPosition: (position: number, anchorRatio?: number) => void;
  getScrollTopForPosition: (position: number, anchorRatio?: number) => number | null;
  startStreamingCursorTracking: (position: number) => void;
  updateStreamingCursorTracking: (position: number) => void;
  stopStreamingCursorTracking: () => void;
}
