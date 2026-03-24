import { isolateHistory } from '@codemirror/commands';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { matchPromptListLine, parsePromptListBlock } from '../prompt_list_syntax.ts';
import type { ExternalEditorChange } from './editor_controller';

interface PromptListThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PromptListRequest {
  prompt: string;
  documentContent: string;
  messages: PromptListThreadMessage[];
  answerIndent: string;
  insertFrom: number;
  insertTo: number;
  insertedPrefix: string;
  answerFrom: number;
}

interface BracePromptEnterController {
  isActive: () => boolean;
  getPanel: () => { options: string[] } | null;
  acceptSelection: (view: EditorView) => boolean;
}

interface PromptListItem {
  kind: 'question' | 'answer';
  indent: string;
  indentWidth: number;
  lineNumber: number;
  lastLineNumber: number;
  from: number;
  to: number;
  content: string;
}

interface PromptListTurn {
  questionItemIndex: number;
  answerItemIndex: number | null;
  parentTurnIndex: number | null;
}

interface PromptListBlock {
  items: PromptListItem[];
  turns: PromptListTurn[];
  itemToTurnIndex: number[];
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

export function acceptBracePromptSelectionOnEnter(view: EditorView, bracePrompt: BracePromptEnterController): boolean {
  if (!bracePrompt.isActive()) return false;
  if ((bracePrompt.getPanel()?.options.length ?? 0) === 0) return true;
  return bracePrompt.acceptSelection(view);
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
  return buildExternalEditorChangeTransaction(state, {
    from: 0,
    to: currentDoc.length,
    insert: content,
    selection: selection ?? {
      anchor: Math.min(prevSel.head, content.length),
      head: Math.min(prevSel.head, content.length),
    },
  });
}

export function buildExternalEditorChangeTransaction(
  state: EditorState,
  change: ExternalEditorChange,
): TransactionSpec | null {
  const currentDoc = state.doc.toString();
  const contentLength = currentDoc.length;
  const from = Math.max(0, Math.min(change.from, contentLength));
  const to = Math.max(from, Math.min(change.to, contentLength));
  const insert = change.insert;
  const hasDocChange = currentDoc.slice(from, to) !== insert;

  let nextSelection: { anchor: number; head: number } | undefined;
  if (change.selection) {
    const nextContentLength = contentLength - (to - from) + insert.length;
    nextSelection = {
      anchor: Math.max(0, Math.min(change.selection.anchor, nextContentLength)),
      head: Math.max(0, Math.min(change.selection.head, nextContentLength)),
    };
  }

  if (!hasDocChange && nextSelection === undefined) return null;

  const annotations = [externalSyncAnnotation, Transaction.addToHistory.of(change.addToHistory ?? false)];
  if (change.isolateHistory) {
    annotations.push(isolateHistory.of(change.isolateHistory));
  }

  return {
    changes: hasDocChange ? { from, to, insert } : undefined,
    selection: nextSelection,
    scrollIntoView: change.scrollIntoView ?? false,
    annotations,
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

function promptListIndentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === '\t' ? 2 : 1;
  return width;
}

function buildPromptListTurns(items: PromptListItem[]): { turns: PromptListTurn[]; itemToTurnIndex: number[] } {
  const turns: PromptListTurn[] = [];
  const itemToTurnIndex = Array.from({ length: items.length }, () => -1);
  const openTurnStack: number[] = [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];

    if (item.kind === 'question') {
      while (
        openTurnStack.length > 0 &&
        items[turns[openTurnStack[openTurnStack.length - 1]].questionItemIndex].indentWidth >= item.indentWidth
      ) {
        openTurnStack.pop();
      }

      const parentTurnIndex = openTurnStack.length > 0 ? openTurnStack[openTurnStack.length - 1] : null;
      const turnIndex = turns.push({ questionItemIndex: itemIndex, answerItemIndex: null, parentTurnIndex }) - 1;
      itemToTurnIndex[itemIndex] = turnIndex;
      openTurnStack.push(turnIndex);
      continue;
    }

    while (
      openTurnStack.length > 0 &&
      items[turns[openTurnStack[openTurnStack.length - 1]].questionItemIndex].indentWidth > item.indentWidth
    ) {
      openTurnStack.pop();
    }

    for (let stackIndex = openTurnStack.length - 1; stackIndex >= 0; stackIndex -= 1) {
      const turnIndex = openTurnStack[stackIndex];
      const turn = turns[turnIndex];
      const question = items[turn.questionItemIndex];
      if (question.indentWidth !== item.indentWidth) continue;
      if (turn.answerItemIndex !== null) continue;
      turn.answerItemIndex = itemIndex;
      itemToTurnIndex[itemIndex] = turnIndex;
      break;
    }
  }

  return { turns, itemToTurnIndex };
}

function parsePromptListBlocks(state: EditorState): PromptListBlock[] {
  const blocks: PromptListBlock[] = [];
  const lines = Array.from({ length: state.doc.lines }, (_, index) => state.doc.line(index + 1).text);
  let lineNumber = 1;

  while (lineNumber <= state.doc.lines) {
    const block = parsePromptListBlock(lines, lineNumber - 1);
    if (!block) {
      lineNumber += 1;
      continue;
    }

    const items: PromptListItem[] = [];
    for (const parsedItem of block.items) {
      const currentLineNumber = parsedItem.startLineIndex + 1;
      const lastLineNumber = parsedItem.endLineIndex + 1;
      const currentLine = state.doc.line(currentLineNumber);
      items.push({
        kind: parsedItem.match.kind,
        indent: parsedItem.match.indent,
        indentWidth: promptListIndentWidth(parsedItem.match.indent),
        lineNumber: currentLineNumber,
        lastLineNumber,
        from: currentLine.from,
        to: state.doc.line(lastLineNumber).to,
        content: parsedItem.content.trim(),
      });
    }

    const { turns, itemToTurnIndex } = buildPromptListTurns(items);
    blocks.push({ items, turns, itemToTurnIndex });
    lineNumber = items[items.length - 1].lastLineNumber + 1;
  }

  return blocks;
}

function previousSiblingTurnIndices(block: PromptListBlock, turnIndex: number): number[] {
  const parentTurnIndex = block.turns[turnIndex].parentTurnIndex;
  const siblings: number[] = [];
  for (let index = turnIndex - 1; index >= 0; index -= 1) {
    if (block.turns[index].parentTurnIndex === parentTurnIndex) siblings.push(index);
  }
  siblings.reverse();
  return siblings;
}

function promptListTurnMessages(block: PromptListBlock, turnIndex: number): PromptListThreadMessage[] {
  const turn = block.turns[turnIndex];
  const messages: PromptListThreadMessage[] = [];
  const question = block.items[turn.questionItemIndex];
  if (question.content.length > 0) messages.push({ role: 'user', content: question.content });
  if (turn.answerItemIndex !== null) {
    const answer = block.items[turn.answerItemIndex];
    if (answer.content.length > 0) messages.push({ role: 'assistant', content: answer.content });
  }
  return messages;
}

function contextMessagesThroughTurn(block: PromptListBlock, turnIndex: number): PromptListThreadMessage[] {
  const turn = block.turns[turnIndex];
  if (turn.parentTurnIndex === null) {
    const messages: PromptListThreadMessage[] = [];
    for (let index = 0; index < turnIndex; index += 1) {
      if (block.turns[index].parentTurnIndex !== null) continue;
      messages.push(...promptListTurnMessages(block, index));
    }
    messages.push(...promptListTurnMessages(block, turnIndex));
    return messages;
  }

  const messages = contextMessagesThroughTurn(block, turn.parentTurnIndex);
  const siblingTurnIndices = previousSiblingTurnIndices(block, turnIndex);
  for (const siblingTurnIndex of siblingTurnIndices) {
    messages.push(...promptListTurnMessages(block, siblingTurnIndex));
  }
  messages.push(...promptListTurnMessages(block, turnIndex));
  return messages;
}

function insertionPointAfterTurnSubtree(block: PromptListBlock, turnIndex: number): number {
  const question = block.items[block.turns[turnIndex].questionItemIndex];
  let insertionPoint = question.to;

  for (let itemIndex = block.turns[turnIndex].questionItemIndex + 1; itemIndex < block.items.length; itemIndex += 1) {
    const item = block.items[itemIndex];
    if (item.indentWidth <= question.indentWidth) break;
    insertionPoint = item.to;
  }

  return insertionPoint;
}

function findPromptListBlockAt(
  state: EditorState,
  lineNumber: number,
): { block: PromptListBlock; itemIndex: number } | null {
  const blocks = parsePromptListBlocks(state);
  for (const block of blocks) {
    const itemIndex = block.items.findIndex(
      (item) => lineNumber >= item.lineNumber && lineNumber <= item.lastLineNumber,
    );
    if (itemIndex >= 0) return { block, itemIndex };
  }
  return null;
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

export function getPromptListRequest(state: EditorState): PromptListRequest | null {
  const range = state.selection.main;
  if (!range.empty) return null;
  if (!markdownLanguage.isActiveAt(state, range.from, -1) && !markdownLanguage.isActiveAt(state, range.from, 1))
    return null;

  const line = state.doc.lineAt(range.from);
  if (range.from !== line.to) return null;

  const match = matchPromptListLine(line.text);
  if (!match || match.kind !== 'question') return null;

  const prompt = match.content.trim();
  if (!prompt) return null;
  const thread = findPromptListBlockAt(state, line.number);
  if (!thread) return null;

  const currentItem = thread.block.items[thread.itemIndex];
  const currentTurnIndex = thread.block.itemToTurnIndex[thread.itemIndex];
  if (currentTurnIndex < 0) return null;

  const currentTurn = thread.block.turns[currentTurnIndex];
  const messages: PromptListThreadMessage[] = [];
  if (currentTurn.parentTurnIndex === null) {
    for (let index = 0; index < currentTurnIndex; index += 1) {
      if (thread.block.turns[index].parentTurnIndex !== null) continue;
      messages.push(...promptListTurnMessages(thread.block, index));
    }
  } else {
    messages.push(...contextMessagesThroughTurn(thread.block, currentTurn.parentTurnIndex));
    const siblingTurnIndices = previousSiblingTurnIndices(thread.block, currentTurnIndex);
    for (const siblingTurnIndex of siblingTurnIndices) {
      messages.push(...promptListTurnMessages(thread.block, siblingTurnIndex));
    }
  }
  messages.push({ role: 'user' as const, content: currentItem.content });

  if (currentTurn.answerItemIndex !== null) {
    const nextItem = thread.block.items[currentTurn.answerItemIndex];
    const insertedPrefix = `${nextItem.indent}⏺ `;
    return {
      prompt,
      documentContent: state.doc.toString(),
      messages,
      answerIndent: nextItem.indent,
      insertFrom: nextItem.from,
      insertTo: nextItem.to,
      insertedPrefix,
      answerFrom: nextItem.from + insertedPrefix.length,
    };
  }

  const insertFrom = insertionPointAfterTurnSubtree(thread.block, currentTurnIndex);
  const insertedPrefix = `${state.lineBreak}${match.indent}⏺ `;
  return {
    prompt,
    documentContent: state.doc.toString(),
    messages,
    answerIndent: match.indent,
    insertFrom,
    insertTo: insertFrom,
    insertedPrefix,
    answerFrom: insertFrom + insertedPrefix.length,
  };
}

export function insertNewlineExitPromptQuestion(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (!markdownLanguage.isActiveAt(state, range.from, -1) && !markdownLanguage.isActiveAt(state, range.from, 1))
    return false;

  const line = state.doc.lineAt(range.from);
  if (range.from !== line.to) return false;

  const match = matchPromptListLine(line.text);
  if (!match || match.kind !== 'question' || match.content.trim()) return false;

  const insert = state.lineBreak;
  view.dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert },
      selection: EditorSelection.cursor(line.from + insert.length),
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
}

export function insertNewlineContinuePromptAnswer(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (!markdownLanguage.isActiveAt(state, range.from, -1) && !markdownLanguage.isActiveAt(state, range.from, 1))
    return false;

  const line = state.doc.lineAt(range.from);
  if (range.from !== line.to) return false;
  const thread = findPromptListBlockAt(state, line.number);
  if (!thread) return false;

  const item = thread.block.items[thread.itemIndex];
  if (item.kind !== 'answer' || line.number !== item.lastLineNumber) return false;

  const insert = `${state.lineBreak}${item.indent}~ `;
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

export function backspacePromptQuestionMarker(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (!markdownLanguage.isActiveAt(state, range.from, -1) && !markdownLanguage.isActiveAt(state, range.from, 1))
    return false;

  const line = state.doc.lineAt(range.from);
  const match = matchPromptListLine(line.text);
  if (!match || match.kind !== 'question' || match.content.length > 0) return false;

  const markerEnd = line.from + match.markerEnd;
  if (range.from !== markerEnd) return false;

  const markerFrom = line.from + match.indent.length;
  const markerTo = markerFrom + match.marker.length;
  view.dispatch(
    state.update({
      changes: { from: markerFrom, to: markerTo, insert: '' },
      selection: EditorSelection.cursor(range.from - (markerTo - markerFrom)),
      scrollIntoView: true,
      userEvent: 'delete.backward',
    }),
  );
  return true;
}
