// ── Reader AI Tool Definitions, Execution, and Subagent Support ──

export const READER_AI_TOOL_RESULT_MAX_CHARS = 30_000;
export const READER_AI_DOC_PREVIEW_CHARS = 12_000;
export const READER_AI_TASK_TIMEOUT_MS = 90_000;
export const READER_AI_TASK_MAX_OUTPUT_CHARS = 60_000;
export const READER_AI_MAX_CONCURRENT_TASKS = 4;
export const READER_AI_TASK_MAX_ITERATIONS = 10;

// Per-tool token budget limits (in characters; ~3 chars per token as rough estimate)
export const READER_AI_READ_FILE_MAX_CHARS = 20_000;
export const READER_AI_SEARCH_FILES_MAX_CHARS = 20_000;
export const READER_AI_LIST_FILES_MAX_CHARS = 10_000;
export const READER_AI_SEARCH_FILES_MAX_MATCHES = 50;

/** A file entry from a loaded repo or gist. */
export interface ReaderAiFileEntry {
  path: string;
  content: string;
  size: number;
}

/**
 * Rough token estimate from character count.
 * ~3.5 chars per token for English text / code is a reasonable approximation.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

/**
 * Estimate token usage of an OpenRouter messages array.
 * This is deliberately rough — used for budget decisions, not billing.
 */
export function estimateMessagesTokens(messages: OpenRouterMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if ('content' in msg && typeof msg.content === 'string') {
      chars += msg.content.length;
    }
    if ('tool_calls' in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        chars += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0) + 20;
      }
    }
  }
  return estimateTokens(chars);
}

/**
 * Compact old tool result messages in the conversation when approaching
 * the context budget. Replaces lengthy tool results from earlier turns
 * with short summaries, preserving the most recent results in full.
 *
 * Returns the number of chars reclaimed.
 */
export function compactToolResults(messages: OpenRouterMessage[], preserveRecentToolResults: number): number {
  // Find all tool result messages
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if ('role' in msg && msg.role === 'tool' && 'tool_call_id' in msg) {
      toolResultIndices.push(i);
    }
  }

  // Preserve the N most recent tool results
  const toCompact = toolResultIndices.slice(0, -preserveRecentToolResults || toolResultIndices.length);
  let reclaimed = 0;

  for (const idx of toCompact) {
    const msg = messages[idx] as { role: 'tool'; tool_call_id: string; content: string };
    const original = msg.content;
    if (original.length <= 200) continue; // already short

    // Produce a compact summary: first 100 chars + size note
    const compacted = `${original.slice(0, 100)}… [${original.length} chars, compacted]`;
    reclaimed += original.length - compacted.length;
    (messages[idx] as { role: 'tool'; tool_call_id: string; content: string }).content = compacted;
  }

  return reclaimed;
}

export interface ReaderAiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ReaderAiStreamParseResult {
  content: string;
  toolCalls: ReaderAiToolCall[];
  finishReason: string;
}

export type OpenRouterMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export const READER_AI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_document',
      description:
        'Read the document content. Returns line-numbered text. Without arguments returns the full document; use start_line/end_line for specific sections. For short documents the full text is already in the system prompt — only call this tool if you need content beyond what is already visible.',
      parameters: {
        type: 'object' as const,
        properties: {
          start_line: {
            type: 'number' as const,
            description: 'First line to return (1-based, inclusive). Omit to start from the beginning.',
          },
          end_line: {
            type: 'number' as const,
            description: 'Last line to return (1-based, inclusive). Omit to read to the end.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_document',
      description:
        'Search the document for lines matching a query. By default uses case-insensitive substring matching. Set is_regex to true for regular expression matching. Returns matching lines with surrounding context and line numbers.',
      parameters: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string' as const,
            description: 'Text to search for, or a regular expression pattern if is_regex is true.',
          },
          is_regex: {
            type: 'boolean' as const,
            description: 'If true, treat query as a regular expression. Default: false.',
          },
          context_lines: {
            type: 'number' as const,
            description: 'Lines of context before/after each match (default: 2, max: 10)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task',
      description:
        'Spawn an independent subagent with its own system prompt and context. The subagent runs a separate LLM session and returns its full output. Use this for tasks that need a fresh perspective or a dedicated role (e.g. an Electric Monk that must believe a position fully, a research agent, a reviewer). The subagent has access to read_document and search_document for the same document. Multiple task calls in the same turn run in parallel (up to 4).',
      parameters: {
        type: 'object' as const,
        properties: {
          prompt: {
            type: 'string' as const,
            description:
              'The full prompt for the subagent. Include its role, instructions, and what output you expect. This becomes the user message in a fresh conversation.',
          },
          system_prompt: {
            type: 'string' as const,
            description:
              'Optional system prompt override for the subagent. If omitted, the subagent gets a minimal system prompt with document access instructions.',
          },
        },
        required: ['prompt'],
      },
    },
  },
];

