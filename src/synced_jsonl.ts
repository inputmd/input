import { parseClaudeCodeJsonl } from './synced_jsonl/claude.ts';
import { parseGenericJsonl } from './synced_jsonl/generic.ts';
import { parseOpenAiCodexJsonl } from './synced_jsonl/openai.ts';
import { isRecord } from './synced_jsonl/shared.ts';
import type { ParsedJsonlLine, ParsedSyncedJsonl } from './synced_jsonl/types.ts';

export * from './synced_jsonl/types.ts';

const FORMAT_HANDLERS = [parseOpenAiCodexJsonl, parseClaudeCodeJsonl] as const;

export function parseSyncedJsonl(content: string, filePath?: string | null): ParsedSyncedJsonl | null {
  const rawLines = content.split(/\r?\n/u);
  const nonEmptyLines = rawLines
    .map((raw, index) => ({ raw, lineNumber: index + 1 }))
    .filter((line) => line.raw.trim().length > 0);
  if (nonEmptyLines.length === 0) return null;

  const normalizedPath = filePath?.trim().toLowerCase() ?? '';
  if (!normalizedPath.endsWith('.jsonl') && nonEmptyLines.length < 2) return null;

  const parsedLines: ParsedJsonlLine[] = [];
  const skippedLineNumbers: number[] = [];
  for (const line of nonEmptyLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.raw);
    } catch {
      skippedLineNumbers.push(line.lineNumber);
      continue;
    }

    if (!isRecord(parsed)) {
      skippedLineNumbers.push(line.lineNumber);
      continue;
    }

    parsedLines.push({ ...line, value: parsed });
  }
  if (parsedLines.length === 0) return null;

  for (const parseFormat of FORMAT_HANDLERS) {
    const parsed = parseFormat(parsedLines, skippedLineNumbers);
    if (parsed) return parsed;
  }

  return parseGenericJsonl(parsedLines, skippedLineNumbers);
}
