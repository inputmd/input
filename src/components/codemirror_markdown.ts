import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Facet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { BlockContext, InlineParser, Line, MarkdownExtension } from '@lezer/markdown';
import { BRACE_PROMPT_HINT_LABEL } from '../brace_prompt.ts';
import { parseHighlightMarkupAt } from '../highlight_markup.ts';
import { EMPTY_PROMPT_QUESTION_PLACEHOLDER, matchPromptListLine, parsePromptListBlock } from '../prompt_list_syntax.ts';
import { criticMarkupDecorationExtension } from './codemirror_criticmarkup.ts';
import {
  bracePromptContextRangesForPosition,
  buildBracePromptRequest,
  findBracePromptHintMatch,
  findBracePromptMatch,
  isBracePromptBlockedInCode,
} from './codemirror_inline_prompt.ts';

const wikiLinkInlineParser: InlineParser = {
  name: 'WikiLink',
  before: 'Link',
  parse(cx, next, pos) {
    if (next !== 91 || cx.char(pos + 1) !== 91) return -1; // `[[`

    for (let index = pos + 2; index < cx.end; index += 1) {
      const ch = cx.char(index);
      if (ch === 10 || ch === 13) return -1; // don't span lines
      if (ch === 93 && cx.char(index + 1) === 93) {
        if (index === pos + 2) return -1; // disallow empty `[[ ]]`
        return cx.addElement(cx.elt('WikiLink', pos, index + 2));
      }
    }

    return -1;
  },
};

const wikiLinkMarkdownExtension: MarkdownExtension = {
  defineNodes: [{ name: 'WikiLink', style: tags.link }],
  parseInline: [wikiLinkInlineParser],
};

const htmlCommentInlineParser: InlineParser = {
  name: 'HtmlComment',
  before: 'Emphasis',
  parse(cx, next, pos) {
    if (next !== 60 || cx.char(pos + 1) !== 33 || cx.char(pos + 2) !== 45 || cx.char(pos + 3) !== 45) return -1;

    for (let index = pos + 4; index < cx.end - 2; index += 1) {
      const ch = cx.char(index);
      if (ch === 10 || ch === 13) return -1;
      if (ch === 45 && cx.char(index + 1) === 45 && cx.char(index + 2) === 62) {
        return cx.addElement(cx.elt('HtmlComment', pos, index + 3));
      }
    }

    return -1;
  },
};

const htmlCommentMarkdownExtension: MarkdownExtension = {
  defineNodes: [
    { name: 'HtmlComment', style: tags.comment },
    { name: 'HtmlCommentBlock', block: true, style: tags.comment },
  ],
  parseBlock: [
    {
      name: 'HtmlCommentBlock',
      parse(cx: BlockContext, line: Line) {
        if (!line.text.slice(line.pos).startsWith('<!--')) return false;

        const from = cx.lineStart + line.pos;

        while (!line.text.includes('-->') && cx.nextLine()) {}

        if (line.text.includes('-->')) {
          cx.nextLine();
        }

        const to = cx.prevLineEnd();
        cx.addElement(cx.elt('HtmlCommentBlock', from, to));
        return true;
      },
      before: 'SetextHeading',
    },
  ],
  parseInline: [htmlCommentInlineParser],
};

const highlightMarkupInlineParser: InlineParser = {
  name: 'HighlightMarkup',
  before: 'Emphasis',
  parse(cx, next, pos) {
    if (next !== 58 || cx.char(pos + 1) !== 58) return -1;
    const lineEnd = cx.text.indexOf('\n', pos);
    const sliceEnd = lineEnd === -1 ? cx.end : Math.min(cx.end, lineEnd);
    const match = parseHighlightMarkupAt(cx.text.slice(0, sliceEnd), pos);
    if (!match) return -1;
    return cx.addElement(
      cx.elt('HighlightMarkup', pos, match.to, [
        cx.elt('HighlightMark', pos, pos + 2),
        cx.elt('HighlightMark', match.closerFrom, match.closerTo),
      ]),
    );
  },
};