// ── Project-mode tools (repo/gist with all files loaded) ──

export const READER_AI_PROJECT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description:
        'Read the contents of a file in the project. Returns line-numbered text. Use start_line/end_line to read specific sections of large files.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const, description: 'File path relative to the project root.' },
          start_line: {
            type: 'number' as const,
            description: 'First line to return (1-based, inclusive). Omit to start from the beginning.',
          },
          end_line: {
            type: 'number' as const,
            description: 'Last line to return (1-based, inclusive). Omit to read to the end.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description:
        'Search across all files in the project for lines matching a query. By default uses case-insensitive substring matching. Set is_regex to true for regular expression matching. Returns matching lines grouped by file with line numbers and context. Use glob to filter by file pattern.',
      parameters: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string' as const,
            description: 'Text to search for, or a regular expression pattern if is_regex is true.',
          },
          is_regex: {
            type: 'boolean' as const,
            description: 'If true, treat query as a regular expression. Default: false.',
          },
          glob: {
            type: 'string' as const,
            description:
              'Optional glob pattern to filter files (e.g. "*.ts", "src/**/*.md"). If omitted, searches all files.',
          },
          context_lines: {
            type: 'number' as const,
            description: 'Lines of context before/after each match (default: 2, max: 5).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description:
        'List files in the project. Without arguments returns the full file tree. With a path argument, lists files under that directory.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string' as const,
            description: 'Optional directory path to list. Omit to list all files in the project.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description:
        'Make a surgical edit to a file. Finds the exact old_text in the file and replaces it with new_text. The old_text must match exactly (including whitespace and indentation). Returns a unified diff of the change. Always read_file first to see the current content before editing.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const, description: 'File path relative to the project root.' },
          old_text: { type: 'string' as const, description: 'The exact text to find and replace. Must match exactly.' },
          new_text: { type: 'string' as const, description: 'The replacement text.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_file',
      description:
        'Create a new file in the project. Fails if the file already exists — use edit_file to modify existing files.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const, description: 'File path relative to the project root.' },
          content: { type: 'string' as const, description: 'The full content of the new file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_file',
      description: 'Delete a file from the project.',
      parameters: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const, description: 'File path relative to the project root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'task',
      description:
        'Spawn an independent subagent with its own system prompt and context. The subagent runs a separate LLM session and returns its full output. Use this for tasks that need a fresh perspective or a dedicated role (e.g. a reviewer, a research agent). The subagent has access to read_file, search_files, and list_files for the same project (read-only). Multiple task calls in the same turn run in parallel (up to 4).',
      parameters: {
        type: 'object' as const,
        properties: {
          prompt: {
            type: 'string' as const,
            description:
              'The full prompt for the subagent. Include its role, instructions, and what output you expect.',
          },
          system_prompt: {
            type: 'string' as const,
            description:
              'Optional system prompt override for the subagent. If omitted, the subagent gets a minimal system prompt with project access instructions.',
          },
        },
        required: ['prompt'],
      },
    },
  },
];

// Subagent tools — subset available to task subagents (no nested task spawning)
export const READER_AI_SUBAGENT_TOOLS = READER_AI_TOOLS.filter((t) => t.function.name !== 'task');
export const READER_AI_PROJECT_SUBAGENT_TOOLS = READER_AI_PROJECT_TOOLS.filter((t) => t.function.name !== 'task');

export function executeReaderAiReadDocument(lines: string[], args: { start_line?: number; end_line?: number }): string {
  const total = lines.length;
  const start = Math.max(1, Math.floor(args.start_line ?? 1));
  const end = Math.min(total, Math.floor(args.end_line ?? total));
  if (start > total) return `(start_line ${start} is beyond the document, which has ${total} lines)`;
  if (start > end) return `(invalid range: start_line ${start} > end_line ${end})`;
  const selected = lines.slice(start - 1, end);
  const numbered = selected.map((line, i) => `${start + i}: ${line}`);
  const result = numbered.join('\n');
  if (result.length > READER_AI_TOOL_RESULT_MAX_CHARS) {
    let charCount = 0;
    let lastFittingLine = start;
    for (let i = 0; i < numbered.length; i++) {
      charCount += numbered[i].length + 1;
      if (charCount > READER_AI_TOOL_RESULT_MAX_CHARS) break;
      lastFittingLine = start + i;
    }
    return (
      result.slice(0, READER_AI_TOOL_RESULT_MAX_CHARS) +
      `\n\n... (truncated; showing lines ${start}-${lastFittingLine} of ${total}; use start_line/end_line to read specific ranges)`
    );
  }
  return result;
}

