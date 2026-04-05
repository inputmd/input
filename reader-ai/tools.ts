// ── Reader AI Tool Definitions, Execution, and Editing ──

import { createTwoFilesPatch } from 'diff';
import type {
  DocumentEditState,
  DocumentReadSnapshot,
  OpenRouterMessage,
  StagedChange,
  StagedHunk,
  StagedHunkLine,
} from './types.ts';

export const READER_AI_TOOL_RESULT_MAX_CHARS = 30_000;
export const READER_AI_DOC_PREVIEW_CHARS = 12_000;
export const READER_AI_MAX_CONCURRENT_TASKS = 4;
export const READER_AI_MAX_REGEX_PATTERN_LENGTH = 200;
const SPLIT_HUNK_CONTEXT_LINES = 3;

/**
 * Rough token estimate from character count.
 * ~3.5 chars per token for English text / code is a reasonable approximation.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

/**
 * Estimate token usage of an OpenRouter messages array.
 * This is deliberately rough — used for budget decisions, not billing.
 */
export function estimateMessagesTokens(messages: OpenRouterMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if ('content' in msg && typeof msg.content === 'string') {
      chars += msg.content.length;
    }
    if ('tool_calls' in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        chars += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0) + 20;
      }
    }
  }
  return estimateTokens(chars);
}

/**
 * Compact old tool result messages in the conversation when approaching
 * the context budget. Replaces lengthy tool results from earlier turns
 * with short summaries, preserving the most recent results in full.
 *
 * Returns the number of chars reclaimed.
 */
export function compactToolResults(messages: OpenRouterMessage[], preserveRecentToolResults: number): number {
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if ('role' in msg && msg.role === 'tool' && 'tool_call_id' in msg) {
      toolResultIndices.push(i);
    }
  }

  const toCompact =
    preserveRecentToolResults > 0 ? toolResultIndices.slice(0, -preserveRecentToolResults) : toolResultIndices;
  let reclaimed = 0;

  for (const idx of toCompact) {
    const msg = messages[idx] as { role: 'tool'; tool_call_id: string; content: string };
    const original = msg.content;
    if (original.length <= 200) continue;

    const compacted = `${original.slice(0, 100)}… [${original.length} chars, compacted]`;
    reclaimed += original.length - compacted.length;
    (messages[idx] as { role: 'tool'; tool_call_id: string; content: string }).content = compacted;
  }

  return reclaimed;
}

// ── Tool argument parsing and repair ──

export interface ToolArgumentsParseResult {
  parsedArgs?: Record<string, unknown>;
  repairedArgs?: string;
  message?: string;
  error?: string;
}

function stripMarkdownCodeFence(raw: string): string {
  return raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
}

function extractLikelyJsonObject(raw: string): string {
  const objectStart = raw.indexOf('{');
  const objectEnd = raw.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) return raw.slice(objectStart, objectEnd + 1);
  return raw;
}

function balanceJsonDelimiters(raw: string): string {
  let result = raw;
  const braceBalance = [...raw].reduce((sum, ch) => sum + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
  const bracketBalance = [...raw].reduce((sum, ch) => sum + (ch === '[' ? 1 : ch === ']' ? -1 : 0), 0);
  if (braceBalance > 0) result += '}'.repeat(braceBalance);
  if (bracketBalance > 0) result += ']'.repeat(bracketBalance);
  return result;
}

function parseToolArgsObject(raw: string): Record<string, unknown> | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export function parseReaderAiToolArguments(argsJson: string): ToolArgumentsParseResult {
  const raw = argsJson.trim();
  if (!raw) return { parsedArgs: {} };
  try {
    const parsedArgs = parseToolArgsObject(raw);
    if (parsedArgs) return { parsedArgs };
    return { error: 'arguments must be a JSON object' };
  } catch (error) {
    const candidates = new Set<string>();
    candidates.add(raw);
    candidates.add(stripMarkdownCodeFence(raw));
    candidates.add(extractLikelyJsonObject(stripMarkdownCodeFence(raw)));
    for (const candidate of [...candidates]) {
      if (!candidate) continue;
      const normalized = balanceJsonDelimiters(candidate.replace(/,\s*([}\]])/g, '$1').trim());
      if (!normalized || normalized === raw) continue;
      try {
        const parsedArgs = parseToolArgsObject(normalized);
        if (parsedArgs) {
          return {
            parsedArgs,
            repairedArgs: normalized,
            message: 'Repaired malformed JSON arguments automatically.',
          };
        }
      } catch {
        // try next candidate
      }
    }
    return {
      error: error instanceof Error ? error.message : 'invalid JSON arguments',
    };
  }
}

export function repairToolArgumentsJson(argsJson: string): string | null {
  const result = parseReaderAiToolArguments(argsJson);
  return result.repairedArgs ?? null;
}

export function parseToolArgumentsWithRepair(argsJson: string): {
  parsedArgs?: Record<string, unknown>;
  repaired: boolean;
  error?: string;
} {
  const result = parseReaderAiToolArguments(argsJson);
  return {
    parsedArgs: result.parsedArgs,
    repaired: Boolean(result.repairedArgs),
    error: result.error,
  };
}

// ── Tool definitions ──

