// ── SSE Stream Parser for OpenAI-compatible chat completions ──

import { appendStreamText, shouldInsertStreamBoundarySpace } from '../shared/stream_boundary_dictionary.ts';
import type { StreamParseOptions, StreamParseResult, ToolCall } from './types.ts';

export function parseSseFieldValue(line: string, prefix: 'data:'): string {
  let value = line.slice(prefix.length);
  if (value.startsWith(' ')) value = value.slice(1);
  return value;
}

function mergeToolCallFragment(existing: string, incoming: string | undefined): string {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (incoming === existing || existing.endsWith(incoming)) return existing;
  if (incoming.startsWith(existing)) return incoming;

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }
  return existing + incoming;
}

function joinStructuredContentSegments(segments: string[]): string {
  let result = '';
  for (const segment of segments) {
    if (!segment) continue;
    result = appendStreamText(result, segment);
  }
  return result;
}

function extractOpenRouterContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return joinStructuredContentSegments(content.map((part) => extractOpenRouterContentText(part)));
  }
  if (!content || typeof content !== 'object') return '';

  const value = content as { text?: unknown; value?: unknown };
  if (typeof value.text === 'string') return value.text;
  if (typeof value.value === 'string') return value.value;
  if (value.text && typeof value.text === 'object') return extractOpenRouterContentText(value.text);
  return '';
}

export async function parseUpstreamStream(
  body: ReadableStream<Uint8Array>,
  onTextDelta: (delta: string) => void,
  options: StreamParseOptions = {},
): Promise<StreamParseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = '';
  let pendingVisibleDelta = '';
  const accumulators = new Map<string, { id: string; name: string; arguments: string }>();
  const repairBoundaries = options.repairBoundaries ?? true;

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
        const data = dataLines.join('\n');
        if (!data || data === '[DONE]') {
          boundary = buffer.indexOf('\n\n');
          continue;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: unknown;
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
          const textDelta = extractOpenRouterContentText(delta?.content);
          if (textDelta) {
            if (!repairBoundaries) {
              content += textDelta;
              onTextDelta(textDelta);
            } else if (!pendingVisibleDelta) {
              pendingVisibleDelta = textDelta;
            } else {
              const emittedDelta = shouldInsertStreamBoundarySpace(pendingVisibleDelta, textDelta)
                ? `${pendingVisibleDelta} `
                : pendingVisibleDelta;
              content += emittedDelta;
              if (emittedDelta) onTextDelta(emittedDelta);
              pendingVisibleDelta = textDelta;
            }
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (let i = 0; i < delta.tool_calls.length; i++) {
              const tc = delta.tool_calls[i];
              const key =
                typeof tc.index === 'number'
                  ? `index:${tc.index}`
                  : typeof tc.id === 'string' && tc.id
                    ? `id:${tc.id}`
                    : `position:${i}`;
              if (!accumulators.has(key)) accumulators.set(key, { id: '', name: '', arguments: '' });
              const acc = accumulators.get(key)!;
              if (tc.id) acc.id = tc.id;
              acc.name = mergeToolCallFragment(acc.name, tc.function?.name);
              acc.arguments = mergeToolCallFragment(acc.arguments, tc.function?.arguments);
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

  if (pendingVisibleDelta) {
    content += pendingVisibleDelta;
    onTextDelta(pendingVisibleDelta);
  }

  const toolCalls: ToolCall[] = [];
  for (const [, acc] of [...accumulators.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
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
