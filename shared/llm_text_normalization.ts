const NARROW_NO_BREAK_SPACE = '\u202f';

export function normalizeLlmOutputText(text: string): string {
  return text.includes(NARROW_NO_BREAK_SPACE) ? text.replaceAll(NARROW_NO_BREAK_SPACE, ' ') : text;
}