export function executeReaderAiSearchDocument(
  lines: string[],
  args: { query: string; is_regex?: boolean; context_lines?: number },
): string {
  if (!args.query) return '(query is required)';
  const matcher = buildLineMatcher(args.query, args.is_regex);
  if (!matcher) return `(invalid regular expression: ${args.query})`;
  const ctx = Math.max(0, Math.min(args.context_lines ?? 2, 10));
  const matchIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matcher(lines[i])) matchIndices.push(i);
  }
  if (matchIndices.length === 0) return 'No matches found.';

  const ranges: Array<[number, number]> = [];
  for (const idx of matchIndices) {
    const rStart = Math.max(0, idx - ctx);
    const rEnd = Math.min(lines.length - 1, idx + ctx);
    if (ranges.length > 0 && rStart <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = rEnd;
    } else {
      ranges.push([rStart, rEnd]);
    }
  }

  const matchSet = new Set(matchIndices);
  const parts: string[] = [`${matchIndices.length} match${matchIndices.length === 1 ? '' : 'es'} found.\n`];
  for (const [rStart, rEnd] of ranges) {
    for (let i = rStart; i <= rEnd; i++) {
      const marker = matchSet.has(i) ? '>' : ' ';
      parts.push(`${marker} ${i + 1}: ${lines[i]}`);
    }
    parts.push('---');
  }

  const result = parts.join('\n');
  if (result.length > READER_AI_TOOL_RESULT_MAX_CHARS) {
    return `${result.slice(0, READER_AI_TOOL_RESULT_MAX_CHARS)}\n\n... (too many matches, try a more specific query)`;
  }
  return result;
}

// ── Staged changes (in-memory editing layer) ──

export interface StagedChange {
  path: string;
  type: 'edit' | 'create' | 'delete';
  /** Original content (null for creates). */
  original: string | null;
  /** Modified content (null for deletes). */
  modified: string | null;
  /** Unified diff for display. */
  diff: string;
}

/**
 * Mutable staging area for file edits during an agentic loop.
 * Tracks accumulated changes without modifying the original file entries.
 */
export class StagedChanges {
  private changes = new Map<string, StagedChange>();
  private workingFiles: Map<string, string>;

  constructor(files: ReaderAiFileEntry[]) {
    this.workingFiles = new Map(files.map((f) => [f.path, f.content]));
  }

  /** Get the current working content of a file (with staged edits applied). */
  getContent(path: string): string | undefined {
    return this.workingFiles.get(path);
  }

  /** Check if a file exists in the working set (including creates, excluding deletes). */
  hasFile(path: string): boolean {
    return this.workingFiles.has(path);
  }

  /** Get all files as ReaderAiFileEntry[] reflecting staged changes. */
  getWorkingFiles(): ReaderAiFileEntry[] {
    const result: ReaderAiFileEntry[] = [];
    for (const [path, content] of this.workingFiles) {
      result.push({ path, content, size: content.length });
    }
    return result;
  }

  editFile(path: string, oldText: string, newText: string): string {
    const content = this.workingFiles.get(path);
    if (content === undefined) return `(file not found: ${path})`;
    if (oldText === newText) return '(old_text and new_text are identical — no change made)';

    const index = content.indexOf(oldText);
    if (index === -1) {
      // Try to give a helpful error
      const lower = content.toLowerCase();
      const lowerOld = oldText.toLowerCase();
      if (lower.includes(lowerOld)) {
        return '(old_text not found — a case-insensitive match exists. The old_text must match exactly, including case.)';
      }
      return '(old_text not found in file — it must match the file content exactly, including whitespace and indentation. Use read_file to verify the current content.)';
    }

    // Check for ambiguity — multiple matches
    const secondIndex = content.indexOf(oldText, index + 1);
    if (secondIndex !== -1) {
      return '(old_text matches multiple locations in the file — provide more surrounding context to make it unique.)';
    }

    const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
    this.workingFiles.set(path, updated);

    const existing = this.changes.get(path);
    const original = existing?.original ?? content;
    const diff = generateUnifiedDiff(path, original, updated);
    this.changes.set(path, { path, type: 'edit', original, modified: updated, diff });

    return `Edited ${path}:\n${diff}`;
  }

