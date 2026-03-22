import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, Facet, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { BlockContext, InlineParser, Line, MarkdownExtension } from '@lezer/markdown';
import { matchPromptListLine } from '../prompt_list_syntax.ts';
import { criticMarkupDecorationExtension } from './codemirror_criticmarkup.ts';
import { findBracePromptMatch } from './codemirror_inline_prompt.ts';

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
  wikiLinkMarkdownExtension,
];

export const promptListAnsweringFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

function isPromptListAnswerContinuationLine(text: string, indent: string): boolean {
  return text.startsWith(`${indent}  `) || text.startsWith(`${indent}\t`);
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

function buildPromptListDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let activePromptKind: 'question' | 'answer' | null = null;
  let activePromptIndent = '';

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const match = matchPromptListLine(line.text);
    if (!match) {
      if (activePromptKind === 'answer' && /^\s*$/.test(line.text)) continue;
      if (activePromptKind === 'answer' && isPromptListAnswerContinuationLine(line.text, activePromptIndent)) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: {
              class: 'cm-prompt-answer-continuation',
            },
          }),
        );
        continue;
      }

      activePromptKind = null;
      activePromptIndent = '';
      continue;
    }

    activePromptKind = match.kind;
    activePromptIndent = match.indent;

    const classes = ['cm-prompt-list-item', match.kind === 'question' ? 'cm-prompt-question' : 'cm-prompt-answer'];

    builder.add(
      line.from,
      line.from,
      Decoration.line({
        attributes: {
          class: classes.join(' '),
        },
      }),
    );

    builder.add(
      line.from + match.indent.length,
      line.from + match.markerEnd,
      Decoration.mark({
        class: 'cm-prompt-list-mark',
      }),
    );
  }

  return builder.finish();
}

const promptListLineClassExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildPromptListDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildPromptListDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

export function promptListHintLabelForText(text: string, answering = false): string | null {
  const match = matchPromptListLine(text);
  if (!match) return null;
  if (match.kind === 'question') return match.content.trim() ? null : 'Type to ask AI';
  if (match.kind === 'answer' && answering && !match.content.trim()) return 'Answering... (Esc to cancel)';
  return null;
}

export function bracePromptHintLabelForText(text: string, position: number): string | null {
  return findBracePromptMatch(text, position) ? '⇥' : null;
}

export function bracePromptHintForText(
  text: string,
  position: number,
): { position: number; label: string; className: string } | null {
  const match = findBracePromptMatch(text, position);
  if (!match) return null;

  return {
    position: match.to,
    label: '⇥',
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

function promptListHintLabel(view: EditorView): { position: number; label: string; className?: string } | null {
  if (view.state.facet(EditorState.readOnly)) return null;

  const selection = view.state.selection.main;
  if (!selection.empty) return null;

  const line = view.state.doc.lineAt(selection.head);
  const promptListLabel = promptListHintLabelForText(line.text, view.state.facet(promptListAnsweringFacet));
  if (promptListLabel) {
    return {
      position: line.to,
      label: promptListLabel,
    };
  }

  const braceHint = bracePromptHintForText(line.text, selection.head - line.from);
  if (!braceHint) return null;

  return {
    position: line.from + braceHint.position,
    label: braceHint.label,
    className: braceHint.className,
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
        builder.add(
          line.from + range.from,
          line.from + range.to,
          Decoration.mark({
            class: 'cm-brace-prompt',
          }),
        );
      }
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

export function markdownEditorLanguageSupport() {
  return [
    markdown({
      base: markdownLanguage,
      completeHTMLTags: false,
      extensions: markdownParserExtensions,
    }),
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
    criticMarkupDecorationExtension,
    promptListLineClassExtension,
  ];
}
