export function formatPromptListAnswer(text: string, indent: string): string {
  const normalizePromptListContinuationLine = (line: string): string => {
    if (/^\d+([.)])\s+/.test(line)) {
      return line.replace(/^(\d+)([.)])(\s+)/, '$1\\$2$3');
    }
    if (/^(#|```|~~~)/.test(line)) return `\\${line}`;
    return line;
  };

  const normalized = text.replace(/\r\n?/g, '\n');
  const rawLines = normalized.split('\n').map((line) => line.trimEnd());
  while (rawLines.length > 0 && rawLines[0].trim().length === 0) rawLines.shift();
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim().length === 0) rawLines.pop();
  if (rawLines.length === 0) return '';

  const compactLines: string[] = [];
  let previousBlank = false;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      if (previousBlank) continue;
      compactLines.push('');
      previousBlank = true;
      continue;
    }
    compactLines.push(line);
    previousBlank = false;
  }

  return compactLines
    .map((line, index) => {
      if (index === 0) return line;
      return `${indent}   ${normalizePromptListContinuationLine(line)}`;
    })
    .join('\n');
}
