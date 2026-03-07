import { responseToApiError } from './api_error';

export interface ReaderAiModel {
  id: string;
  name: string;
  context_length: number;
}

export const FEATURED_READER_AI_MODELS = [
  { label: 'nemotron 3 nano 30b', aliases: ['nemotron 3 nano 30b'] },
  { label: 'arcee ai trinity mini', aliases: ['arcee ai trinity mini', 'arcee-ai trinity mini', 'trinity mini'] },
  {
    label: 'arcee ai trinity large preview',
    aliases: ['arcee ai trinity large preview', 'arcee-ai trinity large preview', 'trinity large preview'],
  },
] as const;

type ReaderAiModelsResponse = {
  models?: ReaderAiModel[];
};

interface ReaderAiStreamOptions {
  onDelta: (delta: string) => void;
  onSummary?: (summary: string) => void;
  signal?: AbortSignal;
}

export function readerAiModelPriorityRank(model: ReaderAiModel): number {
  const id = model.id.trim().toLowerCase();
  const name = model.name.trim().toLowerCase();
  const normalizedId = id.replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedName = name.replace(/[^a-z0-9]+/g, ' ').trim();
  for (let index = 0; index < FEATURED_READER_AI_MODELS.length; index += 1) {
    const featured = FEATURED_READER_AI_MODELS[index];
    if (
      featured.aliases.some((alias) => {
        const normalizedAlias = alias
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
        return (
          id === alias ||
          id.includes(alias) ||
          name === alias ||
          name.includes(alias) ||
          normalizedId === normalizedAlias ||
          normalizedId.includes(normalizedAlias) ||
          normalizedName === normalizedAlias ||
          normalizedName.includes(normalizedAlias)
        );
      })
    ) {
      return index;
    }
  }
  return -1;
}

export async function listReaderAiModels(): Promise<ReaderAiModel[]> {
  const res = await fetch('/api/ai/models', { credentials: 'same-origin' });
  if (!res.ok) throw await responseToApiError(res);
  const data = (await res.json()) as ReaderAiModelsResponse;
  return Array.isArray(data.models) ? data.models : [];
}

function extractStreamDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choice = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || choice.length === 0) return '';
  const first = choice[0] as { delta?: unknown; message?: unknown };
  if (first?.delta && typeof first.delta === 'object') {
    const content = (first.delta as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  if (first?.message && typeof first.message === 'object') {
    const content = (first.message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

export async function askReaderAiStream(
  model: string,
  source: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  options: ReaderAiStreamOptions,
  summary?: string,
): Promise<void> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model,
      source,
      messages,
      ...(summary ? { summary } : {}),
    }),
  });
  if (!res.ok) throw await responseToApiError(res);

  const body = res.body;
  if (!body) throw new Error('Reader AI stream is unavailable');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const lines = event.split('\n').map((line) => line.trim());
      const eventType = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '';
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      const data = dataLines.join('\n');
      if (!data || data === '[DONE]') {
        // skip
      } else if (eventType === 'summary' && options.onSummary) {
        try {
          const parsed = JSON.parse(data) as { summary?: string };
          if (typeof parsed.summary === 'string' && parsed.summary) options.onSummary(parsed.summary);
        } catch {
          // Ignore malformed summary event.
        }
      } else {
        try {
          const parsed = JSON.parse(data) as unknown;
          const delta = extractStreamDelta(parsed);
          if (delta) options.onDelta(delta);
        } catch {
          // Ignore malformed stream chunks and continue.
        }
      }

      boundary = buffer.indexOf('\n\n');
    }
  }
}
