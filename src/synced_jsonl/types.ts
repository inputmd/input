export type JsonRecord = Record<string, unknown>;

export type SyncedJsonlKind = 'openai-codex' | 'claude-code' | 'generic';

export interface ParsedJsonlLine {
  lineNumber: number;
  raw: string;
  value: JsonRecord;
}

export interface ParsedSyncedJsonlEntry<TValue extends object = JsonRecord> {
  lineNumber: number;
  raw: string;
  type: string;
  label: string;
  summary?: string;
  value: TValue;
}

export interface ParsedSyncedJsonlTreeNode<TValue extends object = JsonRecord> {
  id: string;
  parentId: string | null;
  lineNumber: number;
  raw: string;
  type: string;
  label: string;
  summary?: string;
  timestamp?: string;
  relation: 'root' | 'child' | 'orphan';
  resolvedLabel?: string;
  value: TValue;
  children: ParsedSyncedJsonlTreeNode<TValue>[];
}

export interface ParsedSyncedJsonlTree<TValue extends object = JsonRecord> {
  roots: ParsedSyncedJsonlTreeNode<TValue>[];
  standaloneEntries: ParsedSyncedJsonlEntry<TValue>[];
}

export interface ParsedOpenAiCodexJsonl {
  kind: 'openai-codex';
  label: 'OpenAI Codex';
  entries: ParsedSyncedJsonlEntry<OpenAiCodexJsonlEvent>[];
  tree: ParsedSyncedJsonlTree<OpenAiCodexJsonlEvent>;
  skippedLineCount: number;
  skippedLineNumbers: number[];
}

export interface ParsedClaudeCodeJsonl {
  kind: 'claude-code';
  label: 'Claude Code';
  entries: ParsedSyncedJsonlEntry<ClaudeCodeJsonlEvent>[];
  tree: ParsedSyncedJsonlTree<ClaudeCodeJsonlEvent>;
  skippedLineCount: number;
  skippedLineNumbers: number[];
}

export interface ParsedGenericJsonl {
  kind: 'generic';
  label: 'Generic JSONL';
  entries: ParsedSyncedJsonlEntry<JsonRecord>[];
  tree: ParsedSyncedJsonlTree<JsonRecord>;
  skippedLineCount: number;
  skippedLineNumbers: number[];
}

export type ParsedSyncedJsonl = ParsedOpenAiCodexJsonl | ParsedClaudeCodeJsonl | ParsedGenericJsonl;

export interface OpenAiCodexSessionEvent {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface OpenAiCodexModelChangeEvent {
  type: 'model_change';
  id: string;
  parentId: string | null;
  timestamp: string;
  provider: string;
  modelId: string;
}

export interface OpenAiCodexThinkingLevelChangeEvent {
  type: 'thinking_level_change';
  id: string;
  parentId: string | null;
  timestamp: string;
  thinkingLevel: string;
}

export interface OpenAiCodexTextContentPart {
  type: 'text';
  text: string;
  textSignature?: string;
}

export interface OpenAiCodexThinkingContentPart {
  type: 'thinking';
  thinking: string;
  thinkingSignature: string;
}

export interface OpenAiCodexToolCallContentPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: JsonRecord;
  partialJson: string;
}

export type OpenAiCodexUnknownContentPart = JsonRecord & { type: string };

export type OpenAiCodexMessageContentPart =
  | OpenAiCodexTextContentPart
  | OpenAiCodexThinkingContentPart
  | OpenAiCodexToolCallContentPart
  | OpenAiCodexUnknownContentPart;

export interface OpenAiCodexUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface OpenAiCodexUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: OpenAiCodexUsageCost;
}

export interface OpenAiCodexUserMessage {
  role: 'user';
  content: OpenAiCodexTextContentPart[];
  timestamp: number;
}

export interface OpenAiCodexAssistantMessage {
  role: 'assistant';
  content: OpenAiCodexMessageContentPart[];
  api: string;
  provider: string;
  model: string;
  usage: OpenAiCodexUsage;
  stopReason: string;
  timestamp: number;
  responseId: string;
  errorMessage?: string;
}

export interface OpenAiCodexToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: OpenAiCodexTextContentPart[];
  isError: boolean;
  timestamp: number;
}

export type OpenAiCodexMessage = OpenAiCodexUserMessage | OpenAiCodexAssistantMessage | OpenAiCodexToolResultMessage;

export interface OpenAiCodexMessageEvent {
  type: 'message';
  id: string;
  parentId: string | null;
  timestamp: string;
  message: OpenAiCodexMessage;
}

export interface OpenAiCodexCompactionEvent {
  type: 'compaction';
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
  fromHook?: boolean;
}

export interface OpenAiCodexCustomEvent {
  type: 'custom';
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data: unknown;
}

export interface OpenAiCodexSessionInfoEvent {
  type: 'session_info';
  id: string;
  parentId: string | null;
  timestamp: string;
  name: string;
}

export interface OpenAiCodexCustomMessageEvent {
  type: 'custom_message';
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  content: unknown;
  display?: boolean;
  details?: unknown;
}