  createFile(path: string, content: string): string {
    if (this.workingFiles.has(path)) {
      return `(file already exists: ${path} — use edit_file to modify it)`;
    }
    this.workingFiles.set(path, content);
    const diff = generateUnifiedDiff(path, '', content);
    this.changes.set(path, { path, type: 'create', original: null, modified: content, diff });
    return `Created ${path} (${content.length} bytes):\n${diff}`;
  }

  deleteFile(path: string): string {
    const content = this.workingFiles.get(path);
    if (content === undefined) return `(file not found: ${path})`;
    this.workingFiles.delete(path);
    const existing = this.changes.get(path);
    const original = existing?.original ?? content;
    const diff = generateUnifiedDiff(path, original, '');
    this.changes.set(path, { path, type: 'delete', original, modified: null, diff });
    return `Deleted ${path}`;
  }

  getChanges(): StagedChange[] {
    return [...this.changes.values()];
  }

  hasChanges(): boolean {
    return this.changes.size > 0;
  }

  /** Discard all staged changes and restore original file contents. */
  reset(files: ReaderAiFileEntry[]): void {
    this.changes.clear();
    this.workingFiles = new Map(files.map((f) => [f.path, f.content]));
  }
}

/** Generate a simple unified diff between two strings. */
export function generateUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent ? oldContent.split('\n') : [];
  const newLines = newContent ? newContent.split('\n') : [];
  const result: string[] = [`--- a/${path}`, `+++ b/${path}`];

  // Simple diff: find changed regions by comparing lines
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    // Find next difference
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    // Found a difference — collect the hunk
    const hunkStartOld = Math.max(0, i - 3);
    const hunkStartNew = Math.max(0, j - 3);

    // Find the end of the differing region
    let diffEndOld = i;
    let diffEndNew = j;

    // Advance through differing lines
    while (diffEndOld < oldLines.length || diffEndNew < newLines.length) {
      if (
        diffEndOld < oldLines.length &&
        diffEndNew < newLines.length &&
        oldLines[diffEndOld] === newLines[diffEndNew]
      ) {
        // Check if we have 3 matching lines (end of hunk)
        let matchCount = 0;
        while (
          diffEndOld + matchCount < oldLines.length &&
          diffEndNew + matchCount < newLines.length &&
          oldLines[diffEndOld + matchCount] === newLines[diffEndNew + matchCount]
        ) {
          matchCount++;
          if (matchCount >= 3) break;
        }
        if (matchCount >= 3) break;
        diffEndOld++;
        diffEndNew++;
      } else {
        if (diffEndOld < oldLines.length) diffEndOld++;
        if (diffEndNew < newLines.length) diffEndNew++;
      }
    }

    const hunkEndOld = Math.min(oldLines.length, diffEndOld + 3);
    const hunkEndNew = Math.min(newLines.length, diffEndNew + 3);

    result.push(
      `@@ -${hunkStartOld + 1},${hunkEndOld - hunkStartOld} +${hunkStartNew + 1},${hunkEndNew - hunkStartNew} @@`,
    );

    // Context before
    for (let k = hunkStartOld; k < i; k++) {
      result.push(` ${oldLines[k]}`);
    }
    // Removed lines
    for (let k = i; k < diffEndOld; k++) {
      result.push(`-${oldLines[k]}`);
    }
    // Added lines
    for (let k = j; k < diffEndNew; k++) {
      result.push(`+${newLines[k]}`);
    }
    // Context after
    for (let k = diffEndOld; k < hunkEndOld; k++) {
      result.push(` ${oldLines[k]}`);
    }

    i = hunkEndOld;
    j = hunkEndNew;
  }

  if (result.length === 2) return '(no changes)';
  return result.join('\n');
}

/** Build a line-matching function from query + is_regex flag. Returns null on invalid regex. */
function buildLineMatcher(query: string, isRegex?: boolean): ((line: string) => boolean) | null {
  if (isRegex) {
    try {
      const re = new RegExp(query, 'i');
      return (line: string) => re.test(line);
    } catch {
      return null;
    }
  }
  const lower = query.toLowerCase();
  return (line: string) => line.toLowerCase().includes(lower);
}

// ── Project-mode tool execution ──

