import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { parseCriticMarkupAt } from '../criticmarkup.ts';
import { READER_AI_SELECTION_MAX_CHARS } from '../reader_ai_limits.ts';

export interface InlinePromptMatch {
  from: number;
  to: number;
  prompt: string;
}

export interface InlinePromptRequest {
  prompt: string;
  from: number;
  to: number;
  documentContent: string;
}

export interface BracePromptChatMessage {
  role: 'user' | 'options';
  content: string;
}

export interface BracePromptRequest {
  prompt: string;
  from: number;
  to: number;
  documentContent: string;
  paragraphTail: string;
  mode: 'replace' | 'replace-with-paragraph-tail';
  candidateCount: number;
  excludeOptions: string[];
  chatMessages: BracePromptChatMessage[];
}

export interface BracePromptMatch {
  from: number;
  to: number;
  prompt: string;
  kind: 'single' | 'double';
}

interface BracePromptContextInfo {
  documentContent: string;
  ranges: Array<{ from: number; to: number }>;
}

const BRACE_PROMPT_BLOCKED_CODE_NODE_NAMES = new Set(['FencedCode', 'InlineCode', 'CodeText', 'CodeMark']);

function hasAncestorNamed(node: SyntaxNode | null, names: ReadonlySet<string>): boolean {
  for (let current = node; current; current = current.parent) {
    if (names.has(current.name)) return true;
  }
  return false;
}

export function lineRangeAt(text: string, position: number): { from: number; to: number } {
  let from = position;
  while (from > 0 && text[from - 1] !== '\n') from -= 1;
  let to = position;
  while (to < text.length && text[to] !== '\n') to += 1;
  return { from, to };
}

function findParagraphEnd(text: string, position: number): number {
  const originLineFrom = lineRangeAt(text, position).from;
  let lineStart = originLineFrom;
  while (lineStart < text.length) {
    const { from, to } = lineRangeAt(text, lineStart);
    const lineText = text.slice(from, to);
    if (from !== originLineFrom && lineText.trim().length === 0) return from;
    if (to >= text.length) return text.length;
    lineStart = to + 1;
  }
  return text.length;
}

function startsWithCriticMarkupLikeMarker(text: string): boolean {
  return /^[\t ]*[+\-=~>]/.test(text);
}

