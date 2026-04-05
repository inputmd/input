export interface SseEventMessage {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface SseParserCallbacks {
  onEvent: (event: SseEventMessage) => void;
  onComment?: (comment: string) => void;
}

export interface SseParserOptions {
  dispatchFinalEvent?: boolean;
}

export function parseSseFieldValue(line: string, prefix: `${string}:`): string {
  let value = line.slice(prefix.length);
  if (value.startsWith(' ')) value = value.slice(1);
  return value;
}

export function createSseParser(
  callbacks: SseParserCallbacks,
  options: SseParserOptions = {},
): {
  feed: (chunk: string) => void;
  end: () => void;
} {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let lastEventId = '';
  let retry: number | undefined;

  const resetEvent = () => {
    eventName = '';
    dataLines = [];
    retry = undefined;
  };

  const dispatchEvent = () => {
    if (dataLines.length === 0) {
      resetEvent();
      return;
    }
    callbacks.onEvent({
      event: eventName,
      data: dataLines.join('\n'),
      ...(lastEventId ? { id: lastEventId } : {}),
      ...(retry !== undefined ? { retry } : {}),
    });
    resetEvent();
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatchEvent();
      return;
    }
    if (line.startsWith(':')) {
      callbacks.onComment?.(line.slice(1));
      return;
    }

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const value = separatorIndex >= 0 ? parseSseFieldValue(line, `${field}:`) : '';
    switch (field) {
      case 'event':
        eventName = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\u0000')) lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
      default:
        break;
    }
  };

  const processBufferedLines = (flushRemainder: boolean) => {
    let lineStart = 0;
    let cursor = 0;
    while (cursor < buffer.length) {
      const char = buffer[cursor];
      if (char !== '\n' && char !== '\r') {
        cursor += 1;
        continue;
      }

      const line = buffer.slice(lineStart, cursor);
      if (char === '\r' && cursor + 1 >= buffer.length && !flushRemainder) break;

      const newlineLength = char === '\r' && buffer[cursor + 1] === '\n' ? 2 : 1;
      processLine(line);
      cursor += newlineLength;
      lineStart = cursor;
    }

    buffer = buffer.slice(lineStart);
    if (flushRemainder && buffer) {
      processLine(buffer);
      buffer = '';
    }
  };

  return {
    feed(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      processBufferedLines(false);
    },
    end() {
      processBufferedLines(true);
      if (options.dispatchFinalEvent) dispatchEvent();
      else resetEvent();
    },
  };
}

export interface ReadSseStreamOptions extends SseParserOptions {
  onComment?: (comment: string) => void;
}

export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  options: ReadSseStreamOptions = {},
): AsyncGenerator<SseEventMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queuedEvents: SseEventMessage[] = [];
  const parser = createSseParser(
    {
      onEvent: (event) => queuedEvents.push(event),
      onComment: options.onComment,
    },
    { dispatchFinalEvent: options.dispatchFinalEvent },
  );

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (queuedEvents.length > 0) {
        yield queuedEvents.shift()!;
      }
    }
    parser.feed(decoder.decode());
    parser.end();
    while (queuedEvents.length > 0) {
      yield queuedEvents.shift()!;
    }
  } finally {
    reader.releaseLock();
  }
}

export function formatSseEvent(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  let result = '';
  if (event) result += `event: ${event}\n`;
  for (const line of payload.split('\n')) result += `data: ${line}\n`;
  result += '\n';
  return result;
}

export function formatSseComment(comment: string): string {
  return `:${comment ? ` ${comment}` : ''}\n\n`;
}
