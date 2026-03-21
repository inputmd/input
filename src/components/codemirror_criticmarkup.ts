import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { type CriticMarkupMatch, parseCriticMarkupAt } from '../criticmarkup.ts';

function hasAncestorNamed(node: SyntaxNode | null, names: ReadonlySet<string>): boolean {
  for (let current = node; current; current = current.parent) {
    if (names.has(current.name)) return true;
  }
  return false;
}

const CODE_NODE_NAMES = new Set(['FencedCode', 'InlineCode', 'CodeText', 'CodeMark']);

function isCodePosition(state: EditorView['state'], pos: number): boolean {
  const tree = syntaxTree(state);
  return (
    hasAncestorNamed(tree.resolveInner(pos, 1), CODE_NODE_NAMES) ||
    hasAncestorNamed(tree.resolveInner(Math.max(0, pos - 1), -1), CODE_NODE_NAMES)
  );
}

function addSimpleDecorations(builder: RangeSetBuilder<Decoration>, match: CriticMarkupMatch): void {
  builder.add(match.openerFrom, match.openerTo, Decoration.mark({ class: 'cm-critic-delimiter' }));
  if (match.contentFrom < match.contentTo) {
    builder.add(match.contentFrom, match.contentTo, Decoration.mark({ class: `cm-critic-${match.kind}` }));
  }
  builder.add(match.closerFrom, match.closerTo, Decoration.mark({ class: 'cm-critic-delimiter' }));
}

function addSubstitutionDecorations(builder: RangeSetBuilder<Decoration>, match: CriticMarkupMatch): void {
  builder.add(match.openerFrom, match.openerTo, Decoration.mark({ class: 'cm-critic-delimiter' }));
  if (match.oldText && match.separatorFrom && match.contentFrom < match.separatorFrom) {
    builder.add(match.contentFrom, match.separatorFrom, Decoration.mark({ class: 'cm-critic-deletion' }));
  }
  if (match.separatorFrom != null && match.separatorTo != null) {
    builder.add(match.separatorFrom, match.separatorTo, Decoration.mark({ class: 'cm-critic-delimiter' }));
  }
  if (match.newText && match.separatorTo != null && match.separatorTo < match.closerFrom) {
    builder.add(match.separatorTo, match.closerFrom, Decoration.mark({ class: 'cm-critic-addition' }));
  }
  builder.add(match.closerFrom, match.closerTo, Decoration.mark({ class: 'cm-critic-delimiter' }));
}

function buildCriticMarkupDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    let cursor = 0;
    while (cursor < text.length) {
      const braceIndex = text.indexOf('{', cursor);
      if (braceIndex === -1) break;
      const absoluteFrom = from + braceIndex;
      cursor = braceIndex + 1;

      if (isCodePosition(view.state, absoluteFrom)) continue;

      const match = parseCriticMarkupAt(text, braceIndex);
      if (!match) continue;

      const absoluteMatch: CriticMarkupMatch = {
        ...match,
        from: absoluteFrom,
        to: from + match.to,
        openerFrom: from + match.openerFrom,
        openerTo: from + match.openerTo,
        closerFrom: from + match.closerFrom,
        closerTo: from + match.closerTo,
        contentFrom: from + match.contentFrom,
        contentTo: from + match.contentTo,
        separatorFrom: match.separatorFrom == null ? undefined : from + match.separatorFrom,
        separatorTo: match.separatorTo == null ? undefined : from + match.separatorTo,
      };

      if (absoluteMatch.kind === 'substitution') {
        addSubstitutionDecorations(builder, absoluteMatch);
      } else {
        addSimpleDecorations(builder, absoluteMatch);
      }

      cursor = match.to;
    }
  }

  return builder.finish();
}

export const criticMarkupDecorationExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCriticMarkupDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildCriticMarkupDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);
