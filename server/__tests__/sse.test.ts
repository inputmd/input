import test from 'ava';
import {
  createSseParser,
  formatSseComment,
  formatSseEvent,
  parseSseFieldValue,
  readSseStream,
} from '../../shared/sse.ts';

function streamTextChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

test('parseSseFieldValue removes the prefix and at most one leading space', (t) => {
  t.is(parseSseFieldValue('data: hello', 'data:'), 'hello');
  t.is(parseSseFieldValue('event:turn_end', 'event:'), 'turn_end');
  t.is(parseSseFieldValue('data:  indented', 'data:'), ' indented');
});

test('createSseParser parses event metadata, multiline data, comments, and CRLF boundaries', (t) => {
  const events: Array<{ event: string; data: string; id?: string; retry?: number }> = [];
  const comments: string[] = [];
  const parser = createSseParser({
    onEvent: (event) => events.push(event),
    onComment: (comment) => comments.push(comment),
  });

  parser.feed(': keepalive\r\n');
  parser.feed('event: status\r\nid: abc\r\nretry: 1500\r\ndata: one\r');
  parser.feed('\ndata: two\r\nignored: value\r\n\r\n');
  parser.end();

  t.deepEqual(comments, [' keepalive']);
  t.deepEqual(events, [{ event: 'status', data: 'one\ntwo', id: 'abc', retry: 1500 }]);
});

test('createSseParser does not dispatch a partial trailing event unless requested', (t) => {
  const events: Array<{ event: string; data: string }> = [];
  const parser = createSseParser({
    onEvent: (event) => events.push({ event: event.event, data: event.data }),
  });

  parser.feed('event: tail\ndata: unfinished');
  parser.end();

  t.deepEqual(events, []);
});

test('createSseParser can dispatch a trailing event at EOF when enabled', (t) => {
  const events: Array<{ event: string; data: string }> = [];
  const parser = createSseParser(
    {
      onEvent: (event) => events.push({ event: event.event, data: event.data }),
    },
    { dispatchFinalEvent: true },
  );

  parser.feed('event: tail\ndata: finished');
  parser.end();

  t.deepEqual(events, [{ event: 'tail', data: 'finished' }]);
});

test('readSseStream yields spec-compliant events across arbitrary chunk boundaries', async (t) => {
  const body = streamTextChunks([
    formatSseComment('keepalive'),
    'event: summary\n',
    'data: {"summary":"line 1"}\n',
    '\n',
    'data: first line\n',
    'data: second line\n\n',
  ]);

  const events = [];
  for await (const event of readSseStream(body)) {
    events.push(event);
  }

  t.deepEqual(events, [
    { event: 'summary', data: '{"summary":"line 1"}' },
    { event: '', data: 'first line\nsecond line' },
  ]);
});

test('formatSseEvent serializes named and multiline payloads', (t) => {
  t.is(formatSseEvent({ ok: true }, 'status'), 'event: status\ndata: {"ok":true}\n\n');
  t.is(formatSseEvent('a\nb'), 'data: a\ndata: b\n\n');
  t.is(formatSseComment('keepalive'), ': keepalive\n\n');
});