export const READER_AI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_document',
      description:
        'Read the document content. Returns line-numbered text. Without arguments returns the full document; use start_line/end_line for specific sections. For short documents the full text is already in the system prompt — only call this tool if you need content beyond what is already visible. When document edit state exists, the result also states whether you are reading the original or staged document, the current staged revision, total lines, and whether a proposal is pending. Before a paragraph or block edit, read the exact affected span immediately before proposing the edit. When using old_text/new_text, copy old_text from the latest read_document result rather than from memory or search results.',
      parameters: {
        type: 'object' as const,
        properties: {
          start_line: {
            type: 'number' as const,
            description: 'First line to return (1-based, inclusive). Omit to start from the beginning.',
          },
          end_line: {
            type: 'number' as const,
            description: 'Last line to return (1-based, inclusive). Omit to read to the end.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_document',
      description:
        'Search the document for lines matching a query. By default uses case-insensitive substring matching. Set is_regex to true for regular expression matching. Returns matching lines with surrounding context and line numbers.',
      parameters: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string' as const,
            description: 'Text to search for, or a regular expression pattern if is_regex is true.',
          },
          is_regex: {
            type: 'boolean' as const,
            description: 'If true, treat query as a regular expression. Default: false.',
          },
          context_lines: {
            type: 'number' as const,
            description: 'Lines of context before/after each match (default: 2, max: 10)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_edit_document',
      description:
        'Propose an edit to the current document. Supports two primary modes: exact-text replacement with old_text/new_text (preferred when the target text is stable and you can provide a unique match copied from a fresh read_document call) and guarded line-range replacement with start_line/end_line/new_text plus required expected_old_text (preferred when you know exact positions from a fresh read_document call). new_text is optional: omit it to delete the matched content (equivalent to setting it to an empty string). Whitespace and blank lines are literal: they are preserved or removed only if they are included in old_text/new_text or in the selected line range. Batched edits via edits[] are atomic; if any edit fails, nothing is applied and the tool returns structured JSON like { ok: false, tool: "propose_edit_document", error: { code, message, details, next_action }, document_state }. For paragraph or block edits, prefer a single atomic exact-text replacement after reading the target span. Line-range edits require expected_old_text and an explicit dry_run value so the intent is unambiguous. Proposed changes are shown to the user for approval or rejection. Returns structured JSON including diff, document_state, and actionable errors.',
      parameters: {
        type: 'object' as const,
        properties: {
          old_text: {
            type: 'string' as const,
            description:
              'The exact text to find and replace. It must match exactly and be unique in the document. Copy this from the latest read_document result, and prefer including the full paragraph or enough surrounding text to guarantee a unique match.',
          },
          new_text: {
            type: 'string' as const,
            description:
              'Replacement text. Omit to delete the matched content (defaults to empty string). Whitespace and newlines are literal.',
          },
          start_line: {
            type: 'number' as const,
            description:
              'First line to replace (1-based, inclusive). Use with end_line and new_text when you know the exact positions from a fresh read_document call.',
          },
          end_line: {
            type: 'number' as const,
            description:
              'Last line to replace (1-based, inclusive). Use with start_line and new_text when you know the exact positions from a fresh read_document call.',
          },
          expected_old_text: {
            type: 'string' as const,
            description:
              'Exact text currently expected between start_line and end_line, copied from a fresh read_document call. For line-range edits this is required. If the current lines differ, the edit fails instead of applying to stale line numbers.',
          },
          dry_run: {
            type: 'boolean' as const,
            description:
              'If true, preview the diff without applying changes to staged document content. For line-range edits, you must set this explicitly to true or false.',
          },
          edits: {
            type: 'array' as const,
            description:
              'Optional atomic batch of edits. Each item supports either old_text/new_text or start_line/end_line/new_text with required expected_old_text for line-range edits. If any edit fails, none are applied and the tool returns { ok: false, tool: "propose_edit_document", error: { code, message, details, next_action }, document_state }.',
            items: {
              type: 'object' as const,
              properties: {
                old_text: { type: 'string' as const },
                new_text: { type: 'string' as const },
                start_line: { type: 'number' as const },
                end_line: { type: 'number' as const },
                expected_old_text: { type: 'string' as const },
              },
            },
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task',
      description:
        'Spawn an independent subagent with its own system prompt and context. The subagent runs a separate LLM session and returns its full output. Use this only when the user explicitly asks for a subagent-style workflow or a skill/instruction explicitly requires one, or when a distinct specialized role is clearly necessary. The subagent has access to read_document and search_document for the same document. Multiple task calls in the same turn run in parallel (up to 4).',
      parameters: {
        type: 'object' as const,
        properties: {
          prompt: {
            type: 'string' as const,
            description:
              'The full prompt for the subagent. Include its role, instructions, and what output you expect. This becomes the user message in a fresh conversation.',
          },
          system_prompt: {
            type: 'string' as const,
            description:
              'Optional system prompt override for the subagent. If omitted, the subagent gets a minimal system prompt with document access instructions.',
          },
        },
        required: ['prompt'],
      },
    },
  },
];

/** Subagent tools — subset available to task subagents (no nested task spawning, no editing). */
export const READER_AI_SUBAGENT_TOOLS = READER_AI_TOOLS.filter(
  (t) => t.function.name !== 'task' && t.function.name !== 'propose_edit_document',
);

// ── Tool execution ──

function buildReadDocumentSnapshot(
  source: string,
  lines: string[],
  start: number,
  numbered: string[],
  truncated: boolean,
): DocumentReadSnapshot {
  const visibleLineCount = Math.max(0, numbered.length);
  const endLine = visibleLineCount > 0 ? start + visibleLineCount - 1 : start;
  return {
    startLine: start,
    endLine,
    visibleText: lines.slice(start - 1, start - 1 + visibleLineCount).join('\n'),
    sourceAtRead: source,
    truncated,
  };
}

export function executeReaderAiReadDocument(
  lines: string[],
  args: { start_line?: number; end_line?: number },
  state?: DocumentEditState,
): string {
  const total = lines.length;
  const start = Math.max(1, Math.floor(args.start_line ?? 1));
  const end = Math.min(total, Math.floor(args.end_line ?? total));
  if (start > total) return `(start_line ${start} is beyond the document, which has ${total} lines)`;
  if (start > end) return `(invalid range: start_line ${start} > end_line ${end})`;
  const selected = lines.slice(start - 1, end);
  const numbered = selected.map((line, i) => `${start + i}: ${line}`);
  const stateHeader = state
    ? (() => {
        const summary = summarizeDocumentState(state);
        return `(${summary.current_document} document; staged revision ${summary.staged_revision}; ${summary.total_lines} total lines; proposal state: ${summary.proposal_state})\n`;
      })()
    : '';
  const result = numbered.join('\n');
  if (result.length > READER_AI_TOOL_RESULT_MAX_CHARS) {
    let charCount = 0;
    let lastFittingLine = start;
    for (let i = 0; i < numbered.length; i++) {
      charCount += numbered[i].length + 1;
      if (charCount > READER_AI_TOOL_RESULT_MAX_CHARS) break;
      lastFittingLine = start + i;
    }
    const truncatedResult =
      result.slice(0, READER_AI_TOOL_RESULT_MAX_CHARS) +
      `\n\n... (truncated; showing lines ${start}-${lastFittingLine} of ${total}; use start_line/end_line to read specific ranges)`;
    if (state) {
      state.lastReadSnapshot = buildReadDocumentSnapshot(
        state.source,
        lines,
        start,
        numbered.slice(0, lastFittingLine - start + 1),
        true,
      );
    }
    return stateHeader + truncatedResult;
  }
  if (state) {
    state.lastReadSnapshot = buildReadDocumentSnapshot(state.source, lines, start, numbered, false);
  }
  return stateHeader + result;
}

export function executeReaderAiSearchDocument(
  lines: string[],
  args: { query: string; is_regex?: boolean; context_lines?: number },
): string {
  if (!args.query) return '(query is required)';
  const matcher = buildLineMatcher(args.query, args.is_regex);
  if (!matcher) return `(invalid regular expression: ${args.query})`;
  const ctx = Math.max(0, Math.min(args.context_lines ?? 2, 10));
  const matchIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matcher(lines[i])) matchIndices.push(i);
  }
  if (matchIndices.length === 0) return 'No matches found.';

  const ranges: Array<[number, number]> = [];
  for (const idx of matchIndices) {
    const rStart = Math.max(0, idx - ctx);
    const rEnd = Math.min(lines.length - 1, idx + ctx);
    if (ranges.length > 0 && rStart <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = rEnd;
    } else {
      ranges.push([rStart, rEnd]);
    }
  }

  const matchSet = new Set(matchIndices);
  const parts: string[] = [`${matchIndices.length} match${matchIndices.length === 1 ? '' : 'es'} found.\n`];
  for (const [rStart, rEnd] of ranges) {
    for (let i = rStart; i <= rEnd; i++) {
      const marker = matchSet.has(i) ? '>' : ' ';
      parts.push(`${marker} ${i + 1}: ${lines[i]}`);
    }
    parts.push('---');
  }

  const result = parts.join('\n');
  if (result.length > READER_AI_TOOL_RESULT_MAX_CHARS) {
    return `${result.slice(0, READER_AI_TOOL_RESULT_MAX_CHARS)}\n\n... (too many matches, try a more specific query)`;
  }
  return result;
}

/** Build a line-matching function from query + is_regex flag. Returns null on invalid regex. */
function buildLineMatcher(query: string, isRegex?: boolean): ((line: string) => boolean) | null {
  if (isRegex) {
    if (query.length > READER_AI_MAX_REGEX_PATTERN_LENGTH) return null;
    try {
      const re = new RegExp(query, 'iv');
      return (line: string) => re.test(line);
    } catch {
      try {
        const re = new RegExp(query, 'i');
        return (line: string) => re.test(line);
      } catch {
        return null;
      }
    }
  }
  const lower = query.toLowerCase();
  return (line: string) => line.toLowerCase().includes(lower);
}

/** Execute a synchronous (non-task) tool — document mode. */
export function executeReaderAiSyncTool(toolName: string, argsJson: string, lines: string[]): string {
  return executeReaderAiSyncToolWithState(toolName, argsJson, { lines });
}

export function executeReaderAiSyncToolWithState(
  toolName: string,
  argsJson: string,
  context: { lines: string[]; state?: DocumentEditState },
): string {
  const parsed = parseReaderAiToolArguments(argsJson);
  const args = parsed.parsedArgs;
  if (!args) {
    return `(invalid JSON arguments: ${parsed.error ?? argsJson})`;
  }
  const activeLines = context.state?.lines ?? context.lines;
  switch (toolName) {
    case 'read_document':
      return executeReaderAiReadDocument(
        activeLines,
        args as { start_line?: number; end_line?: number },
        context.state,
      );
    case 'search_document':
      return executeReaderAiSearchDocument(
        activeLines,
        args as { query: string; is_regex?: boolean; context_lines?: number },
      );
    default:
      return `(unknown tool: ${toolName})`;
  }
}

// ── Diff and staged changes ──

/** Generate a unified diff between two strings using the `diff` library. */
export function generateUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldContent, newContent, undefined, undefined, {
    context: 3,
  });
  const lines = patch.split('\n');
  const startIndex = lines.findIndex((l) => l.startsWith('---'));
  if (startIndex < 0) return '(no changes)';
  if (!lines.some((l) => l.startsWith('@@'))) return '(no changes)';
  const result = lines.slice(startIndex).join('\n').trimEnd();
  return result || '(no changes)';
}

