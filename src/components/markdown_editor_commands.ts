import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

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

export function buildExternalContentSyncTransaction(
  state: EditorState,
  content: string,
  selection?: { anchor: number; head: number } | null,
): TransactionSpec | null {
  const currentDoc = state.doc.toString();
  if (currentDoc === content) return null;

  const prevSel = state.selection.main;
  return {
    changes: { from: 0, to: currentDoc.length, insert: content },
    selection: selection
      ? EditorSelection.range(Math.min(selection.anchor, content.length), Math.min(selection.head, content.length))
      : EditorSelection.cursor(Math.min(prevSel.head, content.length)),
    annotations: [externalSyncAnnotation, Transaction.addToHistory.of(false)],
  };
}

class MarkdownListContext {
  readonly node: {
    name: string;
    firstChild: { from: number; to: number } | null;
    getChild: (name: string, after?: string) => any;
  };
  readonly from: number;
  readonly to: number;
  readonly spaceBefore: string;
  readonly spaceAfter: string;
  readonly type: string;
  readonly item: { from: number; to: number } | null;

  constructor(
    node: {
      name: string;
      firstChild: { from: number; to: number } | null;
      getChild: (name: string, after?: string) => any;
    },
    from: number,
    to: number,
    spaceBefore: string,
    spaceAfter: string,
    type: string,
    item: { from: number; to: number } | null,
  ) {
    this.node = node;
    this.from = from;
    this.to = to;
    this.spaceBefore = spaceBefore;
    this.spaceAfter = spaceAfter;
    this.type = type;
    this.item = item;
  }

  blank(maxWidth: number | null, trailing = true): string {
    let result = this.spaceBefore + (this.node.name === 'Blockquote' ? '>' : '');
    if (maxWidth != null) {
      while (result.length < maxWidth) result += ' ';
      return result;
    }

    for (let i = this.to - this.from - result.length - this.spaceAfter.length; i > 0; i -= 1) {
      result += ' ';
    }
    return result + (trailing ? this.spaceAfter : '');
  }
}

function getMarkdownListContext(state: EditorState, pos: number): MarkdownListContext[] {
  const doc = state.doc;
  const nodes: SyntaxNode[] = [];
  const context: MarkdownListContext[] = [];

  for (let cur: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); cur; cur = cur.parent) {
    if (cur.name === 'FencedCode') return context;
    if (cur.name === 'ListItem' || cur.name === 'Blockquote') nodes.push(cur);
  }

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const line = doc.lineAt(node.from);
    const startPos = node.from - line.from;
    let match: RegExpExecArray | null = null;

    if (node.name === 'Blockquote' && (match = /^ *>( ?)/.exec(line.text.slice(startPos)))) {
      context.push(new MarkdownListContext(node, startPos, startPos + match[0].length, '', match[1], '>', null));
      continue;
    }

    if (
      node.name === 'ListItem' &&
      node.parent?.name === 'OrderedList' &&
      (match = /^( *)\d+([.)])( *)/.exec(line.text.slice(startPos)))
    ) {
      let after = match[3];
      let len = match[0].length;
      if (after.length >= 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      context.push(new MarkdownListContext(node.parent, startPos, startPos + len, match[1], after, match[2], node));
      continue;
    }

    if (
      node.name === 'ListItem' &&
      node.parent?.name === 'BulletList' &&
      (match = /^( *)([-+*])( {1,4}\[[ xX]\])?( +)/.exec(line.text.slice(startPos)))
    ) {
      let after = match[4];
      let len = match[0].length;
      if (after.length > 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      let type = match[2];
      if (match[3]) type += match[3].replace(/[xX]/, ' ');
      context.push(new MarkdownListContext(node.parent, startPos, startPos + len, match[1], after, type, node));
    }
  }

  return context;
}

function isNonTightList(
  node: { name: string; firstChild: { to: number } | null; getChild: (name: string, after?: string) => any },
  doc: EditorState['doc'],
): boolean {
  if (node.name !== 'OrderedList' && node.name !== 'BulletList') return false;
  const first = node.firstChild;
  const second = node.getChild('ListItem', 'ListItem');
  if (!first || !second) return false;

  const line1 = doc.lineAt(first.to);
  const line2 = doc.lineAt(second.from);
  const empty = /^[\s>]*$/.test(line1.text);
  return line1.number + (empty ? 0 : 1) < line2.number;
}

export function insertNewlineContinueLooseListItem(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (!markdownLanguage.isActiveAt(state, range.from, -1) && !markdownLanguage.isActiveAt(state, range.from, 1))
    return false;

  const line = state.doc.lineAt(range.from);
  if (!/\S/.test(line.text)) return false;

  const context = getMarkdownListContext(state, range.from);
  while (context.length && context[context.length - 1].from > range.from - line.from) context.pop();
  if (!context.length) return false;

  const inner = context[context.length - 1];
  if (!inner.item || !isNonTightList(inner.node, state.doc)) return false;

  const insert = state.lineBreak;
  view.dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
}

export function insertNewlineExitBlockquote(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (!markdownLanguage.isActiveAt(state, range.from, -1) && !markdownLanguage.isActiveAt(state, range.from, 1))
    return false;

  const line = state.doc.lineAt(range.from);
  if (range.from !== line.to) return false;

  const context = getMarkdownListContext(state, range.from);
  while (context.length && context[context.length - 1].from > range.from - line.from) context.pop();
  if (!context.length) return false;

  const inner = context[context.length - 1];
  // Override CodeMirror's default markdown Enter behavior here so a completed
  // plain blockquote line exits the quote instead of lazily continuing `>`.
  if (inner.node.name !== 'Blockquote' || inner.item) return false;
  if (!/\S/.test(line.text.slice(inner.to))) return false;

  const insert = state.lineBreak;
  view.dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
}

export function normalizeBlockquotePaste(state: EditorState, pos: number, text: string): string | null {
  if (!markdownLanguage.isActiveAt(state, pos, -1) && !markdownLanguage.isActiveAt(state, pos, 1)) return null;

  const line = state.doc.lineAt(pos);
  const context = getMarkdownListContext(state, pos);
  while (context.length && context[context.length - 1].from > pos - line.from) context.pop();

  const blockquotePrefix = context
    .filter((item) => item.node.name === 'Blockquote')
    .map((item) => item.blank(null))
    .join('');
  if (!blockquotePrefix) return null;

  const normalized = text.replace(/\r\n?/g, '\n');
  const trimmed = normalized.trim();
  const isSingleHttpUrl = /^https?:\/\/\S+$/.test(trimmed) && !normalized.includes('\n');
  if (isSingleHttpUrl && pos === line.to) {
    if (state.doc.sliceString(Math.max(line.from, pos - 2), pos) === '](') return null;
    return `[^src](${trimmed})`;
  }

  const lines = normalized.split('\n');
  if (lines.length < 2) return null;

  return lines.map((segment, index) => (index === 0 ? segment : `${blockquotePrefix}${segment}`)).join(state.lineBreak);
}
