// ── Reader AI Tool Definitions, Execution, and Subagent Support ──
// This file re-exports from the standalone reader-ai library for backward compatibility.

import { executeSubagent, type SubagentProgressEvent } from '../reader-ai/subagent.ts';

export {
  buildReaderAiPromptListSystemPrompt,
  buildReaderAiSystemPrompt,
} from '../reader-ai/prompts.ts';
export {
  parseSseFieldValue,
  parseUpstreamStream as parseReaderAiUpstreamStream,
} from '../reader-ai/stream.ts';
export type { SubagentProgressEvent as ReaderAiSubagentProgressEvent } from '../reader-ai/subagent.ts';
export {
  READER_AI_TASK_MAX_ITERATIONS,
  READER_AI_TASK_MAX_OUTPUT_CHARS,
  READER_AI_TASK_TIMEOUT_MS,
} from '../reader-ai/subagent.ts';
export type {
  DocumentEditState as ReaderAiDocumentEditState,
  StagedChange,
  StagedHunk,
  StagedHunkLine,
  ToolArgumentsParseResult as ReaderAiToolArgumentsParseResult,
} from '../reader-ai/tools.ts';
export {
  compactToolResults,
  createStructuredStagedChange,
  estimateMessagesTokens,
  estimateTokens,
  executeReaderAiEditDocumentTool,
  executeReaderAiReadDocument,
  executeReaderAiSearchDocument,
  executeReaderAiSyncTool,
  executeReaderAiSyncToolWithState,
  generateUnifiedDiff,
  parseReaderAiToolArguments,
  parseToolArgumentsWithRepair,
  parseUnifiedDiffHunks,
  READER_AI_DOC_PREVIEW_CHARS,
  READER_AI_MAX_CONCURRENT_TASKS,
  READER_AI_MAX_REGEX_PATTERN_LENGTH,
  READER_AI_SUBAGENT_TOOLS,
  READER_AI_TOOL_RESULT_MAX_CHARS,
  READER_AI_TOOLS,
  repairToolArgumentsJson,
} from '../reader-ai/tools.ts';
export type {
  OpenRouterMessage,
  StreamParseResult as ReaderAiStreamParseResult,
  ToolCall as ReaderAiToolCall,
} from '../reader-ai/types.ts';
export {
  readUpstreamError,
  readUpstreamRateLimitMessage,
} from '../reader-ai/upstream.ts';

// Re-export the file entry type (still defined here since it's not part of the core library)
export interface ReaderAiFileEntry {
  path: string;
  content: string;
  size: number;
}

// ── Backward-compatible subagent interface ──
// The server's routes.ts uses the old interface shape with model/openRouterHeaders.
// This wrapper adapts it to the new SubagentOptions.

export interface ReaderAiSubagentOptions {
  model: string;
  prompt: string;
  systemPrompt?: string;
  lines: string[];
  source: string;
  openRouterHeaders: Record<string, string>;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
  onProgress?: (event: SubagentProgressEvent) => void;
}

export async function executeReaderAiSubagent(options: ReaderAiSubagentOptions): Promise<string> {
  const apiKey = options.openRouterHeaders.Authorization?.replace('Bearer ', '') ?? '';
  return executeSubagent({
    config: {
      apiKey,
      model: options.model,
      headers: options.openRouterHeaders,
    },
    prompt: options.prompt,
    systemPrompt: options.systemPrompt,
    lines: options.lines,
    source: options.source,
    signal: options.signal,
    fetchFn: options.fetchFn,
    onProgress: options.onProgress,
  });
}
