import { diffChars, diffWordsWithSpace } from 'diff';
import type { ReaderAiStagedHunk } from '../reader_ai';

export const LONG_DIFF_LINE_CLIP_THRESHOLD = 120;
export const LONG_DIFF_LINE_CONTEXT_CHARS = 48;
export const UNIFIED_DIFF_CONTEXT_LINE_MAX_LINES = 3;
export const UNIFIED_DIFF_CONTEXT_SIDE_MAX_CHARS = 100;

export interface InlineDiffSegment {
  value: string;
  changed: boolean;
}

export interface InlineDisplaySegment extends InlineDiffSegment {
  ellipsis?: boolean;
}

export interface InlineDiffSegments {
  left: InlineDiffSegment[];
  right: InlineDiffSegment[];
}

export function selectInlineDiffSegments(left: string, right: string, side: 'left' | 'right'): InlineDiffSegment[] {
  const segments = buildInlineDiffSegments(left, right);
  return side === 'left' ? segments.left : segments.right;
}

function appendInlineDiffSegment(segments: InlineDiffSegment[], value: string, changed: boolean): void {
  if (!value) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.changed === changed) {
    previous.value += value;
    return;
  }
  segments.push({ value, changed });
}

function buildInlineCharDiffSegments(left: string, right: string): InlineDiffSegments {
  const segments: InlineDiffSegments = { left: [], right: [] };
  for (const part of diffChars(left, right)) {
    if (part.added) {
      appendInlineDiffSegment(segments.right, part.value, true);
      continue;
    }
    if (part.removed) {
      appendInlineDiffSegment(segments.left, part.value, true);
      continue;
    }
    appendInlineDiffSegment(segments.left, part.value, false);
    appendInlineDiffSegment(segments.right, part.value, false);
  }
  return segments;
}

function shouldRefineInlineDiffPair(left: string, right: string): boolean {
  if (!left || !right) return false;
  return Math.max(left.length, right.length) <= LONG_DIFF_LINE_CLIP_THRESHOLD;
}

export function buildInlineDiffSegments(left: string, right: string): InlineDiffSegments {
  const segments: InlineDiffSegments = { left: [], right: [] };
  const parts = diffWordsWithSpace(left, right);

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = parts[index + 1];

    if (part.removed && next?.added) {
      if (shouldRefineInlineDiffPair(part.value, next.value)) {
        const refined = buildInlineCharDiffSegments(part.value, next.value);
        for (const segment of refined.left) appendInlineDiffSegment(segments.left, segment.value, segment.changed);
        for (const segment of refined.right) appendInlineDiffSegment(segments.right, segment.value, segment.changed);
      } else {
        appendInlineDiffSegment(segments.left, part.value, true);
        appendInlineDiffSegment(segments.right, next.value, true);
      }
      index += 1;
      continue;
    }

    if (part.added && next?.removed) {
      if (shouldRefineInlineDiffPair(next.value, part.value)) {
        const refined = buildInlineCharDiffSegments(next.value, part.value);
        for (const segment of refined.left) appendInlineDiffSegment(segments.left, segment.value, segment.changed);
        for (const segment of refined.right) appendInlineDiffSegment(segments.right, segment.value, segment.changed);
      } else {
        appendInlineDiffSegment(segments.left, next.value, true);
        appendInlineDiffSegment(segments.right, part.value, true);
      }
      index += 1;
      continue;
    }

    if (part.added) {
      appendInlineDiffSegment(segments.right, part.value, true);
      continue;
    }

    if (part.removed) {
      appendInlineDiffSegment(segments.left, part.value, true);
      continue;
    }

    appendInlineDiffSegment(segments.left, part.value, false);
    appendInlineDiffSegment(segments.right, part.value, false);
  }

  return segments;
}

function appendInlineDisplaySegment(
  segments: InlineDisplaySegment[],
  value: string,
  changed: boolean,
  ellipsis = false,
): void {
  if (!value) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.changed === changed && previous.ellipsis === ellipsis) {
    previous.value += value;
    return;
  }
  segments.push({ value, changed, ...(ellipsis ? { ellipsis: true } : {}) });
}

