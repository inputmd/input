// ── Reader AI — Public API ──

export { runReaderAiLoop } from './loop.ts';
// Prompts
export { buildReaderAiPromptListSystemPrompt, buildReaderAiSystemPrompt } from './prompts.ts';
export { createReaderAiSession, ReaderAiSession } from './session.ts';
// Stream parsing
export { parseSseFieldValue, parseUpstreamStream } from './stream.ts';
export type { SubagentOptions, SubagentProgressEvent } from './subagent.ts';
// Subagent
export {
  executeSubagent,
  READER_AI_TASK_MAX_ITERATIONS,
  READER_AI_TASK_MAX_OUTPUT_CHARS,
  READER_AI_TASK_TIMEOUT_MS,
} from './subagent.ts';
// Summarization
export {
  READER_AI_CONTEXT_WINDOW_MESSAGES,
  READER_AI_MAX_SUMMARY_CHARS,
  READER_AI_SUMMARIZE_TIMEOUT_MS,
  summarizeConversation,
} from './summarize.ts';
// Tools (for consumers who want to use tool execution directly)
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
  READER_AI_SUBAGENT_TOOLS,
  READER_AI_TOOL_RESULT_MAX_CHARS,
  READER_AI_TOOLS,
  repairToolArgumentsJson,
} from './tools.ts';
// Types
export type {
  DocumentEditState,
  OpenRouterMessage,
  ReaderAiChatOptions,
  ReaderAiDocumentConfig,
  ReaderAiEditProposalEvent,
  ReaderAiErrorEvent,
  ReaderAiEvent,
  ReaderAiMessage,
  ReaderAiProviderConfig,
  ReaderAiSessionConfig,
  ReaderAiStagedChangeSnapshot,
  ReaderAiStagedChangesEvent,
  ReaderAiSummaryEvent,
  ReaderAiTaskProgressEvent,
  ReaderAiTextDeltaEvent,
  ReaderAiToolCallEvent,
  ReaderAiToolResultEvent,
  ReaderAiTurnEndEvent,
  ReaderAiTurnStartEvent,
  StagedChange,
  StagedHunk,
  StagedHunkLine,
  StreamParseOptions,
  StreamParseResult,
  ToolCall,
} from './types.ts';
// Upstream utilities
export {
  buildPromptCacheControl,
  buildUpstreamHeaders,
  callUpstream,
  callUpstreamNonStreaming,
  isFreeTierModel,
  readUpstreamError,
  readUpstreamRateLimitMessage,
} from './upstream.ts';
