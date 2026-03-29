// ── Reader AI Subagent Execution ──

import { parseUpstreamStream } from './stream.ts';
import { executeReaderAiSyncTool, READER_AI_SUBAGENT_TOOLS } from './tools.ts';
import type { OpenRouterMessage, ReaderAiProviderConfig } from './types.ts';
import { buildUpstreamHeaders, readUpstreamError } from './upstream.ts';

export const READER_AI_TASK_TIMEOUT_MS = 90_000;
export const READER_AI_TASK_MAX_OUTPUT_CHARS = 60_000;
export const READER_AI_TASK_MAX_ITERATIONS = 10;

export interface SubagentProgressEvent {
  phase: 'started' | 'iteration_start' | 'tool_call' | 'tool_result' | 'completed' | 'error';
  iteration?: number;
  detail?: string;
}

export interface SubagentOptions {
  config: ReaderAiProviderConfig;
  prompt: string;
  systemPrompt?: string;
  lines: string[];
  source: string;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
  onProgress?: (event: SubagentProgressEvent) => void;
}

function shouldUsePromptCachingForSubagent(config: ReaderAiProviderConfig): boolean {
  return config.model.trim().toLowerCase().startsWith('anthropic/');
}

export async function executeSubagent(options: SubagentOptions): Promise<string> {
  const { config, prompt, lines, source, signal, fetchFn = fetch, onProgress } = options;
  const defaultSystemPrompt = [
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
  const tools = READER_AI_SUBAGENT_TOOLS;
  const promptCacheControl = shouldUsePromptCachingForSubagent(config) ? { type: 'ephemeral' as const } : undefined;

  const headers = buildUpstreamHeaders(config);
  const baseUrl = (config.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  let output = '';
  onProgress?.({ phase: 'started', detail: 'Document mode' });

  for (let iteration = 0; iteration < READER_AI_TASK_MAX_ITERATIONS; iteration++) {
    onProgress?.({ phase: 'iteration_start', iteration: iteration + 1 });
    const upstream = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages,
        tools,
        ...(promptCacheControl ? { cache_control: promptCacheControl } : {}),
      }),
      signal: AbortSignal.any([AbortSignal.timeout(READER_AI_TASK_TIMEOUT_MS), signal]),
    });

    if (!upstream.ok) {
      const payload = (await upstream.json().catch(() => null)) as unknown;
      const detail = readUpstreamError(payload) || `Subagent request failed (${upstream.status})`;
      onProgress?.({ phase: 'error', iteration: iteration + 1, detail });
      return output ? `${output}\n\n[Subagent error: ${detail}]` : `[Subagent error: ${detail}]`;
    }
    if (!upstream.body) {
      onProgress?.({ phase: 'error', iteration: iteration + 1, detail: 'no response body' });
      return output ? `${output}\n\n[Subagent error: no response body]` : '[Subagent error: no response body]';
    }

    const result = await parseUpstreamStream(
      upstream.body,
      (delta) => {
        output += delta;
      },
      { repairBoundaries: config.model.trim().toLowerCase().endsWith(':free') },
    );

    if (result.toolCalls.length === 0) break;

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
      onProgress?.({ phase: 'tool_call', iteration: iteration + 1, detail: tc.name });
      const toolResult = executeReaderAiSyncTool(tc.name, tc.arguments, lines);
      onProgress?.({
        phase: 'tool_result',
        iteration: iteration + 1,
        detail: `${tc.name} (${toolResult.length} chars)`,
      });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }

  if (output.length > READER_AI_TASK_MAX_OUTPUT_CHARS) {
    const truncated =
      output.slice(0, READER_AI_TASK_MAX_OUTPUT_CHARS) +
      `\n\n... (subagent output truncated at ${READER_AI_TASK_MAX_OUTPUT_CHARS} characters)`;
    onProgress?.({ phase: 'completed', detail: `Output truncated at ${READER_AI_TASK_MAX_OUTPUT_CHARS} chars` });
    return truncated;
  }
  onProgress?.({ phase: 'completed' });
  return output || '(subagent produced no output)';
}
