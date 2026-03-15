import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

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

function isInlinePromptBoundary(char: string | undefined): boolean {
  return char == null || /\s|[([{<"'`]/.test(char);
}

export function findInlinePromptMatch(text: string, position: number): InlinePromptMatch | null {
  const prefix = text.slice(0, position);
  const slashIndex = prefix.lastIndexOf('/');
  if (slashIndex < 0) return null;
  if (!isInlinePromptBoundary(text[slashIndex - 1])) return null;

  const prompt = text.slice(slashIndex + 1, position);
  if (prompt.trim().length === 0) return null;

  return {
    from: slashIndex,
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
