import { markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorState } from '@codemirror/state';
import { getMarkdownListContext } from './markdown_editor_list_context.ts';

interface NormalizeSimpleWrappedParagraphPasteOptions {
  flattenParagraphs?: boolean;
  continuationPrefix?: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeStandaloneUrlPaste(pastedText: string): string | null {
  if (!/\s/u.test(pastedText)) return null;

  const trimmed = pastedText.trim();
  if (!trimmed) return null;

  if (trimmed !== pastedText && isHttpUrl(trimmed)) {
    return trimmed;
  }

  if (!/[\r\n\t ]/u.test(trimmed)) return null;

  const collapsed = trimmed.replace(/\s+/gu, '');
  if (collapsed !== trimmed && isHttpUrl(collapsed)) {
    return collapsed;
  }

  return null;
}

function flattenNormalizedParagraph(paragraph: string, lineBreak: string): string {
  const lines = paragraph.split(lineBreak);
  return lines.map((line, index) => (index === 0 ? line.trimEnd() : line.trim())).join(' ');
}

function flattenPlainParagraphsForPaste(text: string, lineBreak: string, continuationPrefix = ''): string | null {
  if (!/[\r\n]/u.test(text)) return null;

  const lines = text.replace(/\r\n?/gu, '\n').trim().split('\n');
  if (lines.length < 2) return null;

  const paragraphs: string[][] = [];
  let currentParagraph: string[] = [];
  let sawBlank = false;
  for (const line of lines) {
    if (line === '') {
      if (sawBlank) return null;
      if (currentParagraph.length === 0) return null;
      paragraphs.push(currentParagraph);
      currentParagraph = [];
      sawBlank = true;
      continue;
    }
    currentParagraph.push(line);
    sawBlank = false;
  }
  if (currentParagraph.length === 0) return null;
  paragraphs.push(currentParagraph);

  const firstLineStructural = /^(?:>|\s*[-*+]\s|\s*\d+\.\s|```)/u;
  const continuationStructural = /^(?:>|\s*[-*+]\s|```)/u;
  if (
    paragraphs.some(
      (paragraph) =>
        firstLineStructural.test(paragraph[0].trimStart()) ||
        paragraph.slice(1).some((line) => continuationStructural.test(line.trimStart())),
    )
  ) {
    return null;
  }

  return paragraphs
    .map((paragraph, index) => {
      const flattened = paragraph.map((line) => line.trim()).join(' ');
      return index === 0 ? flattened : `${continuationPrefix}${flattened}`;
    })
    .join(`${lineBreak}${lineBreak}`);
}

interface SimpleWrappedParagraphNormalization {
  baseIndent: number;
  hangingIndent: number;
  normalizedText: string;
}

function normalizeSimpleWrappedParagraph(
  lines: string[],
  lineBreak: string,
): SimpleWrappedParagraphNormalization | null {
  if (lines.length < 2 || lines.some((line) => line.trim() === '')) return null;

  const firstLineStructural = /^(?:>|\s*[-*+]\s|\s*\d+\.\s|```)/u;
  if (firstLineStructural.test(lines[0].trimStart())) return null;

  const continuationStructural = /^(?:>|\s*[-*+]\s|```)/u;
  if (lines.slice(1).some((line) => continuationStructural.test(line.trimStart()))) return null;

  const indents = lines.map((line) => line.match(/^ */u)?.[0].length ?? 0);
  const baseIndent = indents[0];
  const continuationIndents = indents.slice(1);
  const hangingIndent = Math.min(...continuationIndents) - baseIndent;
  if (hangingIndent < 1 || hangingIndent > 4) return null;
  if (
    continuationIndents.some((indent) => indent < baseIndent + hangingIndent || indent > baseIndent + hangingIndent + 1)
  ) {
    return null;
  }

  const normalizedLines = [lines[0], ...lines.slice(1).map((line) => line.slice(hangingIndent))];
  return { baseIndent, hangingIndent, normalizedText: normalizedLines.join(lineBreak) };
}

function normalizeSimpleWrappedContinuationParagraph(
  lines: string[],
  lineBreak: string,
  baseIndent: number,
  hangingIndent: number,
): string | null {
  if (lines.length < 1 || lines.some((line) => line.trim() === '')) return null;

  const firstLineStructural = /^(?:>|\s*[-*+]\s|\s*\d+\.\s|```)/u;
  if (firstLineStructural.test(lines[0].trimStart())) return null;

  const continuationStructural = /^(?:>|\s*[-*+]\s|```)/u;
  if (lines.slice(1).some((line) => continuationStructural.test(line.trimStart()))) return null;

  const minimumIndent = baseIndent + hangingIndent;
  const indents = lines.map((line) => line.match(/^ */u)?.[0].length ?? 0);
  if (indents.some((indent) => indent < minimumIndent || indent > minimumIndent + 1)) return null;

  return lines.map((line) => line.slice(hangingIndent)).join(lineBreak);
}

export function normalizeSimpleWrappedParagraphPaste(
  pastedText: string,
  options: NormalizeSimpleWrappedParagraphPasteOptions = {},
): string | null {
  if (!/[\r\n]/u.test(pastedText)) return null;

  const lineBreakMatch = pastedText.match(/\r\n|\r|\n/u);
  const lineBreak = lineBreakMatch?.[0] ?? '\n';
  const normalized = pastedText.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.length < 2) return null;