const highlightMarkupMarkdownExtension: MarkdownExtension = {
  defineNodes: [{ name: 'HighlightMarkup' }, { name: 'HighlightMark', style: tags.processingInstruction }],
  parseInline: [highlightMarkupInlineParser],
};

const markdownParserExtensions: MarkdownExtension = [
  {
    // Leaving HTML parsing enabled makes unfinished `<!--` comments
    // reclassify the remaining document and can cause severe typing lag.
    remove: ['HTMLBlock', 'HTMLTag'],
  },
  {
    // Keep IndentedCode removed so leading spaces stay editable prose and match
    // the renderer's custom indentation preservation instead of becoming code blocks.
    remove: ['SetextHeading', 'IndentedCode'],
  },
  htmlCommentMarkdownExtension,
  highlightMarkupMarkdownExtension,
  wikiLinkMarkdownExtension,
];

export const promptListAnsweringFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** Effect to toggle a collapsible prompt-list answer item by its first-line number. */
export const togglePromptListCollapseEffect = StateEffect.define<number>();

/** Set of first-line numbers of collapsed prompt-list answer items. */
export const promptListCollapseField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(collapsed, tr) {
    let next = collapsed;
    for (const effect of tr.effects) {
      if (effect.is(togglePromptListCollapseEffect)) {
        next = new Set(next);
        if (next.has(effect.value)) {
          next.delete(effect.value);
        } else {
          next.add(effect.value);
        }
      }
    }
    if (tr.docChanged && next.size > 0) {
      const mapping = tr.changes;
      const remapped = new Set<number>();
      for (const lineNum of next) {
        if (lineNum >= 1 && lineNum <= tr.startState.doc.lines) {
          const pos = tr.startState.doc.line(lineNum).from;
          const newPos = mapping.mapPos(pos, 1);
          const newLine = tr.newDoc.lineAt(newPos).number;
          remapped.add(newLine);
        }
      }
      next = remapped;
    }
    return next;
  },
});

function dispatchPromptListCollapseToggle(view: EditorView, lineNumber: number) {
  const state = view.state;
  const collapsed = state.field(promptListCollapseField).has(lineNumber);
  const item = findPromptListItems(state).find(
    (candidate) =>
      candidate.firstLine === lineNumber &&
      candidate.kind === 'answer' &&
      candidate.subtreeLastLine > candidate.firstLine,
  );

  if (collapsed || !item) {
    view.dispatch({ effects: togglePromptListCollapseEffect.of(lineNumber) });
    return;
  }

  const line = state.doc.line(lineNumber);
  const hiddenFrom = line.to;
  const hiddenTo = state.doc.line(item.subtreeLastLine).to;
  const selectionTouchesHiddenContent = state.selection.ranges.some(
    (range) => range.from < hiddenTo && range.to > hiddenFrom,
  );

  if (selectionTouchesHiddenContent) {
    view.dispatch({
      effects: togglePromptListCollapseEffect.of(lineNumber),
      selection: { anchor: hiddenFrom },
    });
    return;
  }

  view.dispatch({ effects: togglePromptListCollapseEffect.of(lineNumber) });
}

const disclosureMeta = new WeakMap<PromptListDisclosureWidget, { collapsed: boolean; lineNumber: number }>();

class PromptListDisclosureWidget extends WidgetType {
  constructor(collapsed: boolean, lineNumber: number) {
    super();
    disclosureMeta.set(this, { collapsed, lineNumber });
  }

  eq(other: PromptListDisclosureWidget): boolean {
    const a = disclosureMeta.get(this);
    const b = disclosureMeta.get(other);
    return a?.collapsed === b?.collapsed && a?.lineNumber === b?.lineNumber;
  }

