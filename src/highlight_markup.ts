export interface HighlightMarkupMatch {
  raw: string;
  text: string;
  from: number;
  to: number;
  openerFrom: number;
  openerTo: number;
  contentFrom: number;
  contentTo: number;
  closerFrom: number;
  closerTo: number;
}

export function parseHighlightMarkupAt(source: string, from: number): HighlightMarkupMatch | null {
  if (source.slice(from, from + 2) !== '::') return null;

  const closeIndex = source.indexOf('::', from + 2);
  if (closeIndex < 0) return null;

  const text = source.slice(from + 2, closeIndex);
  if (text.length === 0 || text.includes('\n') || text.includes('\r')) return null;
  if (text.trim().length === 0) return null;

  return {
    raw: source.slice(from, closeIndex + 2),
    text,
    from,
    to: closeIndex + 2,
    openerFrom: from,
    openerTo: from + 2,
    contentFrom: from + 2,
    contentTo: closeIndex,
    closerFrom: closeIndex,
    closerTo: closeIndex + 2,
  };
}
