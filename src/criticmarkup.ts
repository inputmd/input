export type CriticMarkupKind = 'addition' | 'deletion' | 'highlight' | 'comment' | 'substitution';

export interface CriticMarkupMatch {
  kind: CriticMarkupKind;
  from: number;
  to: number;
  raw: string;
  openerFrom: number;
  openerTo: number;
  closerFrom: number;
  closerTo: number;
  contentFrom: number;
  contentTo: number;
  text: string;
  oldText?: string;
  newText?: string;
  separatorFrom?: number;
  separatorTo?: number;
}

function containsLineBreak(text: string): boolean {
  return /[\r\n]/.test(text);
}

function buildSimpleMatch(
  kind: Exclude<CriticMarkupKind, 'substitution'>,
  source: string,
  from: number,
  opener: string,
  closer: string,
): CriticMarkupMatch | null {
  if (!source.startsWith(opener, from)) return null;
  const contentStart = from + opener.length;
  const contentEnd = source.indexOf(closer, contentStart);
  if (contentEnd === -1) return null;

  const text = source.slice(contentStart, contentEnd);
  if (containsLineBreak(text)) return null;

  return {
    kind,
    from,
    to: contentEnd + closer.length,
    raw: source.slice(from, contentEnd + closer.length),
    openerFrom: from,
    openerTo: contentStart,
    closerFrom: contentEnd,
    closerTo: contentEnd + closer.length,
    contentFrom: contentStart,
    contentTo: contentEnd,
    text,
  };
}

function buildSubstitutionMatch(source: string, from: number): CriticMarkupMatch | null {
  if (!source.startsWith('{~~', from)) return null;
  const oldStart = from + 3;
  const separatorFrom = source.indexOf('~>', oldStart);
  if (separatorFrom === -1) return null;
  const closerFrom = source.indexOf('~~}', separatorFrom + 2);
  if (closerFrom === -1) return null;

  const oldText = source.slice(oldStart, separatorFrom);
  const newText = source.slice(separatorFrom + 2, closerFrom);
  if (containsLineBreak(oldText) || containsLineBreak(newText)) return null;

  return {
    kind: 'substitution',
    from,
    to: closerFrom + 3,
    raw: source.slice(from, closerFrom + 3),
    openerFrom: from,
    openerTo: oldStart,
    closerFrom,
    closerTo: closerFrom + 3,
    contentFrom: oldStart,
    contentTo: closerFrom,
    text: source.slice(oldStart, closerFrom),
    oldText,
    newText,
    separatorFrom,
    separatorTo: separatorFrom + 2,
  };
}

export function parseCriticMarkupAt(source: string, from: number): CriticMarkupMatch | null {
  if (from < 0 || from >= source.length || source[from] !== '{') return null;

  const second = source[from + 1];
  if (second === '+') return buildSimpleMatch('addition', source, from, '{++', '++}');
  if (second === '-') return buildSimpleMatch('deletion', source, from, '{--', '--}');
  if (second === '=') return buildSimpleMatch('highlight', source, from, '{==', '==}');
  if (second === '>') return buildSimpleMatch('comment', source, from, '{>>', '<<}');
  if (second === '~') return buildSubstitutionMatch(source, from);
  return null;
}