function isInlinePromptBoundary(char: string | undefined): boolean {
  return char == null || /\s|[([{<"'`]/.test(char);
}

export function findInlinePromptMatch(text: string, position: number): InlinePromptMatch | null {
  const prefix = text.slice(0, position);
  const slashIndex = prefix.lastIndexOf('/');
  if (slashIndex < 0) return null;
  if (!isInlinePromptBoundary(text[slashIndex - 1])) return null;
  if (/\s/.test(text[slashIndex + 1] ?? '')) return null;

  const prompt = text.slice(slashIndex + 1, position);
  if (prompt.trim().length === 0) return null;

  return {
    from: slashIndex,
    to: position,
    prompt,
  };
}

export function findBracePromptMatch(text: string, position: number): BracePromptMatch | null {
  if (position > 1 && text[position - 2] === '}') {
    const doubleMatch = findDoubleBracePromptMatch(text, position);
    if (doubleMatch) return doubleMatch;
  }

  return findSingleBracePromptMatch(text, position);
}

function findSingleBracePromptMatch(text: string, position: number): BracePromptMatch | null {
  if (position <= 1 || text[position - 1] !== '}') return null;

  const openIndex = text.lastIndexOf('{', position - 1);
  if (openIndex < 0) return null;
  if (text[openIndex - 1] === '{' || text[position] === '}') return null;
  if (parseCriticMarkupAt(text, openIndex)?.to === position) return null;
  if (text.indexOf('}', openIndex + 1) !== position - 1) return null;

  const prompt = text.slice(openIndex + 1, position - 1);
  if (prompt.includes('{') || prompt.includes('}')) return null;
  if (startsWithCriticMarkupLikeMarker(prompt)) return null;
  if (prompt.trim().length === 0) return null;

  return {
    from: openIndex,
    to: position,
    prompt,
    kind: 'single',
  };
}

function findDoubleBracePromptMatch(text: string, position: number): BracePromptMatch | null {
  if (position <= 3 || text[position - 1] !== '}' || text[position - 2] !== '}') return null;

  const openIndex = text.lastIndexOf('{{', position - 3);
  if (openIndex < 0) return null;
  if ((openIndex > 0 && text[openIndex - 1] === '{') || text[position] === '}') return null;
  if (text.indexOf('}}', openIndex + 2) !== position - 2) return null;

  const prompt = text.slice(openIndex + 2, position - 2);
  if (prompt.includes('{') || prompt.includes('}')) return null;
  if (startsWithCriticMarkupLikeMarker(prompt)) return null;
  if (prompt.trim().length === 0) return null;

  return {
    from: openIndex,
    to: position,
    prompt,
    kind: 'double',
  };
}

function isMarkdownHeaderLine(text: string): boolean {
  return /^#{1,6}(?:\s|$)/.test(text.trim());
}

function isMarkdownDividerLine(text: string): boolean {
  return /^-{3,}$/.test(text.trim());
}

function buildDoubleBracePromptContext(
  documentText: string,
  from: number,
  to: number,
  maxChars = READER_AI_SELECTION_MAX_CHARS,
): BracePromptContextInfo {
  const directiveLine = lineRangeAt(documentText, from);
  let boundaryStart = 0;
  let preserveHeader = false;
  let scanStart = directiveLine.from;

  while (scanStart > 0) {
    const previousLine = lineRangeAt(documentText, scanStart - 1);
    const previousLineText = documentText.slice(previousLine.from, previousLine.to);
    if (isMarkdownHeaderLine(previousLineText)) {
      boundaryStart = previousLine.from;
      preserveHeader = true;
      break;
    }
    if (isMarkdownDividerLine(previousLineText)) {
      boundaryStart = Math.min(documentText.length, previousLine.to + 1);
      break;
    }
    scanStart = previousLine.from;
  }

  const scopedContext = documentText.slice(boundaryStart, to);
  if (scopedContext.length <= maxChars) {
    return {
      documentContent: scopedContext,
      ranges: [{ from: boundaryStart, to }],
    };
  }
  if (!preserveHeader) {
    const contextFrom = to - maxChars;
    return {
      documentContent: scopedContext.slice(scopedContext.length - maxChars),
      ranges: [{ from: contextFrom, to }],
    };
  }

  const headerLine = lineRangeAt(documentText, boundaryStart);
  const headerEnd = headerLine.to < to && documentText[headerLine.to] === '\n' ? headerLine.to + 1 : headerLine.to;
  const headerPrefix = documentText.slice(boundaryStart, Math.min(headerEnd, to));
  if (headerPrefix.length >= maxChars) {
    return {
      documentContent: headerPrefix.slice(0, maxChars),
      ranges: [{ from: boundaryStart, to: boundaryStart + maxChars }],
    };
  }

  const elided = to - (maxChars - headerPrefix.length) > headerEnd;
  const separatorLen = elided ? 1 : 0;
  const tailBudget = maxChars - headerPrefix.length - separatorLen;
  const tailFrom = Math.max(Math.min(headerEnd, to), to - tailBudget);
  const tailSlice = documentText.slice(tailFrom, to);
  const documentContent = elided ? `${headerPrefix}\n${tailSlice}` : `${headerPrefix}${tailSlice}`;
  return {
    documentContent,
    ranges: [
      { from: boundaryStart, to: Math.min(headerEnd, to) },
      { from: tailFrom, to },
    ],
  };
}

function buildBracePromptContextInfo(
  documentText: string,
  lineFrom: number,
  from: number,
  to: number,
  kind: BracePromptMatch['kind'],
): BracePromptContextInfo {
  if (kind === 'double') return buildDoubleBracePromptContext(documentText, from, to);
  return {
    documentContent: documentText.slice(0, to),
    ranges: [{ from: lineFrom, to }],
  };
}

export function isBracePromptBlockedInCode(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  return (
    hasAncestorNamed(tree.resolveInner(pos, 1), BRACE_PROMPT_BLOCKED_CODE_NODE_NAMES) ||
    hasAncestorNamed(tree.resolveInner(Math.max(0, pos - 1), -1), BRACE_PROMPT_BLOCKED_CODE_NODE_NAMES)
  );
}

export function buildBracePromptRequest(
  documentText: string,
  position: number,
  options?: { includeParagraphTail?: boolean },
): BracePromptRequest | null {
  const line = lineRangeAt(documentText, position);
  const match = findBracePromptMatch(documentText.slice(line.from, line.to), position - line.from);
  if (!match) return null;

  const from = line.from + match.from;
  const to = line.from + match.to;
  const context = buildBracePromptContextInfo(documentText, line.from, from, to, match.kind);
  const paragraphTail = options?.includeParagraphTail
    ? documentText.slice(to, findParagraphEnd(documentText, to)).replace(/\n+$/, '')
    : '';
  return {
    prompt: match.prompt,
    from,
    to,
    documentContent: context.documentContent,
    paragraphTail,
    mode: paragraphTail ? 'replace-with-paragraph-tail' : 'replace',
    candidateCount: 5,
    excludeOptions: [],
    chatMessages: [],
  };
}

export function bracePromptContextRangesForPosition(
  documentText: string,
  position: number,
): Array<{ from: number; to: number }> | null {
  const line = lineRangeAt(documentText, position);
  const match = findBracePromptMatch(documentText.slice(line.from, line.to), position - line.from);
  if (!match) return null;

  const from = line.from + match.from;
  const to = line.from + match.to;
  return buildBracePromptContextInfo(documentText, line.from, from, to, match.kind).ranges.filter(
    (range) => range.from < range.to,
  );
}

function inlinePromptCompletion(prompt: string, onSubmitPrompt: (request: InlinePromptRequest) => void): Completion {
  return {
    label: prompt,
    detail: 'AI',
    type: 'text',
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      onSubmitPrompt({
        prompt,
        from,
        to,
        documentContent: view.state.doc.toString(),
      });
    },
  };
}

export function inlinePromptCompletionSource(
  onSubmitPrompt: (request: InlinePromptRequest) => void,
): (context: CompletionContext) => CompletionResult | null {
  return (context: CompletionContext) => {
    const { state, pos, explicit } = context;
    const line = state.doc.lineAt(pos);
    const match = findInlinePromptMatch(line.text, pos - line.from);
    if (!match) return null;
    if (!explicit && match.prompt.trim().length === 0) return null;

    return {
      from: line.from + match.from,
      to: line.from + match.to,
      options: [inlinePromptCompletion(match.prompt, onSubmitPrompt)],
      filter: false,
    };
  };
}