function simpleGlobMatch(pattern: string, filePath: string): boolean {
  // Convert glob to regex: * matches non-slash, ** matches anything, ? matches single char
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path segment(s)
        regex += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // skip trailing slash after **
        continue;
      }
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex metacharacters, not a template
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i++;
  }
  try {
    return new RegExp(`^${regex}$`, 'i').test(filePath);
  } catch {
    return filePath.includes(pattern);
  }
}

export function executeReaderAiReadFile(
  files: ReaderAiFileEntry[],
  args: { path: string; start_line?: number; end_line?: number },
): string {
  const file = files.find((f) => f.path === args.path);
  if (!file) {
    // Try case-insensitive and prefix match
    const lower = args.path.toLowerCase();
    const fuzzy = files.find((f) => f.path.toLowerCase() === lower);
    if (fuzzy) return executeReaderAiReadFile(files, { ...args, path: fuzzy.path });
    return `(file not found: ${args.path})`;
  }
  const lines = file.content.split('\n');
  const total = lines.length;
  const start = Math.max(1, Math.floor(args.start_line ?? 1));
  const end = Math.min(total, Math.floor(args.end_line ?? total));
  if (start > total) return `(start_line ${start} is beyond the file, which has ${total} lines)`;
  if (start > end) return `(invalid range: start_line ${start} > end_line ${end})`;
  const selected = lines.slice(start - 1, end);
  const numbered = selected.map((line, i) => `${start + i}: ${line}`);
  const result = `${args.path} (${total} lines)\n${numbered.join('\n')}`;
  if (result.length > READER_AI_READ_FILE_MAX_CHARS) {
    let charCount = 0;
    let lastFittingLine = start;
    for (let i = 0; i < numbered.length; i++) {
      charCount += numbered[i].length + 1;
      if (charCount > READER_AI_READ_FILE_MAX_CHARS) break;
      lastFittingLine = start + i;
    }
    return (
      result.slice(0, READER_AI_READ_FILE_MAX_CHARS) +
      `\n\n... (truncated; showing lines ${start}-${lastFittingLine} of ${total}; use start_line/end_line to read specific ranges)`
    );
  }
  return result;
}

export function executeReaderAiSearchFiles(
  files: ReaderAiFileEntry[],
  args: { query: string; is_regex?: boolean; glob?: string; context_lines?: number },
): string {
  if (!args.query) return '(query is required)';
  const matcher = buildLineMatcher(args.query, args.is_regex);
  if (!matcher) return `(invalid regular expression: ${args.query})`;
  const ctx = Math.max(0, Math.min(args.context_lines ?? 2, 5));
  const candidates = args.glob ? files.filter((f) => simpleGlobMatch(args.glob!, f.path)) : files;
  if (candidates.length === 0 && args.glob) return `No files matching glob "${args.glob}".`;

  const parts: string[] = [];
  let totalMatches = 0;
  let totalChars = 0;

  for (const file of candidates) {
    if (totalMatches >= READER_AI_SEARCH_FILES_MAX_MATCHES || totalChars >= READER_AI_SEARCH_FILES_MAX_CHARS) break;
    const lines = file.content.split('\n');
    const matchIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) matchIndices.push(i);
    }
    if (matchIndices.length === 0) continue;

    // Merge ranges
    const ranges: Array<[number, number]> = [];
    for (const idx of matchIndices) {
      const rStart = Math.max(0, idx - ctx);
      const rEnd = Math.min(lines.length - 1, idx + ctx);
      if (ranges.length > 0 && rStart <= ranges[ranges.length - 1][1] + 1) {
        ranges[ranges.length - 1][1] = rEnd;
      } else {
        ranges.push([rStart, rEnd]);
      }
    }

    const matchSet = new Set(matchIndices);
    const fileParts: string[] = [
      `\n${file.path} (${matchIndices.length} match${matchIndices.length === 1 ? '' : 'es'}):`,
    ];
    for (const [rStart, rEnd] of ranges) {
      for (let i = rStart; i <= rEnd; i++) {
        const marker = matchSet.has(i) ? '>' : ' ';
        fileParts.push(`${marker} ${i + 1}: ${lines[i]}`);
      }
      fileParts.push('---');
    }
    const section = fileParts.join('\n');
    totalChars += section.length;
    totalMatches += matchIndices.length;
    parts.push(section);
  }

  if (parts.length === 0) return 'No matches found.';

  let result = `${totalMatches} match${totalMatches === 1 ? '' : 'es'} across ${parts.length} file${parts.length === 1 ? '' : 's'}.\n${parts.join('\n')}`;
  if (totalMatches >= READER_AI_SEARCH_FILES_MAX_MATCHES) {
    result += `\n\n... (showing first ${READER_AI_SEARCH_FILES_MAX_MATCHES} matches; use a more specific query or glob to narrow results)`;
  }
  if (result.length > READER_AI_SEARCH_FILES_MAX_CHARS) {
    result =
      result.slice(0, READER_AI_SEARCH_FILES_MAX_CHARS) +
      '\n\n... (results truncated; try a more specific query or glob)';
  }
  return result;
}

