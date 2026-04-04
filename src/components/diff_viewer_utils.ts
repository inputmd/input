import type { ReaderAiStagedHunk } from '../reader_ai';

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
