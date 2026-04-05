// ── Conversation Summarization ──

import { normalizeLlmOutputText } from '../shared/llm_text_normalization.ts';
import type { ReaderAiMessage, ReaderAiProviderConfig } from './types.ts';
import { callUpstreamNonStreaming } from './upstream.ts';

export const READER_AI_MAX_SUMMARY_CHARS = 2_000;
export const READER_AI_SUMMARIZE_TIMEOUT_MS = 30_000;
export const READER_AI_CONTEXT_WINDOW_MESSAGES = 8;

/** Truncate long assistant messages for summarization — strip tool interaction noise. */
function prepareMessageForSummary(msg: ReaderAiMessage): string {
  const label = msg.role === 'user' ? 'User' : 'Assistant';
  let content = msg.content;
  if (content.length > 2000) {
    content = `${content.slice(0, 2000)}…`;
  }
  return `${label}: ${content}`;
}

export async function summarizeConversation(
  config: ReaderAiProviderConfig,
  evictedMessages: ReaderAiMessage[],
  existingSummary: string,
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = [];
  if (existingSummary) parts.push(`Previous summary:\n${existingSummary}`);
  for (const msg of evictedMessages) {
    parts.push(prepareMessageForSummary(msg));
  }
  const toSummarize = parts.join('\n\n');

  const upstream = await callUpstreamNonStreaming(
    config,
    [
      {
        role: 'system',
        content:
          'Summarize the following conversation history in 2-4 concise sentences. Capture the key questions asked, answers given, important conclusions, and any files or code that were examined. Omit tool call details — focus on what was learned. Write in third person (e.g. "The user asked about...").',
      },
      { role: 'user', content: toSummarize },
    ],
    512,
    signal ?? AbortSignal.timeout(READER_AI_SUMMARIZE_TIMEOUT_MS),
  );

  if (!upstream.ok) return existingSummary;

  const payload = (await upstream.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const summary = normalizeLlmOutputText(payload?.choices?.[0]?.message?.content?.trim() ?? '');
  return summary ? summary.slice(0, READER_AI_MAX_SUMMARY_CHARS) : existingSummary;
}