export function executeReaderAiListFiles(files: ReaderAiFileEntry[], args: { path?: string }): string {
  let filtered = files;
  if (args.path) {
    const prefix = args.path.endsWith('/') ? args.path : `${args.path}/`;
    filtered = files.filter((f) => f.path.startsWith(prefix) || f.path === args.path!.replace(/\/$/, ''));
    if (filtered.length === 0) return `(no files under path: ${args.path})`;
  }

  const lines = filtered.map((f) => {
    const sizeKb = f.size >= 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
    return `${f.path}  (${sizeKb})`;
  });
  const result = `${filtered.length} file${filtered.length === 1 ? '' : 's'}${args.path ? ` under ${args.path}` : ''}:\n${lines.join('\n')}`;
  if (result.length > READER_AI_LIST_FILES_MAX_CHARS) {
    return `${result.slice(0, READER_AI_LIST_FILES_MAX_CHARS)}\n\n... (file list truncated)`;
  }
  return result;
}

/** Execute a synchronous (non-task) tool — document mode. */
export function executeReaderAiSyncTool(toolName: string, argsJson: string, lines: string[]): string {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return `(invalid JSON arguments: ${argsJson})`;
  }
  switch (toolName) {
    case 'read_document':
      return executeReaderAiReadDocument(lines, args as { start_line?: number; end_line?: number });
    case 'search_document':
      return executeReaderAiSearchDocument(
        lines,
        args as { query: string; is_regex?: boolean; context_lines?: number },
      );
    default:
      return `(unknown tool: ${toolName})`;
  }
}

/** Execute a synchronous (non-task) tool — project mode. */
export function executeReaderAiProjectSyncTool(
  toolName: string,
  argsJson: string,
  files: ReaderAiFileEntry[],
  stagedChanges?: StagedChanges,
): string {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return `(invalid JSON arguments: ${argsJson})`;
  }
  // For read/search/list, use the working file set if staging is active
  const workingFiles = stagedChanges ? stagedChanges.getWorkingFiles() : files;
  switch (toolName) {
    case 'read_file':
      return executeReaderAiReadFile(workingFiles, args as { path: string; start_line?: number; end_line?: number });
    case 'search_files':
      return executeReaderAiSearchFiles(
        workingFiles,
        args as { query: string; is_regex?: boolean; glob?: string; context_lines?: number },
      );
    case 'list_files':
      return executeReaderAiListFiles(workingFiles, args as { path?: string });
    case 'edit_file': {
      if (!stagedChanges) return '(edit_file is not available in read-only mode)';
      const a = args as { path?: string; old_text?: string; new_text?: string };
      if (!a.path) return '(path is required)';
      if (typeof a.old_text !== 'string') return '(old_text is required)';
      if (typeof a.new_text !== 'string') return '(new_text is required)';
      return stagedChanges.editFile(a.path, a.old_text, a.new_text);
    }
    case 'create_file': {
      if (!stagedChanges) return '(create_file is not available in read-only mode)';
      const a = args as { path?: string; content?: string };
      if (!a.path) return '(path is required)';
      if (typeof a.content !== 'string') return '(content is required)';
      return stagedChanges.createFile(a.path, a.content);
    }
    case 'delete_file': {
      if (!stagedChanges) return '(delete_file is not available in read-only mode)';
      const a = args as { path?: string };
      if (!a.path) return '(path is required)';
      return stagedChanges.deleteFile(a.path);
    }
    default:
      return `(unknown tool: ${toolName})`;
  }
}

export function parseSseFieldValue(line: string, prefix: 'data:'): string {
  let value = line.slice(prefix.length);
  if (value.startsWith(' ')) value = value.slice(1);
  return value;
}

