import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

export class MarkdownListContext {
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

export function getMarkdownListContext(state: EditorState, pos: number): MarkdownListContext[] {
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
