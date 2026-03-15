import { syntaxTree } from '@codemirror/language';
import { type EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

function hasAncestorNamed(node: SyntaxNode | null, name: string): boolean {
  for (let current = node; current; current = current.parent) {
    if (current.name === name) return true;
  }
  return false;
}

export function isFencedCodeLine(
  viewOrState: EditorView | EditorState,
  lineFrom: number,
  lineTo: number,
): boolean {
  const state = viewOrState instanceof EditorView ? viewOrState.state : viewOrState;
  const tree = syntaxTree(state);
  const endPos = Math.max(lineFrom, lineTo - 1);
  return (
    hasAncestorNamed(tree.resolveInner(lineFrom, 1), 'FencedCode') ||
    hasAncestorNamed(tree.resolveInner(endPos, -1), 'FencedCode')
  );
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    let lineNumber = view.state.doc.lineAt(from).number;
    const lastLineNumber = view.state.doc.lineAt(to).number;

    for (; lineNumber <= lastLineNumber; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      if (!isFencedCodeLine(view, line.from, line.to)) continue;
      builder.add(line.from, line.from, Decoration.line({ attributes: { class: 'cm-md-fenced-code' } }));
    }
  }

  return builder.finish();
}

export const fencedCodeLineClassExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);