export async function parseReaderAiUpstreamStream(
  body: ReadableStream<Uint8Array>,
  onTextDelta: (delta: string) => void,
): Promise<ReaderAiStreamParseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = '';
  const accumulators = new Map<number, { id: string; name: string; arguments: string }>();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => parseSseFieldValue(line, 'data:'));
        const data = dataLines.join('');
        if (!data || data === '[DONE]') {
          boundary = buffer.indexOf('\n\n');
          continue;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
          const choice = parsed.choices?.[0];
          if (!choice) {
            boundary = buffer.indexOf('\n\n');
            continue;
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (delta?.content) {
            content += delta.content;
            onTextDelta(delta.content);
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulators.has(idx)) accumulators.set(idx, { id: '', name: '', arguments: '' });
              const acc = accumulators.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }
        } catch {
          // ignore malformed chunks
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls: ReaderAiToolCall[] = [];
  for (const [, acc] of [...accumulators.entries()].sort((a, b) => a[0] - b[0])) {
    if (acc.name) {
      toolCalls.push({
        id: acc.id || `tool_${Date.now()}_${toolCalls.length}`,
        name: acc.name,
        arguments: acc.arguments,
      });
    }
  }
  return { content, toolCalls, finishReason };
}

export function buildReaderAiSystemPrompt(source: string, lines: string[], maxPreviewChars: number): string {
  const totalLines = lines.length;
  const totalChars = source.length;

  let docSection: string;
  if (totalChars <= maxPreviewChars) {
    const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    docSection = `The full document is included below (${totalLines} lines). You already have the complete text — do not call read_document unless the user asks you to re-examine specific line ranges.\n\n<document>\n${numbered}\n</document>`;
  } else {
    let previewEnd = 0;
    let previewChars = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = `${i + 1}: ${lines[i]}\n`.length;
      if (previewChars + lineLen > maxPreviewChars && i > 0) break;
      previewChars += lineLen;
      previewEnd = i + 1;
    }
    const preview = lines
      .slice(0, previewEnd)
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');
    docSection = `A preview of the document is included below (first ${previewEnd} of ${totalLines} lines). Use the read_document and search_document tools for full access.\n\n<document-preview>\n${preview}\n</document-preview>`;
  }

  return [
    'You are a helpful assistant that answers questions about a document.',
    '',
    'You have tools available:',
    '- read_document: Read all or part of the document by line range. Returns numbered lines.',
    '- search_document: Search for text in the document (case-insensitive). Returns matching lines with context.',
    '- task: Spawn an independent subagent with its own system prompt and fresh context. The subagent can read and search the document but cannot spawn further subagents. Use this when you need a separate perspective, a dedicated role (e.g. a reviewer or advocate), or parallel research. Multiple task calls in the same response run concurrently. Each subagent returns its complete output as the tool result.',
    '',
    'Guidelines:',
    '- For specific questions, use search_document to find relevant sections.',
    '- Cite line numbers when referencing specific parts.',
    '- If the document content already visible contains the answer, respond directly without tools.',
    '- If the document lacks the answer, say so plainly.',
    '- Use the task tool when a problem benefits from independent analysis by a subagent with a dedicated role or perspective.',
    '',
    `Document info: ${totalLines} lines, ${totalChars} characters.`,
    '',
    docSection,
  ].join('\n');
}

function buildFileTree(files: ReaderAiFileEntry[]): string {
  const lines: string[] = [];
  for (const f of files) {
    const sizeKb = f.size >= 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
    lines.push(`${f.path}  (${sizeKb})`);
  }
  return lines.join('\n');
}

export function buildReaderAiProjectSystemPrompt(files: ReaderAiFileEntry[], currentDocPath: string | null): string {
  const fileTree = buildFileTree(files);
  const totalFiles = files.length;
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const totalSizeLabel =
    totalSize >= 1024 * 1024
      ? `${(totalSize / 1024 / 1024).toFixed(1)}MB`
      : totalSize >= 1024
        ? `${(totalSize / 1024).toFixed(1)}KB`
        : `${totalSize}B`;

  const currentDocSection = currentDocPath ? `\nThe user is currently viewing: ${currentDocPath}` : '';

  return [
    'You are an assistant with full access to a project. You can read any file, search across the codebase, analyze the project structure, and make edits.',
    '',
    'You have tools available:',
    '- read_file: Read a file by path. Returns line-numbered text. Use start_line/end_line for specific sections.',
    '- search_files: Search across all files for matching text (case-insensitive). Use glob to filter by file pattern.',
    '- list_files: List files in the project or a subdirectory.',
    '- edit_file: Make a surgical edit — find exact old_text and replace with new_text. Always read_file first.',
    '- create_file: Create a new file. Fails if the file already exists.',
    '- delete_file: Delete a file from the project.',
    '- task: Spawn an independent subagent for parallel or specialized work (read-only access).',
    '',
    'Guidelines:',
    '- Use search_files to locate relevant code before answering questions about the project.',
    '- Use read_file to examine files in detail. Always read a file before editing it.',
    '- For edit_file, old_text must match exactly — including whitespace and indentation.',
    '- Cite file paths and line numbers when referencing specific code.',
    '- If you need to understand project structure, start with list_files.',
    '- If the answer is not in the project, say so plainly.',
    '- Use the task tool when a problem benefits from independent analysis.',
    '- Prefer targeted reads and searches over reading entire large files.',
    '- All edits are staged for user review — they are not applied until the user approves them.',
    '',
    `Project: ${totalFiles} files, ${totalSizeLabel} total.${currentDocSection}`,
    '',
    '<file-tree>',
    fileTree,
    '</file-tree>',
  ].join('\n');
}

