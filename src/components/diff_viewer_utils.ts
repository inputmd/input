import type { ReaderAiStagedHunk } from '../reader_ai';

export const LONG_DIFF_LINE_CLIP_THRESHOLD = 120;
export const LONG_DIFF_LINE_CONTEXT_CHARS = 48;
export const UNIFIED_DIFF_CONTEXT_LINE_MAX_LINES = 3;
export const UNIFIED_DIFF_CONTEXT_SIDE_MAX_CHARS = 100;

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
  if (next === ' ' && nextAfterBlankContext === '+') return index + 2;

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