export function clipInlineDiffSegmentsForDisplay(segments: InlineDiffSegment[]): InlineDisplaySegment[] {
  const totalLength = segments.reduce((sum, segment) => sum + segment.value.length, 0);
  if (totalLength <= LONG_DIFF_LINE_CLIP_THRESHOLD) return segments.map((segment) => ({ ...segment }));

  const firstChangedIndex = segments.findIndex((segment) => segment.changed);
  let lastChangedIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (!segments[index]?.changed) continue;
    lastChangedIndex = index;
    break;
  }
  if (firstChangedIndex === -1 || lastChangedIndex === -1) return segments.map((segment) => ({ ...segment }));

  const clipped: InlineDisplaySegment[] = [];

  for (const [index, segment] of segments.entries()) {
    if (segment.changed) {
      appendInlineDisplaySegment(clipped, segment.value, true);
      continue;
    }

    const beforeFirstChanged = index < firstChangedIndex;
    const afterLastChanged = index > lastChangedIndex;
    const betweenChanged = index > firstChangedIndex && index < lastChangedIndex;

    if (beforeFirstChanged && segment.value.length > LONG_DIFF_LINE_CONTEXT_CHARS) {
      appendInlineDisplaySegment(clipped, '…', false, true);
      appendInlineDisplaySegment(clipped, segment.value.slice(-LONG_DIFF_LINE_CONTEXT_CHARS), false);
      continue;
    }

    if (afterLastChanged && segment.value.length > LONG_DIFF_LINE_CONTEXT_CHARS) {
      appendInlineDisplaySegment(clipped, segment.value.slice(0, LONG_DIFF_LINE_CONTEXT_CHARS), false);
      appendInlineDisplaySegment(clipped, '…', false, true);
      continue;
    }

    if (betweenChanged && segment.value.length > LONG_DIFF_LINE_CONTEXT_CHARS * 2) {
      appendInlineDisplaySegment(clipped, segment.value.slice(0, LONG_DIFF_LINE_CONTEXT_CHARS), false);
      appendInlineDisplaySegment(clipped, '…', false, true);
      appendInlineDisplaySegment(clipped, segment.value.slice(-LONG_DIFF_LINE_CONTEXT_CHARS), false);
      continue;
    }

    appendInlineDisplaySegment(clipped, segment.value, false);
  }

  return clipped;
}

