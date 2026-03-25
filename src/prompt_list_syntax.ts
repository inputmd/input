export type PromptListItemKind = 'question' | 'answer' | 'comment';

export interface PromptListLineMatch {
  indent: string;
  marker: string;
  kind: PromptListItemKind;
  content: string;
  markerEnd: number;
}

export interface ParsedPromptListItem {
  match: PromptListLineMatch;
  startLineIndex: number;
  endLineIndex: number;
  content: string;
}

export interface ParsedPromptListBlock {
  items: ParsedPromptListItem[];
  endLineIndexExclusive: number;
}

const PROMPT_LIST_LINE_RE = /^([ \t]*)(~|❯|⏺|✻|%)([ \t]+)(.*)$/u;

function promptListItemKindForMarker(marker: string): PromptListItemKind {
  if (marker === '⏺') return 'answer';
  if (marker === '✻' || marker === '%') return 'comment';
  return 'question';
}

export function matchPromptListLine(text: string): PromptListLineMatch | null {
  const match = PROMPT_LIST_LINE_RE.exec(text);
  if (!match) return null;

  return {
    indent: match[1],
    marker: match[2],
    kind: promptListItemKindForMarker(match[2]),
    content: match[4],
    markerEnd: match[1].length + match[2].length + match[3].length,
  };
}

export function isPromptListContinuationLine(text: string, indent: string): boolean {
  return text.startsWith(`${indent}  `) || text.startsWith(`${indent}\t`);
}

export function stripPromptListContinuationIndent(text: string, indent: string): string {
  if (text.startsWith(`${indent}  `)) return text.slice(`${indent}  `.length);
  if (text.startsWith(`${indent}\t`)) return text.slice(`${indent}\t`.length);
  return text;
}

function isPromptListBlockConstruct(text: string): boolean {
  return /^(?:[-+*][ \t]|\d+\.[ \t]|>[ \t]?|#{1,6}[ \t]|```|~~~)/u.test(text);
}

export function stripPromptListResumedContinuationIndent(text: string, indent: string): string {
  const threeSpaceIndent = `${indent}   `;
  const fourSpaceIndent = `${indent}    `;
  if (text.startsWith(threeSpaceIndent) && !text.startsWith(fourSpaceIndent)) {
    const candidate = text.slice(threeSpaceIndent.length);
    if (!isPromptListBlockConstruct(candidate)) return candidate;
  }
  return stripPromptListContinuationIndent(text, indent);
}

export function parsePromptListBlock(lines: string[], startLineIndex: number): ParsedPromptListBlock | null {
  const firstMatch = matchPromptListLine(lines[startLineIndex] ?? '');
  if (!firstMatch) return null;

  const items: ParsedPromptListItem[] = [];
  let cursor = startLineIndex;

  while (cursor < lines.length) {
    const match = matchPromptListLine(lines[cursor] ?? '');
    if (!match) break;

    const contentLines = [match.content];
    let nextIndex = cursor + 1;
    let endLineIndex = cursor;

    while (nextIndex < lines.length) {
      const line = lines[nextIndex] ?? '';
      if (matchPromptListLine(line)) break;

      if (/^\s*$/.test(line)) {
        let scanIndex = nextIndex;
        while (scanIndex < lines.length && /^\s*$/.test(lines[scanIndex] ?? '')) {
          scanIndex += 1;
        }

        if (scanIndex >= lines.length) {
          endLineIndex = nextIndex - 1;
          nextIndex = scanIndex;
          break;
        }

        const resumedLine = lines[scanIndex] ?? '';
        if (matchPromptListLine(resumedLine)) {
          if (scanIndex === nextIndex + 1) {
            nextIndex = scanIndex;
          }
          break;
        }
        if (!isPromptListContinuationLine(resumedLine, match.indent)) break;

        contentLines.push(...Array.from({ length: scanIndex - nextIndex }, () => ''));
        contentLines.push(stripPromptListResumedContinuationIndent(resumedLine, match.indent));
        endLineIndex = scanIndex;
        nextIndex = scanIndex + 1;
        continue;
      }

      if (!isPromptListContinuationLine(line, match.indent)) break;

      contentLines.push(stripPromptListContinuationIndent(line, match.indent));
      endLineIndex = nextIndex;
      nextIndex += 1;
    }

    items.push({
      match,
      startLineIndex: cursor,
      endLineIndex,
      content: contentLines.join('\n').trimEnd(),
    });

    cursor = nextIndex;
    if (cursor >= lines.length) break;
    if (!matchPromptListLine(lines[cursor] ?? '')) break;
  }

  if (items.length === 0) return null;

  return {
    items,
    endLineIndexExclusive: cursor,
  };
}
