import { EditorSelection, type EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Continue markdown lists on Enter: `- `, `* `, `+ `, `1. `, `1) `, `- [ ] `, etc. */
export function markdownListContinuation({ state, dispatch }: EditorView): boolean {
  const { from, to } = state.selection.main;
  if (from !== to) return false;

  const line = state.doc.lineAt(from);
  if (from !== line.to) return false;
  const text = line.text;

  const match = text.match(/^(\s*)([-*+]|\d+[.)]) (\[[ xX]\] )?/);
  if (!match) return false;

  const [fullMatch, indent, marker, checkbox] = match;

  // Empty list item clears the marker and keeps the indentation.
  if (text.trimEnd() === fullMatch.trimEnd()) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: indent },
        selection: EditorSelection.cursor(line.from + indent.length),
      }),
    );
    return true;
  }

  let nextMarker = marker;
  const numMatch = marker.match(/^(\d+)([.)])/);
  if (numMatch) {
    nextMarker = `${Number(numMatch[1]) + 1}${numMatch[2]}`;
  }

  const continuation = `\n${indent}${nextMarker} ${checkbox ? '[ ] ' : ''}`;
  dispatch(
    state.update({
      changes: { from, to: from, insert: continuation },
      selection: EditorSelection.cursor(from + continuation.length),
    }),
  );
  return true;
}

export function wrapWithMarker(view: EditorView, marker: string): boolean {
  const { from, to } = view.state.selection.main;
  const len = marker.length;
  const doc = view.state.doc;

  const before = doc.sliceString(from - len, from);
  const after = doc.sliceString(to, to + len);

  if (before === marker && after === marker) {
    const selected = view.state.sliceDoc(from, to);
    view.dispatch(
      view.state.update({
        changes: { from: from - len, to: to + len, insert: selected },
        selection: from === to ? EditorSelection.cursor(from - len) : EditorSelection.range(from - len, to - len),
      }),
    );
    return true;
  }

  const selected = view.state.sliceDoc(from, to);
  const replacement = `${marker}${selected}${marker}`;
  view.dispatch(
    view.state.update({
      changes: { from, to, insert: replacement },
      selection: from === to ? EditorSelection.cursor(from + len) : EditorSelection.range(from + len, to + len),
    }),
  );
  return true;
}

export const externalSyncAnnotation = Transaction.userEvent.of('external');

export function isExternalSyncTransaction(transaction: Transaction): boolean {
  return transaction.annotation(Transaction.userEvent) === 'external';
}

export function buildExternalContentSyncTransaction(state: EditorState, content: string): TransactionSpec | null {
  const currentDoc = state.doc.toString();
  if (currentDoc === content) return null;

  const prevSel = state.selection.main;
  return {
    changes: { from: 0, to: currentDoc.length, insert: content },
    selection: EditorSelection.cursor(Math.min(prevSel.head, content.length)),
    annotations: [externalSyncAnnotation, Transaction.addToHistory.of(false)],
  };
}