export function readUpstreamError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const errorObj = 'error' in payload ? (payload as { error?: unknown }).error : null;
  if (!errorObj || typeof errorObj !== 'object') return null;
  const message = (errorObj as { message?: unknown }).message;
  return typeof message === 'string' && message ? message : null;
}

export interface ReaderAiSubagentOptions {
  model: string;
  prompt: string;
  systemPrompt?: string;
  /** Document mode: lines of the current document. */
  lines: string[];
  source: string;
  /** Project mode: all files in the repo/gist. When set, subagent uses project tools. */
  projectFiles?: ReaderAiFileEntry[];
  openRouterHeaders: Record<string, string>;
  signal: AbortSignal;
  /** Override fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export async function executeReaderAiSubagent(options: ReaderAiSubagentOptions): Promise<string> {
  const { model, prompt, lines, source, projectFiles, openRouterHeaders, signal, fetchFn = fetch } = options;
  const isProjectMode = projectFiles && projectFiles.length > 0;

  const defaultSystemPrompt = isProjectMode
    ? [
        'You are a focused subagent working on a specific task. You have access to the project files via tools.',
        '',
        'Available tools:',
        '- read_file: Read a file by path. Returns line-numbered text.',
        '- search_files: Search across all files (case-insensitive). Use glob to filter.',
        '- list_files: List files in the project.',
        '',
        `Project: ${projectFiles.length} files.`,
        '',
        'Complete the task described in the user message. Be thorough and detailed.',
      ].join('\n')
    : [
        'You are a focused subagent working on a specific task. You have access to a document via tools.',
        '',
        'Available tools:',
        '- read_document: Read all or part of the document by line range.',
        '- search_document: Search for text in the document (case-insensitive).',
        '',
        `Document info: ${lines.length} lines, ${source.length} characters.`,
        '',
        'Complete the task described in the user message. Be thorough and detailed in your response.',
      ].join('\n');

  const systemPrompt = options.systemPrompt || defaultSystemPrompt;
  const tools = isProjectMode ? READER_AI_PROJECT_SUBAGENT_TOOLS : READER_AI_SUBAGENT_TOOLS;

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  let output = '';

  for (let iteration = 0; iteration < READER_AI_TASK_MAX_ITERATIONS; iteration++) {
    const upstream = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: openRouterHeaders,
      body: JSON.stringify({
        model,
        stream: true,
        messages,
        tools,
      }),
      signal: AbortSignal.any([AbortSignal.timeout(READER_AI_TASK_TIMEOUT_MS), signal]),
    });

    if (!upstream.ok) {
      const payload = (await upstream.json().catch(() => null)) as unknown;
      const detail = readUpstreamError(payload) || `Subagent request failed (${upstream.status})`;
      return output ? `${output}\n\n[Subagent error: ${detail}]` : `[Subagent error: ${detail}]`;
    }
    if (!upstream.body) {
      return output ? `${output}\n\n[Subagent error: no response body]` : '[Subagent error: no response body]';
    }

    const result = await parseReaderAiUpstreamStream(upstream.body, (delta) => {
      output += delta;
    });

    if (result.toolCalls.length === 0) break;

    // Process tool calls within subagent
    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const tc of result.toolCalls) {
      const toolResult = isProjectMode
        ? executeReaderAiProjectSyncTool(tc.name, tc.arguments, projectFiles)
        : executeReaderAiSyncTool(tc.name, tc.arguments, lines);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }

  if (output.length > READER_AI_TASK_MAX_OUTPUT_CHARS) {
    return (
      output.slice(0, READER_AI_TASK_MAX_OUTPUT_CHARS) +
      `\n\n... (subagent output truncated at ${READER_AI_TASK_MAX_OUTPUT_CHARS} characters)`
    );
  }
  return output || '(subagent produced no output)';
}