  toDOM(view: EditorView): HTMLElement {
    const meta = disclosureMeta.get(this);
    const span = document.createElement('span');
    span.className = `cm-prompt-list-disclosure${meta?.collapsed ? ' cm-prompt-list-disclosure--collapsed' : ''}`;
    span.setAttribute('aria-label', meta?.collapsed ? 'Expand' : 'Collapse');
    span.textContent = meta?.collapsed ? '▶' : '▼';
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (meta) {
        dispatchPromptListCollapseToggle(view, meta.lineNumber);
      }
    });
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const collapsedSummaryMeta = new WeakMap<CollapsedPromptListWidget, { lineNumber: number }>();

class CollapsedPromptListWidget extends WidgetType {
  constructor(lineNumber: number) {
    super();
    collapsedSummaryMeta.set(this, { lineNumber });
  }

  eq(other: CollapsedPromptListWidget): boolean {
    return collapsedSummaryMeta.get(this)?.lineNumber === collapsedSummaryMeta.get(other)?.lineNumber;
  }

  toDOM(view: EditorView): HTMLElement {
    const meta = collapsedSummaryMeta.get(this);
    const wrapper = document.createElement('span');
    wrapper.append(' ');

    const link = document.createElement('a');
    link.className = 'cm-prompt-list-collapsed-summary';
    link.setAttribute('href', '#');
    link.textContent = 'More...';
    link.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (meta) {
        dispatchPromptListCollapseToggle(view, meta.lineNumber);
      }
    });
    wrapper.append(link);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const promptListHintMeta = new WeakMap<PromptListHintWidget, { label: string; className?: string }>();

class PromptListHintWidget extends WidgetType {
  constructor(label: string, className?: string) {
    super();
    promptListHintMeta.set(this, { label, className });
  }