export interface OpenAiCodexLabelEvent {
  type: 'label';
  id: string;
  parentId: string | null;
  timestamp: string;
  targetId: string;
  label?: string;
}

export interface OpenAiCodexBranchSummaryEvent {
  type: 'branch_summary';
  id: string;
  parentId: string | null;
  timestamp: string;
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

export type OpenAiCodexJsonlEvent =
  | OpenAiCodexSessionEvent
  | OpenAiCodexModelChangeEvent
  | OpenAiCodexThinkingLevelChangeEvent
  | OpenAiCodexMessageEvent
  | OpenAiCodexCompactionEvent
  | OpenAiCodexCustomEvent
  | OpenAiCodexSessionInfoEvent
  | OpenAiCodexCustomMessageEvent
  | OpenAiCodexLabelEvent
  | OpenAiCodexBranchSummaryEvent;

export interface ClaudeCodePermissionModeEvent {
  type: 'permission-mode';
  permissionMode: string;
  sessionId: string;
}

export interface ClaudeCodeFileHistorySnapshot {
  messageId: string;
  trackedFileBackups: JsonRecord;
  timestamp: string;
}

export interface ClaudeCodeFileHistorySnapshotEvent {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: ClaudeCodeFileHistorySnapshot;
  isSnapshotUpdate: boolean;
}

export interface ClaudeCodeConversationEnvelope {
  parentUuid: string | null;
  isSidechain: boolean;
  uuid: string;
  timestamp: string;
  userType: string;
  entrypoint: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  promptId?: string;
  permissionMode?: string;
  slug?: string;
}

export interface ClaudeCodeToolResultContentPart {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type ClaudeCodeUnknownUserContentPart = JsonRecord & { type: string };

export type ClaudeCodeUserContentPart = ClaudeCodeToolResultContentPart | ClaudeCodeUnknownUserContentPart;

export interface ClaudeCodeUserMessage {
  role: 'user';
  content: string | ClaudeCodeUserContentPart[];
}

export interface ClaudeCodeUserEvent extends ClaudeCodeConversationEnvelope {
  type: 'user';
  message: ClaudeCodeUserMessage;
  isMeta?: boolean;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
}

export interface ClaudeCodeToolUseContentPart {
  type: 'tool_use';
  id: string;
  name: string;
  input: JsonRecord;
  caller: {
    type: string;
  };
}

export interface ClaudeCodeTextContentPart {
  type: 'text';
  text: string;
}

export type ClaudeCodeUnknownAssistantContentPart = JsonRecord & { type: string };

export type ClaudeCodeAssistantContentPart =
  | ClaudeCodeToolUseContentPart
  | ClaudeCodeTextContentPart
  | ClaudeCodeUnknownAssistantContentPart;

export interface ClaudeCodeAssistantUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier: string | null;
  cache_creation: Record<string, number>;
  inference_geo: string | null;
  iterations: unknown[] | null;
  speed: string | null;
}

export interface ClaudeCodeAssistantMessage {
  model: string;
  id: string;
  type: 'message';
  role: 'assistant';
  content: ClaudeCodeAssistantContentPart[];
  stop_reason: string;
  stop_sequence: string | null;
  stop_details: unknown;
  usage: ClaudeCodeAssistantUsage | null;
}

export interface ClaudeCodeAssistantEvent extends ClaudeCodeConversationEnvelope {
  type: 'assistant';
  requestId?: string;
  message: ClaudeCodeAssistantMessage;
}

export interface ClaudeCodeDeferredToolsDeltaAttachment {
  type: 'deferred_tools_delta';
  addedNames: string[];
  addedLines: string[];
  removedNames: string[];
}

export interface ClaudeCodeSkillListingAttachment {
  type: 'skill_listing';
  content: string;
  skillCount: number;
  isInitial: boolean;
}

export type ClaudeCodeUnknownAttachment = JsonRecord & { type: string };

export type ClaudeCodeAttachment =
  | ClaudeCodeDeferredToolsDeltaAttachment
  | ClaudeCodeSkillListingAttachment
  | ClaudeCodeUnknownAttachment;

export interface ClaudeCodeAttachmentEvent extends ClaudeCodeConversationEnvelope {
  type: 'attachment';
  attachment: ClaudeCodeAttachment;
}

export interface ClaudeCodeUnknownConversationEvent extends JsonRecord, ClaudeCodeConversationEnvelope {
  type: string;
  unsupported: true;
}

export interface ClaudeCodeUnknownMetaEvent extends JsonRecord {
  type: string;
  unsupported: true;
  sessionId?: string;
  timestamp?: string;
}

export type ClaudeCodeJsonlEvent =
  | ClaudeCodePermissionModeEvent
  | ClaudeCodeFileHistorySnapshotEvent
  | ClaudeCodeUserEvent
  | ClaudeCodeAssistantEvent
  | ClaudeCodeAttachmentEvent
  | ClaudeCodeUnknownConversationEvent
  | ClaudeCodeUnknownMetaEvent;