  const paragraphs: string[][] = [];
  let currentParagraph: string[] = [];
  let sawBlank = false;
  for (const line of lines) {
    if (line === '') {
      if (sawBlank) return null;
      if (currentParagraph.length === 0) return null;
      paragraphs.push(currentParagraph);
      currentParagraph = [];
      sawBlank = true;
      continue;
    }
    currentParagraph.push(line);
    sawBlank = false;
  }
  if (currentParagraph.length === 0) return null;
  paragraphs.push(currentParagraph);

  const firstParagraph = normalizeSimpleWrappedParagraph(paragraphs[0], lineBreak);
  if (firstParagraph === null) {
    if (!options.flattenParagraphs) return null;
    const flattenedPlainParagraphs = flattenPlainParagraphsForPaste(pastedText, lineBreak, options.continuationPrefix);
    return flattenedPlainParagraphs === pastedText ? null : flattenedPlainParagraphs;
  }

  const normalizedParagraphs = [firstParagraph.normalizedText];
  for (const paragraph of paragraphs.slice(1)) {
    const normalizedParagraph = normalizeSimpleWrappedContinuationParagraph(
      paragraph,
      lineBreak,
      firstParagraph.baseIndent,
      firstParagraph.hangingIndent,
    );
    if (normalizedParagraph === null) {
      if (!options.flattenParagraphs) return null;
      const flattenedPlainParagraphs = flattenPlainParagraphsForPaste(
        pastedText,
        lineBreak,
        options.continuationPrefix,
      );
      return flattenedPlainParagraphs === pastedText ? null : flattenedPlainParagraphs;
    }
    normalizedParagraphs.push(normalizedParagraph);
  }

  const outputParagraphs = options.flattenParagraphs
    ? normalizedParagraphs.map((paragraph, index) => {
        const flattened = flattenNormalizedParagraph(paragraph, lineBreak);
        return index === 0 ? flattened : `${options.continuationPrefix ?? ''}${flattened}`;
      })
    : normalizedParagraphs;
  const result = outputParagraphs.join(`${lineBreak}${lineBreak}`);
  if (result !== pastedText) return result;
  if (!options.flattenParagraphs) return null;
  const flattenedPlainParagraphs = flattenPlainParagraphsForPaste(pastedText, lineBreak, options.continuationPrefix);
  return flattenedPlainParagraphs === pastedText ? null : flattenedPlainParagraphs;
}