  eq(other: PromptListHintWidget): boolean {
    const current = promptListHintMeta.get(this);
    const next = promptListHintMeta.get(other);
    return current?.label === next?.label && current?.className === next?.className;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    const meta = promptListHintMeta.get(this);
    span.className = meta?.className ? `cm-prompt-list-hint ${meta.className}` : 'cm-prompt-list-hint';
    span.textContent = meta?.label ?? '';
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface PromptListItemRange {
  firstLine: number;
  lastLine: number;
  subtreeLastLine: number;
  kind: 'question' | 'answer' | 'comment';
}

function countPromptListIndent(raw: string): number {
  let indent = 0;
  for (const char of raw) {
    if (char === ' ') {
      indent += 1;
      continue;
    }
    if (char === '\t') {
      indent += 2;
      continue;
    }
    break;
  }
  return indent;
}

function promptListDepths(indents: string[]): number[] {
  const widths = indents.map((indent) => countPromptListIndent(indent));
  const stack: number[] = [];
  const depths: number[] = [];

  for (const width of widths) {
    while (stack.length > 0 && stack[stack.length - 1] > width) stack.pop();
    if (stack.length === 0 || stack[stack.length - 1] < width) stack.push(width);
    depths.push(Math.max(0, stack.length - 1));
  }

  return depths;
}

function findPromptListItems(state: EditorState): PromptListItemRange[] {
  const items: PromptListItemRange[] = [];
  const lines = Array.from({ length: state.doc.lines }, (_, index) => state.doc.line(index + 1).text);

  for (let startLineIndex = 0; startLineIndex < lines.length; ) {
    const block = parsePromptListBlock(lines, startLineIndex);
    if (!block) {
      startLineIndex += 1;
      continue;
    }

    const depths = promptListDepths(block.items.map((item) => item.match.indent));
    const blockItems = block.items.map((item, index) => ({
      firstLine: item.startLineIndex + 1,
      lastLine: item.endLineIndex + 1,
      subtreeLastLine: item.endLineIndex + 1,
      kind: item.match.kind,
      depth: depths[index] ?? 0,
    }));

    for (let index = 0; index < blockItems.length; index += 1) {
      const current = blockItems[index];
      if (!current) continue;

      let subtreeBoundaryStartLine = block.endLineIndexExclusive + 1;
      for (let nextIndex = index + 1; nextIndex < blockItems.length; nextIndex += 1) {
        const next = blockItems[nextIndex];
        if (!next) continue;
        if (next.depth <= current.depth) {
          subtreeBoundaryStartLine = next.firstLine;
          break;
        }
      }
      current.subtreeLastLine = Math.max(current.lastLine, subtreeBoundaryStartLine - 1);
    }

    items.push(...blockItems.map(({ depth: _depth, ...item }) => item));
    startLineIndex = block.endLineIndexExclusive;
  }

  return items;
}

function buildPromptListDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const collapsed = state.field(promptListCollapseField);
  const items = findPromptListItems(state);

  const collapsibleAnswers = new Map<number, PromptListItemRange>();
  const collapsedRanges = new Map<number, PromptListItemRange>();
  const continuationKinds = new Map<number, 'answer' | 'comment'>();

  for (const item of items) {
    if ((item.kind === 'answer' || item.kind === 'comment') && item.lastLine > item.firstLine) {
      for (let lineNumber = item.firstLine + 1; lineNumber <= item.lastLine; lineNumber += 1) {
        const lineText = state.doc.line(lineNumber).text;
        if (/^\s*$/.test(lineText)) continue;
        continuationKinds.set(lineNumber, item.kind);
      }
    }

    if (item.kind !== 'answer' || item.subtreeLastLine <= item.firstLine) continue;
    collapsibleAnswers.set(item.firstLine, item);
    if (collapsed.has(item.firstLine)) {
      collapsedRanges.set(item.firstLine, item);
    }
  }

  const hiddenLines = new Set<number>();
  for (const item of collapsedRanges.values()) {
    for (let lineNumber = item.firstLine + 1; lineNumber <= item.subtreeLastLine; lineNumber += 1) {
      hiddenLines.add(lineNumber);
    }
  }

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const match = matchPromptListLine(line.text);

    if (!match) {
      const continuationKind = continuationKinds.get(lineNumber);
      if (!continuationKind || hiddenLines.has(lineNumber)) continue;
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          attributes: {
            class: continuationKind === 'answer' ? 'cm-prompt-answer-continuation' : 'cm-prompt-comment-continuation',
          },
        }),
      );
      continue;
    }

    if (hiddenLines.has(lineNumber)) continue;

    const classes = [
      'cm-prompt-list-item',
      match.kind === 'question'
        ? 'cm-prompt-question'
        : match.kind === 'answer'
          ? 'cm-prompt-answer'
          : 'cm-prompt-comment',
    ];

    builder.add(
      line.from,
      line.from,
      Decoration.line({
        attributes: {
          class: classes.join(' '),
        },
      }),
    );

    const collapsibleAnswer = collapsibleAnswers.get(lineNumber);
    if (collapsibleAnswer) {
      builder.add(
        line.from,
        line.from,
        Decoration.widget({
          widget: new PromptListDisclosureWidget(collapsedRanges.has(lineNumber), lineNumber),
          side: -1,
        }),
      );
    }

    builder.add(
      line.from + match.indent.length,
      line.from + match.markerEnd,
      Decoration.mark({
        class: 'cm-prompt-list-mark',
      }),
    );

    const collapsedItem = collapsedRanges.get(lineNumber);
    if (collapsedItem) {
      const lastLine = state.doc.line(collapsedItem.subtreeLastLine);
      builder.add(
        line.to,
        lastLine.to,
        Decoration.replace({
          widget: new CollapsedPromptListWidget(lineNumber),
        }),
      );
    }
  }

  return builder.finish();
}

function buildPromptListAtomicRanges(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const collapsed = state.field(promptListCollapseField);

  for (const item of findPromptListItems(state)) {
    if (item.kind !== 'answer' || item.subtreeLastLine <= item.firstLine || !collapsed.has(item.firstLine)) continue;

    const line = state.doc.line(item.firstLine);
    const lastLine = state.doc.line(item.subtreeLastLine);
    builder.add(line.to, lastLine.to, Decoration.replace({}));
  }

  return builder.finish();
}

