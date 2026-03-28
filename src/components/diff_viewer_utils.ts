export function findUnifiedDiffReplacementPair(lines: string[], index: number): number | null {
  const line = lines[index];
  if (!line?.startsWith('-') || line.startsWith('---')) return null;

  const next = lines[index + 1];
  if (next?.startsWith('+') && !next.startsWith('+++')) return index + 1;

  const nextAfterBlankContext = lines[index + 2];
  if (next === ' ' && nextAfterBlankContext === '+') return index + 2;

  return null;
}
