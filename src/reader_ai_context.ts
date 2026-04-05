import type { ReaderAiModel } from './reader_ai';

const READER_AI_SOURCE_MAX_CHARS = 140_000;

export function trimReaderAiSource(source: string): string {
  if (source.length <= READER_AI_SOURCE_MAX_CHARS) return source;
  return source.slice(source.length - READER_AI_SOURCE_MAX_CHARS);
}

export function buildReaderAiDocumentSource(options: {
  allowDocumentEdits: boolean;
  currentEditContent: string;
  documentEditedContent?: string | null;
  hasPendingDocumentChanges?: boolean;
  readerAiSource: string;
}): string {
  if (
    options.allowDocumentEdits &&
    options.hasPendingDocumentChanges === true &&
    typeof options.documentEditedContent === 'string'
  ) {
    return trimReaderAiSource(options.documentEditedContent);
  }
  return trimReaderAiSource(options.allowDocumentEdits ? options.currentEditContent : options.readerAiSource);
}

function estimateApproxReaderAiTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

export function buildReaderAiContextLogPayload(options: {
  model: ReaderAiModel | null;
  source: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  summary?: string;
  mode: 'default' | 'prompt_list';
  currentDocPath?: string | null;
}) {
  const summary = options.summary?.trim() ?? '';
  const sourceTokens = estimateApproxReaderAiTokens(options.source);
  const messageTokens =
    options.messages.reduce((sum, message) => sum + estimateApproxReaderAiTokens(message.content) + 8, 0) +
    options.messages.length * 4;
  const summaryTokens = estimateApproxReaderAiTokens(summary);
  const approxInputTokens = sourceTokens + messageTokens + summaryTokens;
  const contextLength = options.model?.context_length ?? 0;
  const approxRemainingTokens = contextLength > 0 ? Math.max(0, contextLength - approxInputTokens) : null;

  return {
    model: options.model?.id ?? 'unknown',
    mode: options.mode,
    currentDocPath: options.currentDocPath ?? null,
    messageCount: options.messages.length,
    sourceChars: options.source.length,
    summaryChars: summary.length,
    approxInputTokens,
    approxRemainingTokens,
    approxContextUsedPercent: contextLength > 0 ? Number(((approxInputTokens / contextLength) * 100).toFixed(2)) : null,
    contextLength: contextLength > 0 ? contextLength : null,
    note:
      contextLength > 0
        ? 'Approximate client-side estimate; excludes server-added system prompt and tool overhead.'
        : 'Model context length unavailable.',
  };
}
