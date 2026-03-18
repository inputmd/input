export type PromptListItemKind = 'question' | 'answer';

export interface PromptListLineMatch {
  indent: string;
  marker: string;
  kind: PromptListItemKind;
  content: string;
  markerEnd: number;
}

const PROMPT_LIST_LINE_RE = /^( {0,3})-(\*|-)([ \t]+)(.*)$/u;

export function matchPromptListLine(text: string): PromptListLineMatch | null {
  const match = PROMPT_LIST_LINE_RE.exec(text);
  if (!match) return null;

  return {
    indent: match[1],
    marker: match[2],
    kind: match[2] === '*' ? 'question' : 'answer',
    content: match[4],
    markerEnd: match[1].length + 1 + match[2].length + match[3].length,
  };
}