function isUnifiedDiffChangeLine(line: string): boolean {
  return (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'));
}

function limitUnifiedDiffContextRun(
  lines: Array<string | null>,
  start: number,
  endExclusive: number,
  direction: 'before' | 'after',
): void {
  let shownChars = 0;
  let shownLines = 0;
  const step = direction === 'before' ? -1 : 1;
  let index = direction === 'before' ? endExclusive - 1 : start;

  while (direction === 'before' ? index >= start : index < endExclusive) {
    const line = lines[index];
    if (line?.startsWith(' ')) {
      const content = line.slice(1);
      if (shownLines >= UNIFIED_DIFF_CONTEXT_LINE_MAX_LINES || shownChars >= UNIFIED_DIFF_CONTEXT_SIDE_MAX_CHARS) {
        lines[index] = null;
      } else {
        const remainingChars = UNIFIED_DIFF_CONTEXT_SIDE_MAX_CHARS - shownChars;
        if (content.length > remainingChars) {
          lines[index] =
            direction === 'before' ? ` …${content.slice(-remainingChars)}` : ` ${content.slice(0, remainingChars)}…`;
          shownChars = UNIFIED_DIFF_CONTEXT_SIDE_MAX_CHARS;
          shownLines += 1;
        } else {
          shownChars += content.length;
          shownLines += 1;
        }
      }
    }
    index += step;
  }

  const trimStep = direction === 'before' ? 1 : -1;
  let trimIndex = direction === 'before' ? start : endExclusive - 1;
  while (direction === 'before' ? trimIndex < endExclusive : trimIndex >= start) {
    const line = lines[trimIndex];
    if (line === null) {
      trimIndex += trimStep;
      continue;
    }
    if (line.startsWith(' ') && line.slice(1).trim().length === 0) {
      lines[trimIndex] = null;
      trimIndex += trimStep;
      continue;
    }
    break;
  }
}

export function findUnifiedDiffReplacementPair(lines: string[], index: number): number | null {
  const line = lines[index];
  if (!line?.startsWith('-') || line.startsWith('---')) return null;

  const next = lines[index + 1];
  if (next?.startsWith('+') && !next.startsWith('+++')) return index + 1;

  const nextAfterBlankContext = lines[index + 2];
  if (next === ' ' && nextAfterBlankContext?.startsWith('+') && !nextAfterBlankContext.startsWith('+++')) {
    return index + 2;
  }

  return null;
}

export interface UnifiedDiffLineParts {
  content: string;
  hasSignColumn: boolean;
  sign: string | null;
}

export function getUnifiedDiffLineParts(line: string): UnifiedDiffLineParts {
  const hasSignColumn =
    !line.startsWith('+++') &&
    !line.startsWith('---') &&
    !line.startsWith('@@') &&
    (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '));

  if (!hasSignColumn) return { content: line, hasSignColumn: false, sign: null };

  return {
    content: line.slice(1),
    hasSignColumn: true,
    sign: line[0] === ' ' ? '\u00a0' : line[0],
  };
}

export function clipLongDiffText(text: string): {
  clippedPrefix: string;
  clippedSuffix: string;
  hasLeadingClip: boolean;
  hasTrailingClip: boolean;
} | null {
  if (text.length <= LONG_DIFF_LINE_CLIP_THRESHOLD) return null;
  const clippedPrefix = text.slice(0, LONG_DIFF_LINE_CONTEXT_CHARS);
  const clippedSuffix = text.slice(-LONG_DIFF_LINE_CONTEXT_CHARS);
  return {
    clippedPrefix,
    clippedSuffix,
    hasLeadingClip: false,
    hasTrailingClip: clippedPrefix.length + clippedSuffix.length < text.length,
  };
}

export function stripUnifiedDiffHunkHeaders(lines: string[]): string[] {
  return lines.filter((line) => !line.startsWith('@@'));
}

export function prepareUnifiedDiffLines(
  diff: string,
  options?: { clipContextLines?: boolean; hideHunkHeaders?: boolean },
): string[] {
  let lines = diff.split('\n');
  if (options?.clipContextLines) lines = limitUnifiedDiffContextLines(lines);
  if (options?.hideHunkHeaders) lines = stripUnifiedDiffHunkHeaders(lines);
  return lines;
}

export function limitUnifiedDiffContextLines(lines: string[]): string[] {
  const next: Array<string | null> = [...lines];

  for (let hunkHeaderIndex = 0; hunkHeaderIndex < lines.length; hunkHeaderIndex += 1) {
    if (!lines[hunkHeaderIndex]?.startsWith('@@')) continue;

    let hunkEnd = hunkHeaderIndex + 1;
    while (hunkEnd < lines.length && !lines[hunkEnd]?.startsWith('@@')) hunkEnd += 1;

    let firstChangeIndex = -1;
    let lastChangeIndex = -1;
    for (let index = hunkHeaderIndex + 1; index < hunkEnd; index += 1) {
      if (!isUnifiedDiffChangeLine(lines[index] ?? '')) continue;
      if (firstChangeIndex === -1) firstChangeIndex = index;
      lastChangeIndex = index;
    }

    if (firstChangeIndex === -1 || lastChangeIndex === -1) {
      hunkHeaderIndex = hunkEnd - 1;
      continue;
    }

    limitUnifiedDiffContextRun(next, hunkHeaderIndex + 1, firstChangeIndex, 'before');
    limitUnifiedDiffContextRun(next, lastChangeIndex + 1, hunkEnd, 'after');
    hunkHeaderIndex = hunkEnd - 1;
  }

  return next.filter((line): line is string => typeof line === 'string');
}

export function buildUnifiedDiffFromHunk(hunk: ReaderAiStagedHunk): string {
  return [
    hunk.header,
    ...hunk.lines.map((line) => {
      if (line.type === 'add') return `+${line.content}`;
      if (line.type === 'del') return `-${line.content}`;
      return ` ${line.content}`;
    }),
  ].join('\n');
}