function looksLikeClaudeCodeHeader(lines: string[], startIndex: number): boolean {
  if (startIndex < 0 || startIndex + 2 >= lines.length) return false;
  if (!lines[startIndex]?.includes('Claude Code v')) return false;
  if (!lines[startIndex + 1]?.trim() || !lines[startIndex + 2]?.trim()) return false;
  return /[▐▛▜▌▝▘█]/u.test(`${lines[startIndex]}${lines[startIndex + 1]}`);
}

export function normalizeClaudeCodeTranscriptPaste(pastedText: string): string | null {
  if (!pastedText.includes('Claude Code v')) return null;

  const lineBreak = pastedText.match(/\r\n|\r|\n/u)?.[0] ?? '\n';
  const normalized = pastedText.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  const headerStartIndex = lines.findIndex((line) => line.trim().length > 0);
  if (!looksLikeClaudeCodeHeader(lines, headerStartIndex)) return null;

  const result = [
    ...lines.slice(0, headerStartIndex),
    '```',
    ...lines.slice(headerStartIndex, headerStartIndex + 3),
    '```',
    ...lines.slice(headerStartIndex + 3),
  ].join('\n');

  return result === normalized ? null : result.replace(/\n/g, lineBreak);
}

export function normalizeBlockquotePaste(state: EditorState, pos: number, text: string): string | null {
  if (!markdownLanguage.isActiveAt(state, pos, -1) && !markdownLanguage.isActiveAt(state, pos, 1)) return null;

  const line = state.doc.lineAt(pos);
  const context = getMarkdownListContext(state, pos);
  while (context.length && context[context.length - 1].from > pos - line.from) context.pop();

  const hasBlockquote = context.some((item) => item.node.name === 'Blockquote');
  if (!hasBlockquote) return null;

  const blockquotePrefix = context.map((item) => item.blank(null)).join('');

  const normalized = text.replace(/\r\n?/g, '\n');
  const trimmed = normalized.trim();
  const isSingleHttpUrl = /^https?:\/\/\S+$/.test(trimmed) && !normalized.includes('\n');
  if (isSingleHttpUrl && pos === line.to) {
    if (state.doc.sliceString(Math.max(line.from, pos - 2), pos) === '](') return null;
    return `[^src](${trimmed})`;
  }

  const shouldFlattenParagraphs = pos !== line.from;
  const normalizedParagraph =
    normalizeSimpleWrappedParagraphPaste(trimmed, {
      flattenParagraphs: shouldFlattenParagraphs,
      continuationPrefix: blockquotePrefix,
    }) ?? trimmed;
  const lines = normalizedParagraph.split('\n');
  if (!shouldFlattenParagraphs && lines.length < 2) return null;
  if (shouldFlattenParagraphs) return normalizedParagraph;

  return lines.map((segment, index) => (index === 0 ? segment : `${blockquotePrefix}${segment}`)).join(state.lineBreak);
}

export function formatMarkdownEditorPaste(state: EditorState, pastedText: string): string | null {
  const normalizedUrlPaste = normalizeStandaloneUrlPaste(pastedText);
  if (normalizedUrlPaste !== null) return normalizedUrlPaste;

  const normalizedClaudeCodePaste = normalizeClaudeCodeTranscriptPaste(pastedText);
  if (normalizedClaudeCodePaste !== null) return normalizedClaudeCodePaste;

  const normalizedBlockquotePaste = normalizeBlockquotePaste(state, state.selection.main.from, pastedText);
  if (normalizedBlockquotePaste !== null) return normalizedBlockquotePaste;

  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const lineIndent = line.text.match(/^[ \t]*/u)?.[0] ?? '';
  return normalizeSimpleWrappedParagraphPaste(pastedText, {
    flattenParagraphs: from !== line.from && (from === line.to || /^[ \t]+/u.test(line.text)),
    continuationPrefix: from !== line.from && /^[ \t]+/u.test(line.text) ? lineIndent : '',
  });
}
