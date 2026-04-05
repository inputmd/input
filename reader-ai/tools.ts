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
        'Read the document content. Returns line-numbered text. Without arguments returns the full document; use start_line/end_line for specific sections. When document edit state exists, the result also includes a read_id plus whether you are reading the original or staged document, the current staged revision, total lines, and whether a proposal is pending. Before any edit proposal, call read_document for the exact affected span and then use the returned read_id in the edit tool call.',
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
      name: 'propose_replace_region',
      description:
        'Propose a replacement for one contiguous region previously read with read_document. Use this for sentence, paragraph, or block rewrites where you want to replace one exact span with another exact span. The read_id must come from a fresh read_document result covering the target text. old_text must match exactly once within that read span. new_text is optional: omit it to delete the matched region. Returns structured JSON including diff, document_state, and actionable errors.',
      parameters: {
        type: 'object' as const,
        properties: {
          read_id: {
            type: 'string' as const,
            description:
              'Required read_document identifier for the exact span you want to edit. Copy it from the latest read_document result.',
          },
          old_text: {
            type: 'string' as const,
            description:
              'Exact text to replace inside the region referenced by read_id. It must match exactly once within that read span.',
          },
          new_text: {
            type: 'string' as const,
            description: 'Replacement text. Omit to delete the matched region. Whitespace and newlines are literal.',
          },
          dry_run: {
            type: 'boolean' as const,
            description: 'If true, preview the diff without applying changes to staged document content.',
          },
        },
        required: ['read_id', 'old_text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_replace_matches',
      description:
        'Propose a mechanical find-and-replace within one span previously read with read_document. Use this for repeated word or phrase replacement, including deletion by omitting replace_text. The read_id must come from a fresh read_document result covering the target span. expected_match_count is required and the tool fails if the actual match count differs. Returns structured JSON including diff, document_state, and actionable errors.',
      parameters: {
        type: 'object' as const,
        properties: {
          read_id: {
            type: 'string' as const,
            description:
              'Required read_document identifier for the span where matches should be replaced. Copy it from the latest read_document result.',
          },
          match_text: {
            type: 'string' as const,
            description: 'Text to match inside the read span.',
          },
          replace_text: {
            type: 'string' as const,
            description: 'Replacement text. Omit to delete each matched occurrence.',
          },
          match_mode: {
            type: 'string' as const,
            description:
              'Matching mode. Use "whole_word" for token-level replacement or "exact" for plain substring replacement.',
            enum: ['exact', 'whole_word'],
          },
          case_sensitive: {
            type: 'boolean' as const,
            description: 'Whether matching should be case-sensitive. Default: false.',
          },
          expected_match_count: {
            type: 'number' as const,
            description:
              'Required expected number of matches inside the read span. The tool fails if the actual count differs.',
          },
          dry_run: {
            type: 'boolean' as const,
            description: 'If true, preview the diff without applying changes to staged document content.',
          },
        },
        required: ['read_id', 'match_text', 'match_mode', 'expected_match_count'],
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
  (t) =>
    t.function.name !== 'task' &&
    t.function.name !== 'propose_replace_region' &&
    t.function.name !== 'propose_replace_matches',
);

// ── Tool execution ──

function buildReadDocumentSnapshot(
  readId: string,
  source: string,
  lines: string[],
  start: number,
  numbered: string[],
  truncated: boolean,
): DocumentReadSnapshot {
  const visibleLineCount = Math.max(0, numbered.length);
  const endLine = visibleLineCount > 0 ? start + visibleLineCount - 1 : start;
  const visibleText = lines.slice(start - 1, start - 1 + visibleLineCount).join('\n');
  let startOffset = 0;
  for (let i = 0; i < start - 1; i++) startOffset += lines[i].length + 1;
  return {
    readId,
    startLine: start,
    endLine,
    startOffset,
    endOffset: startOffset + visibleText.length,
    visibleText,
    sourceAtRead: source,
    truncated,
  };
}

function ensureReadSnapshotState(state: DocumentEditState): void {
  if (!state.readSnapshots) state.readSnapshots = new Map();
  if (!Number.isFinite(state.nextReadId) || (state.nextReadId ?? 0) < 1) state.nextReadId = 1;
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
  let readId = '';
  if (state) {
    ensureReadSnapshotState(state);
    const nextReadId = state.nextReadId ?? 1;
    readId = `read_${nextReadId}`;
    state.nextReadId = nextReadId + 1;
  }
  const stateHeader = state
    ? (() => {
        const summary = summarizeDocumentState(state);
        return `(${summary.current_document} document; read_id ${readId}; staged revision ${summary.staged_revision}; ${summary.total_lines} total lines; proposal state: ${summary.proposal_state})\n`;
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
      const snapshot = buildReadDocumentSnapshot(
        readId,
        state.source,
        lines,
        start,
        numbered.slice(0, lastFittingLine - start + 1),
        true,
      );
      state.readSnapshots!.set(snapshot.readId, snapshot);
    }
    return stateHeader + truncatedResult;
  }
  if (state) {
    const snapshot = buildReadDocumentSnapshot(readId, state.source, lines, start, numbered, false);
    state.readSnapshots!.set(snapshot.readId, snapshot);
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

type DocumentProposalToolName = 'propose_replace_region' | 'propose_replace_matches';
type ProposalFailureCode =
  | 'invalid_json'
  | 'invalid_args'
  | 'missing_required'
  | 'stale_read'
  | 'not_found'
  | 'match_not_found'
  | 'match_count_mismatch'
  | 'ambiguous_match'
  | 'no_change';

interface ReplaceRegionArgs {
  read_id?: string;
  old_text?: string;
  new_text?: string;
  dry_run?: boolean;
}

interface ReplaceMatchesArgs {
  read_id?: string;
  match_text?: string;
  replace_text?: string;
  match_mode?: string;
  case_sensitive?: boolean;
  expected_match_count?: number;
  dry_run?: boolean;
}

interface DocumentProposalFailure {
  ok: false;
  tool: DocumentProposalToolName;
  error: {
    code: ProposalFailureCode;
    message: string;
    next_action?: string;
    details?: Record<string, unknown>;
  };
  document_state?: DocumentStateSummary;
}

interface DocumentStateSummary {
  current_document: 'original' | 'staged';
  proposal_state: 'none' | 'pending';
  staged_revision: number;
  total_lines: number;
}

function isDocumentProposalFailure(
  result:
    | DocumentProposalFailure
    | { updated: string }
    | { updated: string; matchesReplaced: number; matchedLines: number[] },
): result is DocumentProposalFailure {
  return 'ok' in result && result.ok === false;
}

function makeDocumentProposalFailure(
  tool: DocumentProposalToolName,
  error: DocumentProposalFailure['error'],
  details?: Record<string, unknown>,
): DocumentProposalFailure {
  return {
    ok: false,
    tool,
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

function makeStatefulDocumentProposalFailure(
  tool: DocumentProposalToolName,
  state: DocumentEditState,
  error: DocumentProposalFailure['error'],
  details?: Record<string, unknown>,
): DocumentProposalFailure {
  return {
    ...makeDocumentProposalFailure(tool, error, details),
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
  lineBase = 1,
): Array<{ start_line: number; snippet: string }> {
  const matches: Array<{ start_line: number; snippet: string }> = [];
  let from = 0;
  while (matches.length < limit) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) break;
    matches.push({
      start_line: lineBase + countLineForIndex(source, idx) - 1,
      snippet: snippetAround(source, idx, needle.length),
    });
    from = idx + Math.max(1, needle.length);
  }
  return matches;
}

function getRequiredReadSnapshot(
  state: DocumentEditState,
  readId: string | undefined,
  tool: DocumentProposalToolName,
): DocumentReadSnapshot | DocumentProposalFailure {
  ensureReadSnapshotState(state);
  if (!readId) {
    return makeStatefulDocumentProposalFailure(tool, state, {
      code: 'missing_required',
      message: 'read_id is required',
      next_action: 'Call read_document for the exact target span, then copy the returned read_id into this edit.',
    });
  }
  const snapshot = state.readSnapshots!.get(readId);
  if (!snapshot) {
    return makeStatefulDocumentProposalFailure(tool, state, {
      code: 'stale_read',
      message: 'read_id is unknown or expired',
      next_action: 'Call read_document again for the exact target span and retry with the new read_id.',
    });
  }
  if (snapshot.sourceAtRead !== state.source) {
    return makeStatefulDocumentProposalFailure(tool, state, {
      code: 'stale_read',
      message: 'read_id is stale because the staged document changed after the read',
      next_action: 'Re-read the affected span from the current staged document, then retry with the new read_id.',
    });
  }
  return snapshot;
}

function applyReplaceRegion(
  source: string,
  snapshot: DocumentReadSnapshot,
  oldText: string,
  newText: string,
): { updated: string } | DocumentProposalFailure {
  if (oldText === newText) {
    return makeDocumentProposalFailure('propose_replace_region', {
      code: 'no_change',
      message: 'old_text and new_text are identical',
      next_action: 'Change new_text or stop if no edit is needed.',
    });
  }
  const first = snapshot.visibleText.indexOf(oldText);
  if (first === -1) {
    return makeDocumentProposalFailure(
      'propose_replace_region',
      {
        code: 'not_found',
        message: 'old_text was not found inside the region referenced by read_id',
        next_action:
          'Call read_document again for the exact affected span and copy old_text directly from that result.',
      },
      {
        read_id: snapshot.readId,
        start_line: snapshot.startLine,
        end_line: snapshot.endLine,
        truncated: snapshot.truncated,
      },
    );
  }
  const second = snapshot.visibleText.indexOf(oldText, first + oldText.length);
  if (second !== -1) {
    return makeDocumentProposalFailure(
      'propose_replace_region',
      {
        code: 'ambiguous_match',
        message: 'old_text matches multiple locations inside the region referenced by read_id',
        next_action: 'Call read_document for a narrower span and retry with a more specific old_text.',
      },
      { matches: findAmbiguousMatches(snapshot.visibleText, oldText, 5, snapshot.startLine) },
    );
  }
  const globalStart = snapshot.startOffset + first;
  return {
    updated: source.slice(0, globalStart) + newText + source.slice(globalStart + oldText.length),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReplaceMatchesPattern(matchText: string, matchMode: string, caseSensitive: boolean): RegExp | null {
  const flags = `${caseSensitive ? 'g' : 'gi'}u`;
  if (matchMode === 'exact') return new RegExp(escapeRegExp(matchText), flags);
  if (matchMode === 'whole_word') {
    return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(matchText)}(?![\\p{L}\\p{N}_-])`, flags);
  }
  return null;
}

function applyReplaceMatches(
  source: string,
  snapshot: DocumentReadSnapshot,
  matchText: string,
  replaceText: string,
  matchMode: string,
  caseSensitive: boolean,
  expectedMatchCount: number,
): { updated: string; matchesReplaced: number; matchedLines: number[] } | DocumentProposalFailure {
  const pattern = buildReplaceMatchesPattern(matchText, matchMode, caseSensitive);
  if (!pattern) {
    return makeDocumentProposalFailure('propose_replace_matches', {
      code: 'invalid_args',
      message: 'match_mode must be "exact" or "whole_word"',
      next_action: 'Set match_mode to "exact" or "whole_word" and retry.',
    });
  }

  const matches = [...snapshot.visibleText.matchAll(pattern)].map((match) => ({
    index: match.index ?? -1,
    text: match[0],
  }));
  const validMatches = matches.filter((match) => match.index >= 0 && match.text.length > 0);
  if (validMatches.length === 0) {
    return makeDocumentProposalFailure(
      'propose_replace_matches',
      {
        code: 'match_not_found',
        message: 'match_text was not found inside the region referenced by read_id',
        next_action: 'Call read_document again for the intended span and verify match_text and match_mode.',
      },
      {
        read_id: snapshot.readId,
        start_line: snapshot.startLine,
        end_line: snapshot.endLine,
      },
    );
  }

  const matchedLines = [
    ...new Set(validMatches.map((match) => countLineForIndex(source, snapshot.startOffset + match.index))),
  ];
  if (validMatches.length !== expectedMatchCount) {
    return makeDocumentProposalFailure(
      'propose_replace_matches',
      {
        code: 'match_count_mismatch',
        message: `expected ${expectedMatchCount} match${expectedMatchCount === 1 ? '' : 'es'} but found ${validMatches.length}`,
        next_action: 'Re-read the target span and retry with the correct expected_match_count.',
      },
      {
        expected_match_count: expectedMatchCount,
        actual_match_count: validMatches.length,
        matched_lines: matchedLines,
      },
    );
  }

  let updatedVisibleText = '';
  let cursor = 0;
  for (const match of validMatches) {
    updatedVisibleText += snapshot.visibleText.slice(cursor, match.index) + replaceText;
    cursor = match.index + match.text.length;
  }
  updatedVisibleText += snapshot.visibleText.slice(cursor);

  return {
    updated: source.slice(0, snapshot.startOffset) + updatedVisibleText + source.slice(snapshot.endOffset),
    matchesReplaced: validMatches.length,
    matchedLines,
  };
}

function finalizeDocumentProposal(
  state: DocumentEditState,
  tool: 'propose_replace_region' | 'propose_replace_matches',
  working: string,
  dryRun: boolean,
  extra: Record<string, unknown> = {},
): string {
  if (working === state.source) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure(tool, state, {
        code: 'no_change',
        message: 'no changes were produced',
        next_action: 'Verify the target text and replacement, or stop if the document is already correct.',
      }),
    );
  }

  const path = state.currentDocPath || 'current-document.md';
  const stagedOriginalContent = state.stagedOriginalContent ?? state.source;
  const diff = generateUnifiedDiff(path, stagedOriginalContent, working);
  if (!dryRun) {
    state.stagedOriginalContent = stagedOriginalContent;
    state.source = working;
    state.lines = working.split('\n');
    state.stagedContent = working;
    state.stagedDiff = diff;
    state.stagedRevision += 1;
    state.readSnapshots = new Map();
  }

  return JSON.stringify({
    ok: true,
    tool,
    dry_run: dryRun,
    applied: !dryRun,
    path,
    diff,
    ...extra,
    document_state: summarizeDocumentState(state),
  });
}

export function executeReaderAiReplaceRegionTool(argsJson: string, state: DocumentEditState): string {
  const parsed = parseReaderAiToolArguments(argsJson);
  const args = parsed.parsedArgs;
  if (!args) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_region', state, {
        code: 'invalid_json',
        message: parsed.error ?? 'invalid JSON arguments',
        next_action: 'Send a valid JSON object with read_id, old_text, and optional new_text/dry_run.',
      }),
    );
  }
  const payload: ReplaceRegionArgs = {
    read_id: typeof args.read_id === 'string' ? args.read_id : undefined,
    old_text: typeof args.old_text === 'string' ? args.old_text : undefined,
    new_text: typeof args.new_text === 'string' ? args.new_text : undefined,
    dry_run: args.dry_run === true,
  };
  if (!payload.old_text) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_region', state, {
        code: 'missing_required',
        message: 'old_text is required',
        next_action: 'Copy old_text exactly from the read_document result identified by read_id.',
      }),
    );
  }
  const snapshot = getRequiredReadSnapshot(state, payload.read_id, 'propose_replace_region');
  if ('ok' in snapshot) return JSON.stringify(snapshot);

  const result = applyReplaceRegion(state.source, snapshot, payload.old_text, payload.new_text ?? '');
  if (isDocumentProposalFailure(result)) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_region', state, result.error, result.error.details),
    );
  }
  return finalizeDocumentProposal(state, 'propose_replace_region', result.updated, payload.dry_run === true);
}

export function executeReaderAiReplaceMatchesTool(argsJson: string, state: DocumentEditState): string {
  const parsed = parseReaderAiToolArguments(argsJson);
  const args = parsed.parsedArgs;
  if (!args) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_matches', state, {
        code: 'invalid_json',
        message: parsed.error ?? 'invalid JSON arguments',
        next_action:
          'Send a valid JSON object with read_id, match_text, match_mode, expected_match_count, and optional replace_text/dry_run.',
      }),
    );
  }

  const payload: ReplaceMatchesArgs = {
    read_id: typeof args.read_id === 'string' ? args.read_id : undefined,
    match_text: typeof args.match_text === 'string' ? args.match_text : undefined,
    replace_text: typeof args.replace_text === 'string' ? args.replace_text : undefined,
    match_mode: typeof args.match_mode === 'string' ? args.match_mode : undefined,
    case_sensitive: args.case_sensitive === true,
    expected_match_count: Number.isFinite(args.expected_match_count) ? Number(args.expected_match_count) : undefined,
    dry_run: args.dry_run === true,
  };

  if (!payload.match_text) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_matches', state, {
        code: 'missing_required',
        message: 'match_text is required',
        next_action: 'Provide the exact word or phrase to replace inside the span identified by read_id.',
      }),
    );
  }
  if (!payload.match_mode) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_matches', state, {
        code: 'missing_required',
        message: 'match_mode is required',
        next_action: 'Set match_mode to "exact" or "whole_word".',
      }),
    );
  }
  const expectedMatchCount = payload.expected_match_count;
  if (!Number.isInteger(expectedMatchCount) || (expectedMatchCount ?? 0) < 1) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_matches', state, {
        code: 'missing_required',
        message: 'expected_match_count must be a positive integer',
        next_action: 'Count the expected matches in the read span and provide that value explicitly.',
      }),
    );
  }
  const expectedMatchCountValue = expectedMatchCount as number;

  const snapshot = getRequiredReadSnapshot(state, payload.read_id, 'propose_replace_matches');
  if ('ok' in snapshot) return JSON.stringify(snapshot);

  const result = applyReplaceMatches(
    state.source,
    snapshot,
    payload.match_text,
    payload.replace_text ?? '',
    payload.match_mode,
    payload.case_sensitive === true,
    expectedMatchCountValue,
  );
  if (isDocumentProposalFailure(result)) {
    return JSON.stringify(
      makeStatefulDocumentProposalFailure('propose_replace_matches', state, result.error, result.error.details),
    );
  }

  return finalizeDocumentProposal(state, 'propose_replace_matches', result.updated, payload.dry_run === true, {
    matches_replaced: result.matchesReplaced,
    matched_lines: result.matchedLines,
  });
}

// Re-export types used by consumers
export type { StagedChange, StagedHunk, StagedHunkLine, DocumentEditState };
