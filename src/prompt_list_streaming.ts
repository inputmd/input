export interface PromptListStableTextSplit {
  stable: string;
  remainder: string;
}

function endsWithStableBoundary(text: string): boolean {
  const lastChar = text.at(-1);
  if (!lastChar) return true;
  return /\s/.test(lastChar) || /[.!?;:)\]}'"`]/.test(lastChar);
}

export function splitPromptListStableText(text: string): PromptListStableTextSplit {
  if (!text) return { stable: '', remainder: '' };
  if (endsWithStableBoundary(text)) return { stable: text, remainder: '' };

  let boundaryIndex = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (/\s/.test(text[i])) {
      boundaryIndex = i + 1;
      break;
    }
  }

  if (boundaryIndex <= 0) return { stable: '', remainder: text };
  return {
    stable: text.slice(0, boundaryIndex),
    remainder: text.slice(boundaryIndex),
  };
}
