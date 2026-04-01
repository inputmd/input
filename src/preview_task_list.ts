export interface MarkdownTaskToggleResult {
  from: number;
  to: number;
  insert: string;
  nextChecked: boolean;
}

const MARKDOWN_TASK_ITEM_RE = /^([ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)]))([ \t]+\[)([ xX])(\])/gm;

export function toggleNthMarkdownTaskCheckbox(
  markdown: string,
  checkboxIndex: number,
): MarkdownTaskToggleResult | null {
  if (checkboxIndex < 0) return null;

  MARKDOWN_TASK_ITEM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = MARKDOWN_TASK_ITEM_RE.exec(markdown)) !== null) {
    if (index !== checkboxIndex) {
      index += 1;
      continue;
    }

    const marker = match[3] ?? ' ';
    const from = match.index + (match[1]?.length ?? 0) + (match[2]?.length ?? 0);
    const nextChecked = marker === ' ';
    return {
      from,
      to: from + marker.length,
      insert: nextChecked ? 'x' : ' ',
      nextChecked,
    };
  }

  return null;
}