function stagedChangeId(path: string): string {
  return `staged:${encodeURIComponent(path)}`;
}

function formatUnifiedHunkHeader(oldStart: number, oldLines: number, newStart: number, newLines: number): string {
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
}

function countOriginalLines(lines: StagedHunkLine[]): number {
  return lines.filter((line) => line.type !== 'add').length;
}

function countModifiedLines(lines: StagedHunkLine[]): number {
  return lines.filter((line) => line.type !== 'del').length;
}

function isMarkdownFenceMarker(content: string): boolean {
  return /^ {0,3}(?:```|~~~)/.test(content);
}

function isMarkdownListItemStart(content: string): boolean {
  return /^(?: {0,3}(?:[-*+]|\d+[.)]))\s+/.test(content);
}

function isMarkdownListContinuation(content: string): boolean {
  return /^(?: {2,}|\t+)/.test(content) && content.trim().length > 0 && !isMarkdownListItemStart(content);
}

function isMarkdownBlockquoteContent(content: string): boolean {
  return /^>\s*\S/.test(content);
}

function isMarkdownTableRow(content: string): boolean {
  return /^\|(?:[^|\n]*\|)+\s*$/.test(content.trim());
}

function isMarkdownHeading(content: string): boolean {
  return /^#{1,6}\s+\S/.test(content);
}

function isPlainParagraphLine(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return !isMarkdownBlockStart(content) && !isMarkdownListContinuation(content) && !/^(?: {4}|\t)/.test(content);
}

function looksLikeParagraphContinuation(previous: string, next: string): boolean {
  return (
    isPlainParagraphLine(previous) &&
    isPlainParagraphLine(next) &&
    /[.!?:]"?$/.test(previous.trim()) &&
    /^[A-Z0-9]/.test(next.trim())
  );
}

function isMarkdownBlockStart(content: string): boolean {
  return (
    isMarkdownFenceMarker(content) ||
    isMarkdownHeading(content) ||
    isMarkdownListItemStart(content) ||
    isMarkdownBlockquoteContent(content) ||
    isMarkdownTableRow(content)
  );
}

function isProtectedMarkdownBoundary(previous: string, next: string): boolean {
  if (previous.trim().length === 0 || next.trim().length === 0) return false;
  if (
    (isMarkdownListItemStart(previous) && isMarkdownListContinuation(next)) ||
    (isMarkdownListContinuation(previous) && isMarkdownListContinuation(next))
  ) {
    return true;
  }
  if (isMarkdownBlockquoteContent(previous) && isMarkdownBlockquoteContent(next)) return true;
  if (isMarkdownTableRow(previous) && isMarkdownTableRow(next)) return true;
  if (isMarkdownHeading(previous) && !isMarkdownBlockStart(next)) return true;
  if (looksLikeParagraphContinuation(previous, next)) return true;
  return false;
}

function buildInsideFenceState(lines: StagedHunkLine[]): boolean[] {
  const insideFenceByLine: boolean[] = [];
  let insideFence = false;

  for (const line of lines) {
    insideFenceByLine.push(insideFence);
    if (line.type === 'context' && isMarkdownFenceMarker(line.content)) {
      insideFence = !insideFence;
    }
  }

  return insideFenceByLine;
}

function chooseGapSplitPoint(
  lines: StagedHunkLine[],
  gapStart: number,
  gapEndExclusive: number,
  insideFenceByLine: boolean[],
): number | null {
  const gapLines = lines.slice(gapStart, gapEndExclusive);
  const gap = gapLines.length;
  if (gap <= 0) return 0;
  if (insideFenceByLine[gapStart] || gapLines.some((line) => isMarkdownFenceMarker(line.content))) return null;

  const minTrailing = Math.max(0, gap - SPLIT_HUNK_CONTEXT_LINES);
  const maxTrailing = Math.min(SPLIT_HUNK_CONTEXT_LINES, gap);
  let bestSplitPoint = minTrailing;
  let bestStructuralScore = Number.NEGATIVE_INFINITY;
  let bestCenterDistance = Number.POSITIVE_INFINITY;

  for (let splitPoint = minTrailing; splitPoint <= maxTrailing; splitPoint += 1) {
    const previous = gapLines[splitPoint - 1]?.content ?? '';
    const next = gapLines[splitPoint]?.content ?? '';
    if (splitPoint > 0 && splitPoint < gap && isProtectedMarkdownBoundary(previous, next)) continue;

    const hasBlankBoundary = (splitPoint > 0 && previous === '') || (splitPoint < gap && next === '');
    const structuralScore = hasBlankBoundary ? 3 : next && isMarkdownBlockStart(next) ? 2 : 0;
    const centerDistance = Math.abs(splitPoint - gap / 2);

    if (
      structuralScore > bestStructuralScore ||
      (structuralScore === bestStructuralScore && centerDistance < bestCenterDistance)
    ) {
      bestSplitPoint = splitPoint;
      bestStructuralScore = structuralScore;
      bestCenterDistance = centerDistance;
    }
  }

  if (bestStructuralScore === Number.NEGATIVE_INFINITY) return null;
  return bestSplitPoint;
}

function spanTouchesOnlyBlankLines(lines: StagedHunkLine[], start: number, end: number): boolean {
  return lines.slice(start, end + 1).every((line) => line.content.trim().length === 0);
}

function gapContainsOnlyBlankContext(lines: StagedHunkLine[], gapStart: number, gapEndExclusive: number): boolean {
  return lines
    .slice(gapStart, gapEndExclusive)
    .every((line) => line.type === 'context' && line.content.trim().length === 0);
}

function splitParsedUnifiedDiffHunk(hunk: StagedHunk): StagedHunk[] {
  const rawChangeSpans: Array<{ start: number; end: number }> = [];
  let currentChangeStart: number | null = null;

  for (let index = 0; index < hunk.lines.length; index += 1) {
    const line = hunk.lines[index];
    if (line?.type === 'context') {
      if (currentChangeStart !== null) {
        rawChangeSpans.push({ start: currentChangeStart, end: index - 1 });
        currentChangeStart = null;
      }
      continue;
    }
    if (currentChangeStart === null) currentChangeStart = index;
  }

  if (currentChangeStart !== null) {
    rawChangeSpans.push({ start: currentChangeStart, end: hunk.lines.length - 1 });
  }

  if (rawChangeSpans.length <= 1) return [hunk];

  const insideFenceByLine = buildInsideFenceState(hunk.lines);
  const changeSpans: Array<{ start: number; end: number }> = [];
  for (const span of rawChangeSpans) {
    const previous = changeSpans[changeSpans.length - 1];
    if (!previous) {
      changeSpans.push({ ...span });
      continue;
    }
    const gapStart = previous.end + 1;
    const splitPoint = chooseGapSplitPoint(hunk.lines, gapStart, span.start, insideFenceByLine);
    const shouldMergeBlankAdjustment =
      splitPoint !== null &&
      gapContainsOnlyBlankContext(hunk.lines, gapStart, span.start) &&
      (spanTouchesOnlyBlankLines(hunk.lines, previous.start, previous.end) ||
        spanTouchesOnlyBlankLines(hunk.lines, span.start, span.end));
    if (splitPoint === null) {
      previous.end = span.end;
      continue;
    }
    if (shouldMergeBlankAdjustment) {
      previous.end = span.end;
      continue;
    }
    changeSpans.push({ ...span });
  }

  if (changeSpans.length <= 1) return [hunk];

  const leadingContexts = new Array(changeSpans.length).fill(0);
  const trailingContexts = new Array(changeSpans.length).fill(0);
  leadingContexts[0] = Math.min(SPLIT_HUNK_CONTEXT_LINES, changeSpans[0]?.start ?? 0);

  for (let index = 0; index < changeSpans.length - 1; index += 1) {
    const current = changeSpans[index];
    const next = changeSpans[index + 1];
    if (!current || !next) continue;
    const gapStart = current.end + 1;
    const splitPoint = chooseGapSplitPoint(hunk.lines, gapStart, next.start, insideFenceByLine);
    if (splitPoint === null) continue;
    const leading = next.start - gapStart - splitPoint;
    const trailing = splitPoint;
    trailingContexts[index] = trailing;
    leadingContexts[index + 1] = leading;
  }

  const lastSpan = changeSpans[changeSpans.length - 1];
  if (lastSpan) {
    trailingContexts[changeSpans.length - 1] = Math.min(SPLIT_HUNK_CONTEXT_LINES, hunk.lines.length - lastSpan.end - 1);
  }

  return changeSpans.map((span, index) => {
    const start = Math.max(0, span.start - (leadingContexts[index] ?? 0));
    const end = Math.min(hunk.lines.length - 1, span.end + (trailingContexts[index] ?? 0));
    const lines = hunk.lines.slice(start, end + 1);
    const oldStart = hunk.oldStart + countOriginalLines(hunk.lines.slice(0, start));
    const newStart = hunk.newStart + countModifiedLines(hunk.lines.slice(0, start));
    const oldLines = countOriginalLines(lines);
    const newLines = countModifiedLines(lines);

    return {
      id: `${hunk.id}:${index}`,
      header: formatUnifiedHunkHeader(oldStart, oldLines, newStart, newLines),
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    };
  });
}

export function parseUnifiedDiffHunks(diff: string): StagedHunk[] {
  if (!diff || diff === '(no changes)') return [];
  const lines = diff.split('\n');
  const hunks: StagedHunk[] = [];
  let current: StagedHunk | null = null;
  let hunkIndex = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      current = {
        id: `hunk:${hunkIndex++}:${line}`,
        header: line,
        oldStart: Number(match?.[1] ?? 0),
        oldLines: Number(match?.[2] ?? 1),
        newStart: Number(match?.[3] ?? 0),
        newLines: Number(match?.[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.lines.push({ type: 'add', content: line.slice(1) });
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.lines.push({ type: 'del', content: line.slice(1) });
      continue;
    }
    if (line.startsWith(' ')) {
      current.lines.push({ type: 'context', content: line.slice(1) });
    }
  }

  return hunks.flatMap((hunk) => splitParsedUnifiedDiffHunk(hunk));
}

export function createStructuredStagedChange(
  path: string,
  type: 'edit' | 'create' | 'delete',
  original: string | null,
  modified: string | null,
  revision: number,
): StagedChange {
  const diff = generateUnifiedDiff(path, original ?? '', modified ?? '');
  return {
    id: stagedChangeId(path),
    path,
    type,
    revision,
    original,
    modified,
    diff,
    hunks: parseUnifiedDiffHunks(diff),
  };
}

// ── Document editing ──

interface EditDocumentOp {
  old_text?: string;
  new_text?: string;
  start_line?: number;
  end_line?: number;
  expected_old_text?: string;
}

interface EditDocumentFailure {
  ok: false;
  tool: 'propose_edit_document';
  error: {
    code:
      | 'invalid_json'
      | 'invalid_args'
      | 'missing_required'
      | 'missing_read'
      | 'invalid_range'
      | 'not_found'
      | 'ambiguous_match'
      | 'no_change';
    message: string;
    next_action?: string;
    details?: Record<string, unknown>;
  };
  document_state?: DocumentStateSummary;
}

interface EditDocumentSuccess {
  ok: true;
  tool: 'propose_edit_document';
  dry_run: boolean;
  applied: boolean;
  path: string;
  mode: 'snippet' | 'line_range' | 'batch';
  edits_applied: number;
  diff: string;
  document_state: DocumentStateSummary;
}

interface DocumentStateSummary {
  current_document: 'original' | 'staged';
  proposal_state: 'none' | 'pending';
  staged_revision: number;
  total_lines: number;
}

function isEditDocumentFailure(
  result: EditDocumentFailure | { updated: string } | { updated: string; mode: 'snippet' | 'line_range' },
): result is EditDocumentFailure {
  return 'ok' in result && result.ok === false;
}

function makeEditDocumentFailure(
  error: EditDocumentFailure['error'],
  details?: Record<string, unknown>,
): EditDocumentFailure {
  return {
    ok: false,
    tool: 'propose_edit_document',
    error: { ...error, ...(details ? { details } : {}) },
  };
}

function summarizeDocumentState(state: DocumentEditState): DocumentStateSummary {
  const hasPendingProposal = Boolean(state.stagedContent && state.stagedDiff);
  return {
    current_document: hasPendingProposal ? 'staged' : 'original',
    proposal_state: hasPendingProposal ? 'pending' : 'none',
    staged_revision: state.stagedRevision,
    total_lines: state.lines.length,
  };
}

function makeStatefulEditDocumentFailure(
  state: DocumentEditState,
  error: EditDocumentFailure['error'],
  details?: Record<string, unknown>,
): EditDocumentFailure {
  return {
    ...makeEditDocumentFailure(error, details),
    document_state: summarizeDocumentState(state),
  };
}

function countLineForIndex(source: string, index: number): number {
  if (index <= 0) return 1;
  let lines = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function snippetAround(source: string, index: number, length: number): string {
  const pad = 36;
  const start = Math.max(0, index - pad);
  const end = Math.min(source.length, index + length + pad);
  return source.slice(start, end).replace(/\n/g, '\\n');
}

function findAmbiguousMatches(
  source: string,
  needle: string,
  limit = 5,
): Array<{ start_line: number; snippet: string }> {
  const matches: Array<{ start_line: number; snippet: string }> = [];
  let from = 0;
  while (matches.length < limit) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) break;
    matches.push({ start_line: countLineForIndex(source, idx), snippet: snippetAround(source, idx, needle.length) });
    from = idx + Math.max(1, needle.length);
  }
  return matches;
}

function applySnippetEdit(source: string, op: EditDocumentOp): { updated: string } | EditDocumentFailure {
  const oldText = typeof op.old_text === 'string' ? op.old_text : null;
  const newText = typeof op.new_text === 'string' ? op.new_text : '';
  if (oldText === null) {
    return makeEditDocumentFailure({
      code: 'missing_required',
      message: 'snippet edit requires old_text',
      next_action: 'Provide old_text for the snippet edit. Omit new_text to delete the matched content.',
    });
  }
  if (oldText === newText) {
    return makeEditDocumentFailure({
      code: 'no_change',
      message: 'old_text and new_text are identical',
      next_action: 'Change new_text or stop if no edit is needed.',
    });
  }
  const first = source.indexOf(oldText);
  if (first === -1) {
    return makeEditDocumentFailure(
      {
        code: 'not_found',
        message: 'old_text not found in document',
        next_action: 'Call read_document for the exact affected span and copy old_text directly from that result.',
      },
      {
        edit_mode: 'snippet',
        case_insensitive_match_exists: source.toLowerCase().includes(oldText.toLowerCase()),
      },
    );
  }
  const second = source.indexOf(oldText, first + oldText.length);
  if (second !== -1) {
    return makeEditDocumentFailure(
      {
        code: 'ambiguous_match',
        message: 'old_text matches multiple locations; provide more context',
        next_action: 'Call read_document for a narrower span and include more surrounding text in old_text.',
      },
      { edit_mode: 'snippet', matches: findAmbiguousMatches(source, oldText) },
    );
  }
  return {
    updated: source.slice(0, first) + newText + source.slice(first + oldText.length),
  };
}

function applyRangeEdit(source: string, op: EditDocumentOp): { updated: string } | EditDocumentFailure {
  const startLine = Number.isFinite(op.start_line) ? Math.floor(op.start_line as number) : NaN;
  const endLine = Number.isFinite(op.end_line) ? Math.floor(op.end_line as number) : NaN;
  const newText = typeof op.new_text === 'string' ? op.new_text : '';
  const expectedOldText = typeof op.expected_old_text === 'string' ? op.expected_old_text : null;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return makeEditDocumentFailure({
      code: 'missing_required',
      message: 'line range edit requires start_line and end_line',
      next_action: 'Provide start_line, end_line, and expected_old_text from a fresh read_document call. Omit new_text to delete the selected lines.',
    });
  }
  const lines = source.split('\n');
  const total = lines.length;
  if (startLine < 1 || endLine < 1 || startLine > total || endLine > total || startLine > endLine) {
    return makeEditDocumentFailure(
      {
        code: 'invalid_range',
        message: 'invalid line range',
        next_action:
          'Call read_document to confirm the current line numbers, then try again with a valid contiguous range.',
      },
      { edit_mode: 'line_range', start_line: startLine, end_line: endLine, total_lines: total },
    );
  }
  const currentText = lines.slice(startLine - 1, endLine).join('\n');
  if (expectedOldText !== null && currentText !== expectedOldText) {
    return makeEditDocumentFailure(
      {
        code: 'not_found',
        message:
          'expected_old_text did not match the current line range; the document changed after those lines were read',
        next_action: 'Call read_document again for that exact span and retry with the new expected_old_text.',
      },
      {
        edit_mode: 'line_range',
        start_line: startLine,
        end_line: endLine,
        expected_old_text: expectedOldText,
        current_text: currentText,
      },
    );
  }
  const replacementLines = newText.split('\n');
  const nextLines = [...lines.slice(0, startLine - 1), ...replacementLines, ...lines.slice(endLine)];
  const updated = nextLines.join('\n');
  if (updated === source) {
    return makeEditDocumentFailure({
      code: 'no_change',
      message: 'line range replacement produced no changes',
      next_action: 'Verify the selected range and replacement text, or stop if the document is already correct.',
    });
  }
  return { updated };
}

function classifyEditMode(op: EditDocumentOp): 'snippet' | 'line_range' | null {
  const hasSnippet = typeof op.old_text === 'string';
  const hasRange = Number.isFinite(op.start_line) || Number.isFinite(op.end_line);
  if (hasSnippet && hasRange) return null;
  if (hasSnippet) return 'snippet';
  if (hasRange) return 'line_range';
  return null;
}

function applySingleDocumentEdit(
  source: string,
  op: EditDocumentOp,
): { updated: string; mode: 'snippet' | 'line_range' } | EditDocumentFailure {
  const mode = classifyEditMode(op);
  if (!mode) {
    return makeEditDocumentFailure({
      code: 'invalid_args',
      message: 'edit must specify either old_text/new_text or start_line/end_line/new_text',
      next_action:
        'Pick one edit mode only. For snippet edits provide old_text/new_text; for line-range edits provide start_line/end_line/new_text/expected_old_text.',
    });
  }
  if (mode === 'snippet') {
    const result = applySnippetEdit(source, op);
    return isEditDocumentFailure(result) ? result : { updated: result.updated, mode };
  }
  const result = applyRangeEdit(source, op);
  return isEditDocumentFailure(result) ? result : { updated: result.updated, mode };
}

function validateEditShape(op: EditDocumentOp): EditDocumentFailure | null {
  const mode = classifyEditMode(op);
  if (!mode) {
    const hasSnippetFields = typeof op.old_text === 'string' || typeof op.new_text === 'string';
    const missingFields = hasSnippetFields
      ? (['old_text', 'new_text'] as const).filter((field) => !Object.hasOwn(op, field))
      : (['start_line', 'end_line', 'new_text', 'expected_old_text'] as const).filter(
          (field) => !Object.hasOwn(op, field),
        );
    return makeEditDocumentFailure(
      {
        code: 'invalid_args',
        message: 'edit must specify either old_text/new_text or start_line/end_line/new_text',
        next_action:
          'Pick one edit mode only. For snippet edits provide old_text/new_text; for line-range edits provide start_line/end_line/new_text/expected_old_text.',
      },
      { missing_fields: missingFields },
    );
  }
  if (mode === 'snippet') {
    if (typeof op.old_text !== 'string') {
      return makeEditDocumentFailure(
        {
          code: 'missing_required',
          message: 'snippet edit requires old_text',
          next_action: 'Provide old_text for the snippet edit. Omit new_text to delete the matched content.',
        },
        {
          edit_mode: 'snippet',
          missing_fields: ['old_text'] as const,
        },
      );
    }
    return null;
  }
  if (
    !Number.isFinite(op.start_line) ||
    !Number.isFinite(op.end_line) ||
    typeof op.expected_old_text !== 'string'
  ) {
    return makeEditDocumentFailure(
      {
        code: typeof op.expected_old_text === 'string' ? 'missing_required' : 'invalid_args',
        message:
          typeof op.expected_old_text === 'string'
            ? 'line range edit requires start_line and end_line'
            : 'line range edit requires start_line, end_line, and expected_old_text',
        next_action:
          'Call read_document for the exact span, then provide start_line, end_line, and expected_old_text together. Omit new_text to delete the selected lines.',
      },
      {
        edit_mode: 'line_range',
        missing_fields: (['start_line', 'end_line', 'expected_old_text'] as const).filter(
          (field) => !Object.hasOwn(op, field),
        ),
      },
    );
  }
  return null;
}

function requireFreshReadForEdit(state: DocumentEditState, op: EditDocumentOp): EditDocumentFailure | null {
  const snapshot = state.lastReadSnapshot;
  if (!snapshot) {
    return makeEditDocumentFailure({
      code: 'missing_read',
      message: 'call read_document for the exact affected span before proposing an edit',
      next_action: 'Call read_document for the exact paragraph or block you want to edit, then retry the edit once.',
    });
  }
  if (snapshot.sourceAtRead !== state.source) {
    return makeEditDocumentFailure({
      code: 'missing_read',
      message: 'call read_document again before editing because the staged document changed after the last read',
      next_action:
        'Re-read the affected span from the current staged document, then retry with text copied from that read.',
    });
  }
  const mode = classifyEditMode(op);
  if (mode === 'snippet') {
    const oldText = op.old_text as string;
    if (!snapshot.visibleText.includes(oldText)) {
      return makeEditDocumentFailure(
        {
          code: 'missing_read',
          message: 'old_text must be copied from the latest read_document result for the exact affected span',
          next_action: 'Call read_document for a narrower span and copy old_text exactly from that latest result.',
        },
        {
          edit_mode: 'snippet',
          last_read_start_line: snapshot.startLine,
          last_read_end_line: snapshot.endLine,
          truncated: snapshot.truncated,
        },
      );
    }
    return null;
  }
  const expectedOldText = op.expected_old_text as string;
  if (!snapshot.visibleText.includes(expectedOldText)) {
    return makeEditDocumentFailure(
      {
        code: 'missing_read',
        message: 'line-range edits must use expected_old_text copied from the latest read_document result',
        next_action:
          'Call read_document for the exact line range and copy expected_old_text directly from that latest result.',
      },
      {
        edit_mode: 'line_range',
        last_read_start_line: snapshot.startLine,
        last_read_end_line: snapshot.endLine,
        truncated: snapshot.truncated,
      },
    );
  }
  return null;
}

export function executeReaderAiEditDocumentTool(argsJson: string, state: DocumentEditState): string {
  const parsed = parseReaderAiToolArguments(argsJson);
  const args = parsed.parsedArgs;
  if (!args) {
    return JSON.stringify(
      makeStatefulEditDocumentFailure(state, {
        code: 'invalid_json',
        message: parsed.error ?? 'invalid JSON arguments',
        next_action: 'Send a valid JSON object with the required fields for one edit mode.',
      }),
    );
  }

  const path = state.currentDocPath || 'current-document.md';

  if (Object.hasOwn(args, 'edits') && !Array.isArray(args.edits)) {
    return JSON.stringify(
      makeStatefulEditDocumentFailure(state, {
        code: 'invalid_args',
        message: 'edits must be an array of edit objects',
        next_action: 'Wrap each edit object inside edits[] or send a single top-level edit object instead.',
      }),
    );
  }

  if (
    Array.isArray(args.edits) &&
    (Object.hasOwn(args, 'old_text') ||
      Object.hasOwn(args, 'new_text') ||
      Object.hasOwn(args, 'start_line') ||
      Object.hasOwn(args, 'end_line'))
  ) {
    return JSON.stringify(
      makeStatefulEditDocumentFailure(state, {
        code: 'invalid_args',
        message: 'provide either edits[] or a single top-level edit, not both',
        next_action: 'Choose one form only: either edits[] for a batch or top-level fields for a single edit.',
      }),
    );
  }

  const batchRaw = Array.isArray(args.edits) ? args.edits : null;
  if (batchRaw?.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    return JSON.stringify(
      makeStatefulEditDocumentFailure(state, {
        code: 'invalid_args',
        message: 'each edits[] item must be an object',
        next_action: 'Replace any non-object edits[] entries with valid edit objects.',
      }),
    );
  }
  const batch = batchRaw
    ? batchRaw
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map((entry) => ({
          old_text: typeof entry.old_text === 'string' ? entry.old_text : undefined,
          new_text: typeof entry.new_text === 'string' ? entry.new_text : undefined,
          start_line: Number.isFinite(entry.start_line) ? Number(entry.start_line) : undefined,
          end_line: Number.isFinite(entry.end_line) ? Number(entry.end_line) : undefined,
          expected_old_text: typeof entry.expected_old_text === 'string' ? entry.expected_old_text : undefined,
        }))
    : null;

  const ops: EditDocumentOp[] =
    batch && batch.length > 0
      ? batch
      : [
          {
            old_text: typeof args.old_text === 'string' ? args.old_text : undefined,
            new_text: typeof args.new_text === 'string' ? args.new_text : undefined,
            start_line: Number.isFinite(args.start_line) ? Number(args.start_line) : undefined,
            end_line: Number.isFinite(args.end_line) ? Number(args.end_line) : undefined,
            expected_old_text: typeof args.expected_old_text === 'string' ? args.expected_old_text : undefined,
          },
        ];

  if (ops.length === 0) {
    return JSON.stringify(
      makeStatefulEditDocumentFailure(state, {
        code: 'missing_required',
        message: 'no edits provided',
        next_action: 'Provide one edit object or a non-empty edits[] array.',
      }),
    );
  }

  for (let i = 0; i < ops.length; i++) {
    const shapeFailure = validateEditShape(ops[i]);
    if (shapeFailure) {
      return JSON.stringify(
        makeStatefulEditDocumentFailure(
          state,
          { ...shapeFailure.error, message: `edit ${i + 1} failed: ${shapeFailure.error.message}` },
          { ...(shapeFailure.error.details ?? {}), edit_index: i },
        ),
      );
    }
  }

  const hasLineRangeEdit = ops.some((op) => classifyEditMode(op) === 'line_range');
  const dryRunSpecified = Object.hasOwn(args, 'dry_run');
  if (hasLineRangeEdit && !dryRunSpecified) {
    return JSON.stringify(
      makeStatefulEditDocumentFailure(
        state,
        {
          code: 'invalid_args',
          message: 'line-range edits require an explicit dry_run value',
          next_action: 'Set dry_run to true for a preview or false to stage the line-range edit.',
        },
        { edit_mode: 'line_range', missing_fields: ['dry_run'] },
      ),
    );
  }
  const dryRun = dryRunSpecified ? args.dry_run === true : false;

  let working = state.source;
  let lastMode: 'snippet' | 'line_range' | 'batch' = 'batch';
  // Track cumulative line offset so batch line-range edits are interpreted
  // against the *original* document's line numbers, not the mutating working copy.
  let lineOffset = 0;
  for (let i = 0; i < ops.length; i++) {
    const readFailure = requireFreshReadForEdit(state, ops[i]);
    if (readFailure) {
      return JSON.stringify(
        makeStatefulEditDocumentFailure(
          state,
          { ...readFailure.error, message: `edit ${i + 1} failed: ${readFailure.error.message}` },
          { ...(readFailure.error.details ?? {}), edit_index: i },
        ),
      );
    }
    // For batched line-range edits, adjust line numbers by the cumulative offset
    // from prior edits so the caller can always specify original-document coordinates.
    let op = ops[i];
    const mode = classifyEditMode(op);
    if (mode === 'line_range' && lineOffset !== 0 && ops.length > 1) {
      op = {
        ...op,
        start_line: (op.start_line as number) + lineOffset,
        end_line: (op.end_line as number) + lineOffset,
      };
    }
    const beforeLineCount = working.split('\n').length;
    const result = applySingleDocumentEdit(working, op);
    if (isEditDocumentFailure(result)) {
      return JSON.stringify(
        makeStatefulEditDocumentFailure(
          state,
          {
            ...result.error,
            message: `edit ${i + 1} failed: ${result.error.message}`,
          },
          { ...(result.error.details ?? {}), edit_index: i },
        ),
      );
    }
    working = result.updated;
    const afterLineCount = working.split('\n').length;
    lineOffset += afterLineCount - beforeLineCount;
    if (ops.length === 1) lastMode = result.mode;
  }

  if (working === state.source) {
    return JSON.stringify(
      makeStatefulEditDocumentFailure(state, {
        code: 'no_change',
        message: 'no changes were produced',
        next_action:
          'Verify the edit target and replacement text, or stop if the document is already in the desired state.',
      }),
    );
  }

  const stagedOriginalContent = state.stagedOriginalContent ?? state.source;
  const diff = generateUnifiedDiff(path, stagedOriginalContent, working);
  if (!dryRun) {
    state.stagedOriginalContent = stagedOriginalContent;
    state.source = working;
    state.lines = working.split('\n');
    state.stagedContent = working;
    state.stagedDiff = diff;
    state.stagedRevision += 1;
    state.lastReadSnapshot = null;
  }

  const success: EditDocumentSuccess = {
    ok: true,
    tool: 'propose_edit_document',
    dry_run: dryRun,
    applied: !dryRun,
    path,
    mode: ops.length > 1 ? 'batch' : lastMode,
    edits_applied: ops.length,
    diff,
    document_state: summarizeDocumentState(state),
  };
  return JSON.stringify(success);
}

// Re-export types used by consumers
export type { StagedChange, StagedHunk, StagedHunkLine, DocumentEditState };
