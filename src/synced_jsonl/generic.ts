import { buildParsedTree, readString, summarizeUnknownValue } from './shared.ts';
import type { JsonRecord, ParsedGenericJsonl, ParsedJsonlLine } from './types.ts';

function describeGenericJsonlRecord(record: JsonRecord): string {
  const type = readString(record, 'type');
  if (type) return type;

  const keys = Object.keys(record);
  if (keys.length === 0) return 'record';
  return keys.slice(0, 3).join(', ');
}

export function parseGenericJsonl(parsedLines: ParsedJsonlLine[], skippedLineNumbers: number[]): ParsedGenericJsonl {
  const entries = parsedLines.map((line) => ({
    lineNumber: line.lineNumber,
    raw: line.raw,
    type: readString(line.value, 'type') ?? 'record',
    label: describeGenericJsonlRecord(line.value),
    summary: summarizeUnknownValue(line.value),
    value: line.value,
  }));

  return {
    kind: 'generic',
    label: 'Generic JSONL',
    entries,
    tree: buildParsedTree(entries, (entry) => ({
      id: `line:${entry.lineNumber}`,
      parentId: null,
      timestamp: readString(entry.value, 'timestamp') ?? undefined,
    })),
    skippedLineCount: skippedLineNumbers.length,
    skippedLineNumbers,
  };
}
