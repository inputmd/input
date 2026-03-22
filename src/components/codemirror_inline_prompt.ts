import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { parseCriticMarkupAt } from '../criticmarkup.ts';

export interface InlinePromptMatch {
  from: number;
  to: number;
  prompt: string;
}

export interface InlinePromptRequest {
  prompt: string;
  from: number;
  to: number;
  documentContent: string;
}

export interface BracePromptRequest {
  prompt: string;
  from: number;
  to: number;
  documentContent: string;
}

export interface BracePromptMatch {
  from: number;
  to: number;
  prompt: string;
}

function startsWithCriticMarkupLikeMarker(text: string): boolean {
  return /^[\t ]*[+\-=~>]/.test(text);
}

function isInlinePromptBoundary(char: string | undefined): boolean {
  return char == null || /\s|[([{<"'`]/.test(char);
}

export function findInlinePromptMatch(text: string, position: number): InlinePromptMatch | null {
  const prefix = text.slice(0, position);
  const slashIndex = prefix.lastIndexOf('/');
  if (slashIndex < 0) return null;
  if (!isInlinePromptBoundary(text[slashIndex - 1])) return null;
  if (/\s/.test(text[slashIndex + 1] ?? '')) return null;

  const prompt = text.slice(slashIndex + 1, position);
  if (prompt.trim().length === 0) return null;

  return {
    from: slashIndex,
    to: position,
    prompt,
  };
}

export function findBracePromptMatch(text: string, position: number): BracePromptMatch | null {
  if (position <= 1 || text[position - 1] !== '}') return null;

  const openIndex = text.lastIndexOf('{', position - 1);
  if (openIndex < 0) return null;
  if (text[openIndex - 1] === '{' || text[position] === '}') return null;
  if (parseCriticMarkupAt(text, openIndex)?.to === position) return null;
  if (text.indexOf('}', openIndex + 1) !== position - 1) return null;

  const prompt = text.slice(openIndex + 1, position - 1);
  if (prompt.includes('{') || prompt.includes('}')) return null;
  if (startsWithCriticMarkupLikeMarker(prompt)) return null;
  if (prompt.trim().length === 0) return null;

  return {
    from: openIndex,
    to: position,
    prompt,
  };
}

function inlinePromptCompletion(prompt: string, onSubmitPrompt: (request: InlinePromptRequest) => void): Completion {
  return {
    label: prompt,
    detail: 'AI',
    type: 'text',
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      onSubmitPrompt({
        prompt,
        from,
        to,
        documentContent: view.state.doc.toString(),
      });
    },
  };
}

export function inlinePromptCompletionSource(
  onSubmitPrompt: (request: InlinePromptRequest) => void,
): (context: CompletionContext) => CompletionResult | null {
  return (context: CompletionContext) => {
    const { state, pos, explicit } = context;
    const line = state.doc.lineAt(pos);
    const match = findInlinePromptMatch(line.text, pos - line.from);
    if (!match) return null;
    if (!explicit && match.prompt.trim().length === 0) return null;

    return {
      from: line.from + match.from,
      to: line.from + match.to,
      options: [inlinePromptCompletion(match.prompt, onSubmitPrompt)],
      filter: false,
    };
  };
}
