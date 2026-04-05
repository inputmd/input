// ── Reader AI Standalone Library — Shared Types ──

/** Configuration for the upstream LLM provider (OpenAI-compatible API). */
export interface ReaderAiProviderConfig {
  /** API key (e.g. OpenRouter key). */
  apiKey: string;
  /** Model identifier (e.g. "anthropic/claude-sonnet-4"). */
  model: string;
  /** Base URL for the chat completions API. Defaults to "https://openrouter.ai/api/v1". */
  baseUrl?: string;
  /** Extra headers merged into every upstream request. */
  headers?: Record<string, string>;
  /** Enable prompt caching for supported models (Anthropic via OpenRouter). */
  promptCaching?: boolean;
  /** HTTP-Referer header value sent to the provider. */
  referer?: string;
}

/** Document to analyze. */
export interface ReaderAiDocumentConfig {
  /** Full document text content. */
  content: string;
  /** Display path for the document (e.g. "README.md"). */
  path?: string;
}

/** Full session configuration. */
export interface ReaderAiSessionConfig {
  provider: ReaderAiProviderConfig;
  document: ReaderAiDocumentConfig;
  /** Enable the document edit proposal tools. Default: true. */
  allowEdits?: boolean;
  /** Enable the task (subagent) tool. Default: true. */
  allowSubagents?: boolean;
  /**
   * Restrict to edit-only mode: only read_document, search_document, propose_replace_region,
   * and propose_replace_matches are available (no task/subagent). Used for inline editing
   * flows. Default: false.
   */
  editModeCurrentDocOnly?: boolean;
  /** Total timeout for a chat turn in ms. Default: 360_000. */
  totalTimeoutMs?: number;
  /** Per upstream-call timeout in ms. Default: 60_000. */
  perCallTimeoutMs?: number;
  /** Max agentic loop iterations. Default: 30. */
  maxIterations?: number;
  /** Mode: "default" for document analysis, "prompt_list" for inline conversations. */
  mode?: 'default' | 'prompt_list';
  /** Model context window size in tokens. Used for budget management. Default: 32_000. */
  contextTokens?: number;
  /**
   * Strip CriticMarkup comments ({>> <<}) from the document before processing.
   * Pass a stripping function; if omitted, document content is used as-is.
   */
  stripCriticMarkup?: (text: string) => string;
}

/** A conversation message. */
export interface ReaderAiMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Options for a chat turn. */
export interface ReaderAiChatOptions {
  signal?: AbortSignal;
  /** Pre-existing conversation summary for context window management. */
  summary?: string;
}

// ── Stream events emitted by the chat generator ──

export interface ReaderAiTextDeltaEvent {
  type: 'text_delta';
  delta: string;
}

export interface ReaderAiTurnStartEvent {
  type: 'turn_start';
  iteration: number;
}

export interface ReaderAiTurnEndEvent {
  type: 'turn_end';
  iteration: number;
  reason: 'done' | 'tool_calls' | 'context_budget' | 'timeout';
}

export interface ReaderAiToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  parseError?: string;
  repaired?: boolean;
}

export interface ReaderAiToolResultEvent {
  type: 'tool_result';
  id: string;
  name: string;
  preview: string;
  error?: string;
  repaired?: boolean;
}

export interface ReaderAiEditProposalEvent {
  type: 'edit_proposal';
  proposalId: string;
  toolCallId: string;
  revision: number;
  change: ReaderAiStagedChangeSnapshot;
}

export interface ReaderAiStagedChangesEvent {
  type: 'staged_changes';
  changes: ReaderAiStagedChangeSnapshot[];
  fileContents: Record<string, string>;
  suggestedCommitMessage: string;
  documentContent?: string;
}

export interface ReaderAiTaskProgressEvent {
  type: 'task_progress';
  id: string;
  phase: 'started' | 'iteration_start' | 'tool_call' | 'tool_result' | 'completed' | 'error';
  iteration?: number;
  detail?: string;
}

export interface ReaderAiSummaryEvent {
  type: 'summary';
  summary: string;
}

export interface ReaderAiErrorEvent {
  type: 'error';
  message: string;
}

/** Discriminated union of all events emitted during a chat turn. */
export type ReaderAiEvent =
  | ReaderAiTextDeltaEvent
  | ReaderAiTurnStartEvent
  | ReaderAiTurnEndEvent
  | ReaderAiToolCallEvent
  | ReaderAiToolResultEvent
  | ReaderAiEditProposalEvent
  | ReaderAiStagedChangesEvent
  | ReaderAiTaskProgressEvent
  | ReaderAiSummaryEvent
  | ReaderAiErrorEvent;

// ── Internal types shared across modules ──

export interface ReaderAiStagedChangeSnapshot {
  id: string;
  path: string;
  type: 'edit' | 'create' | 'delete';
  diff: string;
  revision?: number;
  originalContent: string | null;
  modifiedContent: string | null;
  hunks?: StagedHunk[];
}

export interface DocumentReadSnapshot {
  readId: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  visibleText: string;
  sourceAtRead: string;
  truncated: boolean;
}

export interface DocumentEditState {
  source: string;
  lines: string[];
  currentDocPath?: string | null;
  stagedOriginalContent: string | null;
  stagedContent: string | null;
  stagedDiff: string | null;
  stagedRevision: number;
  readSnapshots?: Map<string, DocumentReadSnapshot>;
  nextReadId?: number;
}

export interface StagedHunkLine {
  type: 'context' | 'add' | 'del';
  content: string;
}

export interface StagedHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: StagedHunkLine[];
}

export interface StagedChange {
  id: string;
  path: string;
  type: 'edit' | 'create' | 'delete';
  revision: number;
  original: string | null;
  modified: string | null;
  diff: string;
  hunks: StagedHunk[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamParseResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface StreamParseOptions {
  repairBoundaries?: boolean;
}

export type OpenRouterMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };
