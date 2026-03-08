// ── Reader AI Tool Definitions, Execution, and Subagent Support ──

export const READER_AI_TOOL_RESULT_MAX_CHARS = 30_000;
export const READER_AI_DOC_PREVIEW_CHARS = 12_000;
export const READER_AI_TASK_TIMEOUT_MS = 90_000;
export const READER_AI_TASK_MAX_OUTPUT_CHARS = 60_000;
export const READER_AI_MAX_CONCURRENT_TASKS = 4;
export const READER_AI_TASK_MAX_ITERATIONS = 10;

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
        'Search the document for lines matching a query (case-insensitive substring). Returns matching lines with surrounding context and line numbers.',
      parameters: {
        type: 'object' as const,
        properties: {
          query: { type: 'string' as const, description: 'Text to search for (case-insensitive)' },
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

// Subagent tools — subset available to task subagents (no nested task spawning)
export const READER_AI_SUBAGENT_TOOLS = READER_AI_TOOLS.filter((t) => t.function.name !== 'task');

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
  args: { query: string; context_lines?: number },
): string {
  if (!args.query) return '(query is required)';
  const query = args.query.toLowerCase();
  const ctx = Math.max(0, Math.min(args.context_lines ?? 2, 10));
  const matchIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(query)) matchIndices.push(i);
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

/** Execute a synchronous (non-task) tool. */
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
      return executeReaderAiSearchDocument(lines, args as { query: string; context_lines?: number });
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
  lines: string[];
  source: string;
  openRouterHeaders: Record<string, string>;
  signal: AbortSignal;
  /** Override fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export async function executeReaderAiSubagent(options: ReaderAiSubagentOptions): Promise<string> {
  const { model, prompt, lines, source, openRouterHeaders, signal, fetchFn = fetch } = options;

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
        tools: READER_AI_SUBAGENT_TOOLS,
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
      const toolResult = executeReaderAiSyncTool(tc.name, tc.arguments, lines);
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