const promptListLineClassExtension = StateField.define<DecorationSet>({
  create(state) {
    return buildPromptListDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.state.field(promptListCollapseField) !== tr.startState.field(promptListCollapseField)) {
      return buildPromptListDecorations(tr.state);
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const promptListAtomicRangesExtension = StateField.define<DecorationSet>({
  create(state) {
    return buildPromptListAtomicRanges(state);
  },
  update(ranges, tr) {
    if (tr.docChanged || tr.state.field(promptListCollapseField) !== tr.startState.field(promptListCollapseField)) {
      return buildPromptListAtomicRanges(tr.state);
    }
    return ranges;
  },
  provide: (f) => EditorView.atomicRanges.of((view) => view.state.field(f)),
});

export function promptListHintLabelForText(text: string, answering = false): string | null {
  const match = matchPromptListLine(text);
  if (!match) return null;
  if (match.kind === 'question') {
    return match.marker === '~' && !match.content.trim() ? EMPTY_PROMPT_QUESTION_PLACEHOLDER : null;
  }
  if (match.kind === 'answer' && answering && !match.content.trim()) return 'Answering... (Esc to cancel)';
  return null;
}

export function bracePromptHintLabelForText(text: string, position: number): string | null {
  return findBracePromptHintMatch(text, position) ? BRACE_PROMPT_HINT_LABEL : null;
}

export function bracePromptHintForText(
  text: string,
  position: number,
): { position: number; label: string; className: string } | null {
  const match = findBracePromptHintMatch(text, position);
  if (!match) return null;

  return {
    position: match.to,
    label: BRACE_PROMPT_HINT_LABEL,
    className: 'cm-brace-prompt-hint',
  };
}

export function bracePromptRangesForText(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];

  let searchFrom = 0;
  while (true) {
    const closeIndex = text.indexOf('}', searchFrom);
    if (closeIndex < 0) break;
    searchFrom = closeIndex + 1;

    const match = findBracePromptMatch(text, closeIndex + 1);
    if (match) ranges.push({ from: match.from, to: match.to });
  }

  return ranges;
}

function promptListHintLabel(
  view: EditorView,
): { position: number; label: string; className?: string; contextRanges?: Array<{ from: number; to: number }> } | null {
  if (view.state.facet(EditorState.readOnly)) return null;

  const selection = view.state.selection.main;
  const position = selection.empty ? selection.head : selection.to;

  const line = view.state.doc.lineAt(position);
  if (selection.empty) {
    const promptListLabel = promptListHintLabelForText(line.text, view.state.facet(promptListAnsweringFacet));
    if (promptListLabel) {
      return {
        position: line.to,
        label: promptListLabel,
      };
    }
  }

  const braceHint = bracePromptHintForText(line.text, position - line.from);
  if (!braceHint) return null;
  const documentText = view.state.doc.toString();
  const absoluteHintPosition = line.from + braceHint.position;
  if (isBracePromptBlockedInCode(view.state, absoluteHintPosition)) return null;

  if (!selection.empty) {
    const request = buildBracePromptRequest(documentText, absoluteHintPosition, {
      contextSelection: { from: selection.from, to: selection.to },
    });
    if (!request) return null;

    return {
      position: absoluteHintPosition,
      label: braceHint.label,
      className: braceHint.className,
    };
  }

  const contextRanges = bracePromptContextRangesForPosition(documentText, absoluteHintPosition);

  return {
    position: absoluteHintPosition,
    label: braceHint.label,
    className: braceHint.className,
    contextRanges: contextRanges ?? [{ from: line.from, to: line.from + braceHint.position }],
  };
}

function buildPromptListHintDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const answering = view.state.facet(promptListAnsweringFacet);

  if (answering) {
    for (const { from, to } of view.visibleRanges) {
      let lineNumber = view.state.doc.lineAt(from).number;
      const lastLineNumber = view.state.doc.lineAt(to).number;

      for (; lineNumber <= lastLineNumber; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        const label = promptListHintLabelForText(line.text, true);
        if (!label) continue;

        builder.add(
          line.to,
          line.to,
          Decoration.widget({
            widget: new PromptListHintWidget(label),
            side: 1,
          }),
        );
      }
    }

    return builder.finish();
  }

  const hint = promptListHintLabel(view);
  if (!hint) return builder.finish();

  if (hint.contextRanges) {
    for (const range of hint.contextRanges) {
      if (range.from >= range.to) continue;
      builder.add(
        range.from,
        range.to,
        Decoration.mark({
          class: 'cm-brace-prompt-context',
        }),
      );
    }
  }

  builder.add(
    hint.position,
    hint.position,
    Decoration.widget({
      widget: new PromptListHintWidget(hint.label, hint.className),
      side: 1,
    }),
  );

  return builder.finish();
}

function buildBracePromptDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    let lineNumber = view.state.doc.lineAt(from).number;
    const lastLineNumber = view.state.doc.lineAt(to).number;

    for (; lineNumber <= lastLineNumber; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      for (const range of bracePromptRangesForText(line.text)) {
        const absoluteTo = line.from + range.to;
        if (isBracePromptBlockedInCode(view.state, absoluteTo)) continue;
        builder.add(
          line.from + range.from,
          absoluteTo,
          Decoration.mark({
            class: 'cm-brace-prompt',
          }),
        );
      }
    }
  }

  return builder.finish();
}

