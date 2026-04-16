import { isolateHistory } from '@codemirror/commands';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { matchPromptListLine, parsePromptListBlock } from '../prompt_list_syntax.ts';
import type { ExternalEditorChange } from './editor_controller';
import { getMarkdownListContext, type MarkdownListContext } from './markdown_editor_list_context.ts';

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
  kind: 'question' | 'answer' | 'comment';
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
  if (selection == null) {
    console.warn('[editor-sync] whole-doc replace without explicit selection', {
      prevHead: prevSel.head,
      oldLength: currentDoc.length,
      newLength: content.length,
    });
  }
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

function blankPrefixWithoutLists(context: MarkdownListContext[]): string {
  return context
    .filter((item) => item.node.name === 'Blockquote')
    .map((item) => item.blank(null))
    .join('');
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
    if (item.kind === 'comment') continue;

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

function ensureMarkdownSyntax(state: EditorState, pos: number): void {
  const boundedPos = Math.max(0, Math.min(state.doc.length, pos));
  ensureSyntaxTree(state, Math.min(state.doc.length, boundedPos + 1), 25);
}

function isMarkdownActive(state: EditorState, pos: number): boolean {
  ensureMarkdownSyntax(state, pos);
  return markdownLanguage.isActiveAt(state, pos, -1) || markdownLanguage.isActiveAt(state, pos, 1);
}

export function insertNewlineContinueLooseListItem(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.from);
  // Let CodeMirror's default markdown Enter behavior handle line-end list
  // continuation so a second Enter can exit nested items consistently.
  if (range.from === line.to) return false;
  if (!isMarkdownActive(state, range.from)) return false;
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

export function insertNewlineExitLooseNestedListItem(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.from);
  if (range.from !== line.to) return false;
  const currentLineContext = getMarkdownListContext(state, range.from);
  while (currentLineContext.length && currentLineContext[currentLineContext.length - 1].from > range.from - line.from) {
    currentLineContext.pop();
  }

  const currentInner = currentLineContext[currentLineContext.length - 1];
  const currentParent = [...currentLineContext]
    .slice(0, -1)
    .reverse()
    .find((item) => item.item !== null);

  if (currentInner?.item && currentParent?.item && !/\S/.test(line.text.slice(currentInner.to))) {
    const insert = blankPrefixWithoutLists(currentLineContext);
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

  if (/\S/.test(line.text)) return false;
  if (line.number <= 1) return false;

  const previousLine = state.doc.line(line.number - 1);
  const inMarkdown = isMarkdownActive(state, range.from) || isMarkdownActive(state, previousLine.to);
  if (!inMarkdown) return false;
  if (!/\S/.test(previousLine.text)) return false;

  const previousLineContext = getMarkdownListContext(state, previousLine.to);
  const previousInner = previousLineContext[previousLineContext.length - 1];
  const previousParent = [...previousLineContext]
    .slice(0, -1)
    .reverse()
    .find((item) => item.item !== null);

  if (!previousInner?.item || !previousParent?.item) return false;

  const insert = `${state.lineBreak}${blankPrefixWithoutLists(previousLineContext)}`;
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
  if (!isMarkdownActive(state, range.from)) return false;

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

export function getPromptListRequest(state: EditorState): PromptListRequest | null {
  const range = state.selection.main;
  if (!range.empty) return null;
  if (!isMarkdownActive(state, range.from)) return null;

  const line = state.doc.lineAt(range.from);
  if (range.from !== line.to) return null;

  const thread = findPromptListBlockAt(state, line.number);
  if (!thread) return null;

  const currentItem = thread.block.items[thread.itemIndex];
  if (currentItem.kind !== 'question' || line.number !== currentItem.lastLineNumber) return null;

  const firstLineMatch = matchPromptListLine(state.doc.line(currentItem.lineNumber).text);
  if (!firstLineMatch || firstLineMatch.kind !== 'question' || firstLineMatch.marker !== '~') return null;

  const prompt = currentItem.content.trim();
  if (!prompt) return null;

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
  const insertedPrefix = `${state.lineBreak}${currentItem.indent}⏺ `;
  return {
    prompt,
    documentContent: state.doc.toString(),
    messages,
    answerIndent: currentItem.indent,
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
  if (!match || match.kind !== 'question' || match.marker !== '~' || match.content.trim()) return false;

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

export function insertNewlineContinuePromptComment(view: EditorView): boolean {
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
  if (item.kind !== 'comment' || line.number !== item.lastLineNumber) return false;

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

export function backspaceTaskListMarker(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (!isMarkdownActive(state, range.from)) return false;

  const line = state.doc.lineAt(range.from);
  const match = /^((?:\s*> ?)*\s*(?:[-+*]|\d+[.)]) +)\[[ xX]\]( +)$/.exec(line.text);
  if (!match) return false;

  const taskMarkerEnd = line.from + match[0].length;
  if (range.from !== taskMarkerEnd) return false;

  const taskMarkerFrom = line.from + match[1].length;
  view.dispatch(
    state.update({
      changes: { from: taskMarkerFrom, to: line.to, insert: '' },
      selection: EditorSelection.cursor(taskMarkerFrom),
      scrollIntoView: true,
      userEvent: 'delete.backward',
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
