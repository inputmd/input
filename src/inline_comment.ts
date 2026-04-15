export interface InlineCommentMatch {
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

export function parseInlineCommentAt(source: string, from: number): InlineCommentMatch | null {
  if (source.slice(from, from + 2) !== '++') return null;

  const closeIndex = source.indexOf('++', from + 2);
  if (closeIndex < 0) return null;

  const rawText = source.slice(from + 2, closeIndex);
  if (rawText.includes('\n') || rawText.includes('\r')) return null;

  const text = rawText.trim();
  if (text.length === 0) return null;

  const leadingPadding = rawText.length - rawText.trimStart().length;
  const trailingPadding = rawText.length - rawText.trimEnd().length;
  const contentFrom = from + 2 + leadingPadding;
  const contentTo = closeIndex - trailingPadding;

  return {
    raw: source.slice(from, closeIndex + 2),
    text,
    from,
    to: closeIndex + 2,
    openerFrom: from,
    openerTo: from + 2,
    contentFrom,
    contentTo,
    closerFrom: closeIndex,
    closerTo: closeIndex + 2,
  };
}