function rangeTouchesSelection(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => {
    if (range.empty) return range.from >= from && range.from <= to;
    return range.from < to && range.to > from;
  });
}

const COLLAPSIBLE_INLINE_NODE_NAMES = new Set([
  'Link',
  'Emphasis',
  'StrongEmphasis',
  'Subscript',
  'Strikethrough',
  'HighlightMarkup',
]);

const CODE_NODE_NAMES = new Set(['FencedCode', 'InlineCode', 'CodeText', 'CodeMark']);

function hasAncestorNamed(
  node:
    | {
        name?: string;
        parent: unknown;
      }
    | null
    | undefined,
  names: ReadonlySet<string>,
): boolean {
  for (
    let current = node;
    current && typeof current === 'object';
    current =
      'parent' in current
        ? (current.parent as {
            name?: string;
            parent: unknown;
          } | null)
        : null
  ) {
    if (current.name && names.has(current.name)) return true;
  }
  return false;
}

function isCodePosition(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  return (
    hasAncestorNamed(tree.resolveInner(pos, 1), CODE_NODE_NAMES) ||
    hasAncestorNamed(tree.resolveInner(Math.max(0, pos - 1), -1), CODE_NODE_NAMES)
  );
}

function selectionTouchesAncestorRange(
  state: EditorState,
  parent: { from: number; to: number; parent: unknown } | null,
): boolean {
  for (
    let current = parent;
    current && typeof current === 'object';
    current =
      'parent' in current
        ? (current.parent as {
            from: number;
            to: number;
            parent: unknown;
          } | null)
        : null
  ) {
    if (!('from' in current) || !('to' in current) || !('name' in current)) continue;
    const name = (current as { name?: string }).name;
    if (!name || !COLLAPSIBLE_INLINE_NODE_NAMES.has(name)) continue;
    if (rangeTouchesSelection(state, current.from, current.to)) return true;
  }
  return false;
}

function buildCollapsedInlineMarkdownDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'URL' || node.name === 'LinkMark') {
          const parent = node.node.parent;
          if (!parent || parent.name !== 'Link') return;
          if (rangeTouchesSelection(view.state, parent.from, parent.to)) return;
          if (node.name === 'LinkMark') {
            const text = view.state.doc.sliceString(node.from, node.to);
            if (text === '[' || text === ']') {
              builder.add(
                node.from,
                node.to,
                Decoration.mark({
                  class: 'cm-collapsed-link-bracket',
                }),
              );
              return;
            }
          }
          builder.add(node.from, node.to, Decoration.replace({}));
          return;
        }

        if (node.name !== 'EmphasisMark' && node.name !== 'StrikethroughMark' && node.name !== 'SubscriptMark') return;
        const selectionTouchesNode = selectionTouchesAncestorRange(view.state, node.node.parent);
        if (!selectionTouchesNode) {
          builder.add(node.from, node.to, Decoration.replace({}));
        }
        if (node.name === 'SubscriptMark') {
          const parent = node.node.parent;
          if (parent && parent.name === 'Subscript' && node.from === parent.from && parent.to - parent.from > 2) {
            builder.add(
              node.to,
              parent.to - 1,
              Decoration.mark({
                class: 'cm-single-tilde-strikethrough',
              }),
            );
          }
        }
      },
    });
  }

  return builder.finish();
}

function buildDoubleColonHighlightDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const text = line.text;
    let cursor = 0;

    while (cursor < text.length) {
      const colonIndex = text.indexOf('::', cursor);
      if (colonIndex === -1) break;

      const absoluteFrom = line.from + colonIndex;
      cursor = colonIndex + 2;

      if (isCodePosition(view.state, absoluteFrom)) continue;

      const match = parseHighlightMarkupAt(text, colonIndex);
      if (!match) continue;

      const absoluteTo = line.from + match.to;
      const selected = rangeTouchesSelection(view.state, absoluteFrom, absoluteTo);

      if (!selected) {
        builder.add(line.from + match.openerFrom, line.from + match.openerTo, Decoration.replace({}));
      }
      builder.add(
        line.from + match.contentFrom,
        line.from + match.contentTo,
        Decoration.mark({ class: 'cm-double-colon-highlight' }),
      );
      if (!selected) {
        builder.add(line.from + match.closerFrom, line.from + match.closerTo, Decoration.replace({}));
      }

      cursor = match.to;
    }
  }

  return builder.finish();
}

const promptListHintExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildPromptListHintDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.heightChanged
      ) {
        this.decorations = buildPromptListHintDecorations(update.view);
        return;
      }

      if (update.startState.facet(promptListAnsweringFacet) !== update.state.facet(promptListAnsweringFacet)) {
        this.decorations = buildPromptListHintDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const bracePromptDecorationExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildBracePromptDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildBracePromptDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const collapsedLinkDecorationExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCollapsedInlineMarkdownDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildCollapsedInlineMarkdownDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const doubleColonHighlightDecorationExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDoubleColonHighlightDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDoubleColonHighlightDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

export function markdownEditorLanguageSupport() {
  return [
    markdown({
      base: markdownLanguage,
      completeHTMLTags: false,
      extensions: markdownParserExtensions,
    }),
    promptListCollapseField,
    promptListAtomicRangesExtension,
    doubleColonHighlightDecorationExtension,
    collapsedLinkDecorationExtension,
    criticMarkupDecorationExtension,
    bracePromptDecorationExtension,
    promptListLineClassExtension,
    promptListHintExtension,
  ];
}

export function markdownCodeLanguageSupport() {
  return [
    markdown({
      base: markdownLanguage,
      completeHTMLTags: false,
      extensions: [
        {
          // Keep IndentedCode removed here too so read-only markdown parsing stays
          // aligned with the editor and renderer behavior.
          remove: ['HTMLBlock', 'HTMLTag', 'IndentedCode'],
        },
        htmlCommentMarkdownExtension,
      ],
    }),
    promptListCollapseField,
    promptListAtomicRangesExtension,
    doubleColonHighlightDecorationExtension,
    collapsedLinkDecorationExtension,
    criticMarkupDecorationExtension,
    promptListLineClassExtension,
  ];
}
