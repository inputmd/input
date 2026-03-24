import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { initDictionaryFromBuffer } from '../../shared/stream_boundary_dictionary.ts';
import { stripCriticMarkupComments } from '../../src/criticmarkup.ts';
import {
  buildReaderAiProjectSystemPrompt,
  buildReaderAiPromptListSystemPrompt,
  buildReaderAiSystemPrompt,
  compactToolResults,
  estimateMessagesTokens,
  estimateTokens,
  executeReaderAiEditDocumentTool,
  executeReaderAiListFiles,
  executeReaderAiProjectSyncTool,
  executeReaderAiReadDocument,
  executeReaderAiReadFile,
  executeReaderAiSearchDocument,
  executeReaderAiSearchFiles,
  executeReaderAiSyncTool,
  generateUnifiedDiff,
  type OpenRouterMessage,
  parseReaderAiUpstreamStream,
  parseSseFieldValue,
  READER_AI_MAX_REGEX_PATTERN_LENGTH,
  READER_AI_PROJECT_SUBAGENT_TOOLS,
  READER_AI_PROJECT_TOOLS,
  READER_AI_SUBAGENT_TOOLS,
  READER_AI_TOOL_RESULT_MAX_CHARS,
  READER_AI_TOOLS,
  type ReaderAiFileEntry,
  readUpstreamError,
  StagedChanges,
  simpleGlobMatch,
} from '../reader_ai_tools.ts';

// Load the bloom filter for dictionary-backed boundary detection in tests.
// This must succeed — dictionary-dependent tests (photosynthesis, NVIDIA, etc.)
// will silently produce wrong results without it.
const bloomPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'dictionary.bloom');
initDictionaryFromBuffer(new Uint8Array(readFileSync(bloomPath)));

// ── Helper ──

function makeLines(count: number, prefix = 'Line'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

function sseChunk(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(): Uint8Array {
  return new TextEncoder().encode('data: [DONE]\n\n');
}

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

// ── parseSseFieldValue ──

test('parseSseFieldValue strips prefix and leading space', (t) => {
  t.is(parseSseFieldValue('data: hello', 'data:'), 'hello');
  t.is(parseSseFieldValue('data:hello', 'data:'), 'hello');
  t.is(parseSseFieldValue('data:  two spaces', 'data:'), ' two spaces');
});

// ── readUpstreamError ──

test('readUpstreamError extracts nested error message', (t) => {
  t.is(readUpstreamError({ error: { message: 'rate limited' } }), 'rate limited');
  t.is(readUpstreamError({ error: { message: '' } }), null);
  t.is(readUpstreamError({ error: {} }), null);
  t.is(readUpstreamError(null), null);
  t.is(readUpstreamError('string'), null);
  t.is(readUpstreamError({ other: 1 }), null);
});

// ── executeReaderAiReadDocument ──

test('read_document returns full document when no args', (t) => {
  const lines = makeLines(3);
  const result = executeReaderAiReadDocument(lines, {});
  t.is(result, '1: Line 1\n2: Line 2\n3: Line 3');
});

test('read_document returns specific range', (t) => {
  const lines = makeLines(5);
  const result = executeReaderAiReadDocument(lines, { start_line: 2, end_line: 4 });
  t.is(result, '2: Line 2\n3: Line 3\n4: Line 4');
});

test('read_document clamps start to 1', (t) => {
  const lines = makeLines(3);
  const result = executeReaderAiReadDocument(lines, { start_line: -5 });
  t.true(result.startsWith('1: Line 1'));
});

test('read_document clamps end to total lines', (t) => {
  const lines = makeLines(3);
  const result = executeReaderAiReadDocument(lines, { start_line: 2, end_line: 999 });
  t.is(result, '2: Line 2\n3: Line 3');
});

test('read_document handles start beyond document', (t) => {
  const lines = makeLines(3);
  const result = executeReaderAiReadDocument(lines, { start_line: 10 });
  t.true(result.includes('beyond the document'));
});

test('read_document handles reversed range', (t) => {
  const lines = makeLines(5);
  const result = executeReaderAiReadDocument(lines, { start_line: 4, end_line: 2 });
  t.true(result.includes('invalid range'));
});

test('read_document truncates very long output', (t) => {
  // Create lines that will exceed READER_AI_TOOL_RESULT_MAX_CHARS
  const longLine = 'x'.repeat(1000);
  const lines = Array.from({ length: 200 }, (_, i) => `${longLine} ${i}`);
  const result = executeReaderAiReadDocument(lines, {});
  t.true(result.length <= READER_AI_TOOL_RESULT_MAX_CHARS + 200); // +200 for truncation message
  t.true(result.includes('truncated'));
});

test('read_document single line', (t) => {
  const lines = makeLines(5);
  const result = executeReaderAiReadDocument(lines, { start_line: 3, end_line: 3 });
  t.is(result, '3: Line 3');
});

test('stripCriticMarkupComments removes CriticMarkup comments while keeping other markup', (t) => {
  const result = stripCriticMarkupComments('A {>>omit<<} {++keep++} {~~old~>new~~} B');

  t.is(result, 'A  {++keep++} {~~old~>new~~} B');
});

// ── executeReaderAiEditDocumentTool ──

test('propose_edit_document supports line-range replacement', (t) => {
  const state = {
    source: 'a\nb\nc\nd',
    lines: ['a', 'b', 'c', 'd'],
    currentDocPath: 'doc.md',
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
  };
  const raw = executeReaderAiEditDocumentTool('{"start_line":2,"end_line":3,"new_text":"X\\nY"}', state);
  const parsed = JSON.parse(raw) as { ok: boolean; mode?: string };
  t.true(parsed.ok);
  t.is(parsed.mode, 'line_range');
  t.is(state.source, 'a\nX\nY\nd');
  t.truthy(state.stagedContent);
});

test('propose_edit_document supports atomic batched edits', (t) => {
  const state = {
    source: 'one\ntwo\nthree',
    lines: ['one', 'two', 'three'],
    currentDocPath: 'doc.md',
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
  };
  const raw = executeReaderAiEditDocumentTool(
    '{"edits":[{"old_text":"one","new_text":"ONE"},{"start_line":2,"end_line":2,"new_text":"TWO"}]}',
    state,
  );
  const parsed = JSON.parse(raw) as { ok: boolean; mode?: string; edits_applied?: number };
  t.true(parsed.ok);
  t.is(parsed.mode, 'batch');
  t.is(parsed.edits_applied, 2);
  t.is(state.source, 'ONE\nTWO\nthree');
});

test('propose_edit_document batch failures are atomic', (t) => {
  const state = {
    source: 'alpha\nbeta',
    lines: ['alpha', 'beta'],
    currentDocPath: 'doc.md',
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
  };
  const raw = executeReaderAiEditDocumentTool(
    '{"edits":[{"old_text":"alpha","new_text":"ALPHA"},{"old_text":"missing","new_text":"x"}]}',
    state,
  );
  const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string } };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'not_found');
  t.is(state.source, 'alpha\nbeta');
  t.is(state.stagedContent, null);
});

test('propose_edit_document dry_run previews without applying', (t) => {
  const state = {
    source: 'left right',
    lines: ['left right'],
    currentDocPath: 'doc.md',
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
  };
  const raw = executeReaderAiEditDocumentTool('{"old_text":"left","new_text":"LEFT","dry_run":true}', state);
  const parsed = JSON.parse(raw) as { ok: boolean; dry_run?: boolean; applied?: boolean };
  t.true(parsed.ok);
  t.true(parsed.dry_run);
  t.false(parsed.applied);
  t.is(state.source, 'left right');
  t.is(state.stagedContent, null);
});

test('propose_edit_document returns structured invalid_json error', (t) => {
  const state = {
    source: 'x',
    lines: ['x'],
    currentDocPath: 'doc.md',
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
  };
  const raw = executeReaderAiEditDocumentTool('{bad', state);
  const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string } };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'invalid_json');
});

test('propose_edit_document returns ambiguity hints', (t) => {
  const state = {
    source: 'repeat\nx\nrepeat\ny\nrepeat',
    lines: ['repeat', 'x', 'repeat', 'y', 'repeat'],
    currentDocPath: 'doc.md',
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
  };
  const raw = executeReaderAiEditDocumentTool('{"old_text":"repeat","new_text":"R"}', state);
  const parsed = JSON.parse(raw) as {
    ok: boolean;
    error?: { code?: string; details?: { matches?: Array<{ start_line: number; snippet: string }> } };
  };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'ambiguous_match');
  t.true((parsed.error?.details?.matches?.length ?? 0) >= 2);
  t.true((parsed.error?.details?.matches?.[0]?.start_line ?? 0) >= 1);
});

// ── executeReaderAiSearchDocument ──

test('search_document finds matches with context', (t) => {
  const lines = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const result = executeReaderAiSearchDocument(lines, { query: 'gamma' });
  t.true(result.includes('1 match found'));
  t.true(result.includes('> 3: gamma'));
  // default context_lines=2 means lines 1-5 included
  t.true(result.includes('1: alpha'));
  t.true(result.includes('5: epsilon'));
});

test('search_document is case-insensitive', (t) => {
  const lines = ['Hello World', 'goodbye'];
  const result = executeReaderAiSearchDocument(lines, { query: 'HELLO' });
  t.true(result.includes('1 match'));
  t.true(result.includes('> 1: Hello World'));
});

test('search_document returns no matches message', (t) => {
  const lines = ['alpha', 'beta'];
  const result = executeReaderAiSearchDocument(lines, { query: 'zzz' });
  t.is(result, 'No matches found.');
});

test('search_document returns error for empty query', (t) => {
  const result = executeReaderAiSearchDocument(['a'], { query: '' });
  t.is(result, '(query is required)');
});

test('search_document respects context_lines', (t) => {
  const lines = makeLines(20);
  const result = executeReaderAiSearchDocument(lines, { query: 'Line 10', context_lines: 0 });
  t.true(result.includes('> 10: Line 10'));
  // With context_lines=0, shouldn't include Line 9 or Line 11 (unless they also match)
  t.false(result.includes('9: Line 9'));
  t.false(result.includes('11: Line 11'));
});

test('search_document caps context_lines at 10', (t) => {
  const lines = makeLines(50);
  const result = executeReaderAiSearchDocument(lines, { query: 'Line 25', context_lines: 100 });
  // Should be capped at 10 context lines, so range is 15-35
  t.true(result.includes('15: Line 15'));
  t.true(result.includes('35: Line 35'));
  t.false(result.includes('14: Line 14'));
});

test('search_document merges overlapping ranges', (t) => {
  const lines = ['a', 'match1', 'b', 'match2', 'c'];
  const result = executeReaderAiSearchDocument(lines, { query: 'match', context_lines: 1 });
  t.true(result.includes('2 matches'));
  // With context_lines=1, ranges [0,2] and [2,4] overlap — should merge
  const markers = result.split('\n').filter((l) => l.startsWith('>'));
  t.is(markers.length, 2);
});

test('search_document multiple matches', (t) => {
  const lines = ['foo', 'bar', 'foo', 'baz', 'foo'];
  const result = executeReaderAiSearchDocument(lines, { query: 'foo', context_lines: 0 });
  t.true(result.includes('3 matches'));
});

// ── executeReaderAiSyncTool ──

test('sync tool dispatches read_document', (t) => {
  const lines = makeLines(3);
  const result = executeReaderAiSyncTool('read_document', '{"start_line":1,"end_line":2}', lines);
  t.is(result, '1: Line 1\n2: Line 2');
});

test('sync tool dispatches search_document', (t) => {
  const lines = ['hello world'];
  const result = executeReaderAiSyncTool('search_document', '{"query":"hello"}', lines);
  t.true(result.includes('1 match'));
});

test('sync tool returns error for unknown tool', (t) => {
  const result = executeReaderAiSyncTool('nonexistent', '{}', []);
  t.true(result.includes('unknown tool'));
});

test('sync tool handles invalid JSON', (t) => {
  const result = executeReaderAiSyncTool('read_document', '{bad json', []);
  t.true(result.includes('invalid JSON'));
});

test('sync tool handles empty args string', (t) => {
  const lines = makeLines(2);
  const result = executeReaderAiSyncTool('read_document', '', lines);
  t.is(result, '1: Line 1\n2: Line 2');
});

// ── READER_AI_TOOLS / READER_AI_SUBAGENT_TOOLS ──

test('READER_AI_TOOLS contains task tool', (t) => {
  const names = READER_AI_TOOLS.map((tool) => tool.function.name);
  t.true(names.includes('task'));
  t.true(names.includes('read_document'));
  t.true(names.includes('search_document'));
  t.true(names.includes('propose_edit_document'));
});

test('READER_AI_SUBAGENT_TOOLS excludes task tool', (t) => {
  const names = READER_AI_SUBAGENT_TOOLS.map((tool) => tool.function.name);
  t.false(names.includes('task'));
  t.true(names.includes('read_document'));
  t.true(names.includes('search_document'));
  t.false(names.includes('propose_edit_document'));
});

// ── buildReaderAiSystemPrompt ──

test('system prompt includes full doc for short documents', (t) => {
  const source = 'line one\nline two';
  const lines = source.split('\n');
  const prompt = buildReaderAiSystemPrompt(source, lines, 10_000);
  t.true(prompt.includes('<document>'));
  t.true(prompt.includes('1: line one'));
  t.true(prompt.includes('2: line two'));
  t.true(prompt.includes('do not call read_document'));
});

test('system prompt uses preview for long documents', (t) => {
  const longLines = makeLines(500);
  const source = longLines.join('\n');
  const lines = source.split('\n');
  const prompt = buildReaderAiSystemPrompt(source, lines, 200);
  t.true(prompt.includes('<document-preview>'));
  t.true(prompt.includes('500 lines'));
  t.false(prompt.includes('<document>'));
});

test('system prompt mentions task tool', (t) => {
  const prompt = buildReaderAiSystemPrompt('hello', ['hello'], 10_000);
  t.true(prompt.includes('task'));
  t.true(prompt.includes('subagent'));
});

test('system prompt mentions propose_edit_document tool', (t) => {
  const prompt = buildReaderAiSystemPrompt('hello', ['hello'], 10_000);
  t.true(prompt.includes('propose_edit_document'));
});

test('system prompt discourages task by default and requires proposal tools for edits', (t) => {
  const prompt = buildReaderAiSystemPrompt('hello', ['hello'], 10_000);
  t.true(prompt.includes('Do not use the task tool unless the user explicitly asks for it'));
  t.true(prompt.includes('call propose_edit_document instead of only describing the edit in text'));
});

test('system prompt includes document info', (t) => {
  const source = 'a\nb\nc';
  const lines = source.split('\n');
  const prompt = buildReaderAiSystemPrompt(source, lines, 10_000);
  t.true(prompt.includes('3 lines'));
  t.true(prompt.includes(`${source.length} characters`));
});

test('prompt-list system prompt focuses on inline thread and local excerpt', (t) => {
  const prompt = buildReaderAiPromptListSystemPrompt();

  t.true(prompt.includes('inline AI conversation'));
  t.true(prompt.includes('You do not have document context for this turn.'));
  t.true(prompt.includes('Do not output tables.'));
  t.false(prompt.includes('<local-excerpt>'));
});

// ── parseReaderAiUpstreamStream ──

test('stream parser accumulates text content', async (t) => {
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'Hello' } }] }),
    sseChunk({ choices: [{ delta: { content: ' world' } }] }),
    sseChunk({ choices: [{ finish_reason: 'stop' }] }),
    sseDone(),
  ]);

  const deltas: string[] = [];
  const result = await parseReaderAiUpstreamStream(stream, (d) => deltas.push(d));

  t.is(result.content, 'Hello world');
  t.deepEqual(deltas, ['Hello', ' world']);
  t.is(result.finishReason, 'stop');
  t.is(result.toolCalls.length, 0);
});

test('stream parser accumulates tool calls', async (t) => {
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_document', arguments: '{"start' } }],
          },
        },
      ],
    }),
    sseChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_line":1}' } }] } }],
    }),
    sseChunk({ choices: [{ finish_reason: 'tool_calls' }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});

  t.is(result.toolCalls.length, 1);
  t.is(result.toolCalls[0].id, 'call_1');
  t.is(result.toolCalls[0].name, 'read_document');
  t.is(result.toolCalls[0].arguments, '{"start_line":1}');
  t.is(result.finishReason, 'tool_calls');
});

test('stream parser handles multiple parallel tool calls', async (t) => {
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'read_document', arguments: '{}' } },
              { index: 1, id: 'call_b', function: { name: 'search_document', arguments: '{"query":"x"}' } },
            ],
          },
        },
      ],
    }),
    sseChunk({ choices: [{ finish_reason: 'tool_calls' }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});
  t.is(result.toolCalls.length, 2);
  t.is(result.toolCalls[0].name, 'read_document');
  t.is(result.toolCalls[1].name, 'search_document');
});

test('stream parser handles interleaved text and tool calls', async (t) => {
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'Thinking...' } }] }),
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_document', arguments: '{"query":"x"}' } }],
          },
        },
      ],
    }),
    sseChunk({ choices: [{ finish_reason: 'tool_calls' }] }),
    sseDone(),
  ]);

  const deltas: string[] = [];
  const result = await parseReaderAiUpstreamStream(stream, (d) => deltas.push(d));

  t.is(result.content, 'Thinking...');
  t.deepEqual(deltas, ['Thinking...']);
  t.is(result.toolCalls.length, 1);
});

test('stream parser handles [DONE] gracefully', async (t) => {
  const stream = makeStream([sseChunk({ choices: [{ delta: { content: 'Hi' } }] }), sseDone()]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});
  t.is(result.content, 'Hi');
});

test('stream parser ignores malformed chunks', async (t) => {
  const stream = makeStream([
    new TextEncoder().encode('data: not-json\n\n'),
    sseChunk({ choices: [{ delta: { content: 'ok' } }] }),
    new TextEncoder().encode('data: {}\n\n'), // no choices
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});
  t.is(result.content, 'ok');
});

test('stream parser handles empty stream', async (t) => {
  const stream = makeStream([sseDone()]);
  const result = await parseReaderAiUpstreamStream(stream, () => {});
  t.is(result.content, '');
  t.is(result.toolCalls.length, 0);
  t.is(result.finishReason, '');
});

test('stream parser generates fallback tool call id when missing', async (t) => {
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: 'read_document', arguments: '{}' } }],
          },
        },
      ],
    }),
    sseChunk({ choices: [{ finish_reason: 'tool_calls' }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});
  t.is(result.toolCalls.length, 1);
  t.true(result.toolCalls[0].id.startsWith('tool_'));
});

test('stream parser handles CRLF line endings', async (t) => {
  const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const stream = makeStream([new TextEncoder().encode(raw)]);
  const result = await parseReaderAiUpstreamStream(stream, () => {});
  t.is(result.content, 'hi');
});

test('stream parser preserves space-only deltas', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'language' } }] }),
    sseChunk({ choices: [{ delta: { content: ' ' } }] }),
    sseChunk({ choices: [{ delta: { content: 'model' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['language', ' ', 'model']);
  t.is(result.content, 'language model');
});

test('stream parser accepts structured content parts', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            content: [
              { type: 'text', text: '**Essay:' },
              { type: 'text', text: ' ' },
              { type: 'text', text: 'The Sweet World of Strawberries**' },
            ],
          },
        },
      ],
    }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['**Essay: The Sweet World of Strawberries**']);
  t.is(result.content, '**Essay: The Sweet World of Strawberries**');
});

test('stream parser inserts a boundary space between adjacent structured word parts', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            content: [
              { type: 'text', text: 'How can I assist' },
              { type: 'text', text: 'you today?' },
            ],
          },
        },
      ],
    }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['How can I assist you today?']);
  t.is(result.content, 'How can I assist you today?');
});

test('stream parser inserts a boundary space between plain text deltas when the next chunk starts with a joiner word', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'model' } }] }),
    sseChunk({ choices: [{ delta: { content: 'am a large language model.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['model ', 'am a large language model.']);
  t.is(result.content, 'model am a large language model.');
});

test('stream parser can disable boundary repair', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'model' } }] }),
    sseChunk({ choices: [{ delta: { content: 'am a large language model.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta), {
    repairBoundaries: false,
  });

  t.deepEqual(deltas, ['model', 'am a large language model.']);
  t.is(result.content, 'modelam a large language model.');
});

test('stream parser inserts a boundary space after sentence punctuation before a capitalized chunk', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'Sure!' } }] }),
    sseChunk({ choices: [{ delta: { content: 'Here are the opening lines.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['Sure! ', 'Here are the opening lines.']);
  t.is(result.content, 'Sure! Here are the opening lines.');
});

test('stream parser does not split inside a word after a single-letter chunk', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'I' } }] }),
    sseChunk({ choices: [{ delta: { content: 'shmael' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['I', 'shmael']);
  t.is(result.content, 'Ishmael');
});

test('stream parser inserts a boundary space after a standalone I before the next lowercase word', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'Hello! How can I' } }] }),
    sseChunk({ choices: [{ delta: { content: 'help you today?' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['Hello! How can I ', 'help you today?']);
  t.is(result.content, 'Hello! How can I help you today?');
});

test('stream parser buffers one chunk and repairs a missing space before a lowercase word', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'I’m not sure' } }] }),
    sseChunk({ choices: [{ delta: { content: 'which vendor or version you mean.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['I’m not sure ', 'which vendor or version you mean.']);
  t.is(result.content, 'I’m not sure which vendor or version you mean.');
});

test('stream parser buffers one chunk and repairs a missing space before a capitalized word', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'molecules in' } }] }),
    sseChunk({ choices: [{ delta: { content: 'Earth’s atmosphere scatter light.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['molecules in ', 'Earth’s atmosphere scatter light.']);
  t.is(result.content, 'molecules in Earth’s atmosphere scatter light.');
});

test('stream parser keeps in-word continuations joined while buffering', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'short‑w' } }] }),
    sseChunk({ choices: [{ delta: { content: 'avelength light scatters.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['short‑w', 'avelength light scatters.']);
  t.is(result.content, 'short‑wavelength light scatters.');
});

test('stream parser repairs a missing space between ordinary lowercase words while buffering', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'The sky looks blue because' } }] }),
    sseChunk({ choices: [{ delta: { content: 'molecules in the atmosphere scatter light.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['The sky looks blue because ', 'molecules in the atmosphere scatter light.']);
  t.is(result.content, 'The sky looks blue because molecules in the atmosphere scatter light.');
});

test('stream parser repairs a missing space after a short capitalized word while buffering', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'The' } }] }),
    sseChunk({ choices: [{ delta: { content: 'sky looks blue.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['The ', 'sky looks blue.']);
  t.is(result.content, 'The sky looks blue.');
});

test('stream parser does not split plural suffix continuations while buffering', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'red' } }] }),
    sseChunk({ choices: [{ delta: { content: 's and oranges.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['red', 's and oranges.']);
  t.is(result.content, 'reds and oranges.');
});

test('stream parser dictionary guard keeps mid-word splits joined (photosynthesis)', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'Photos' } }] }),
    sseChunk({ choices: [{ delta: { content: 'ynthesis converts light.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['Photos', 'ynthesis converts light.']);
  t.is(result.content, 'Photosynthesis converts light.');
});

test('stream parser dictionary guard keeps mid-word splits joined (conversational)', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'convers' } }] }),
    sseChunk({ choices: [{ delta: { content: 'ational tone.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['convers', 'ational tone.']);
  t.is(result.content, 'conversational tone.');
});

test('stream parser dictionary guard keeps mid-word splits joined (refraction)', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'the first ref' } }] }),
    sseChunk({ choices: [{ delta: { content: 'raction of light.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['the first ref', 'raction of light.']);
  t.is(result.content, 'the first refraction of light.');
});

test('stream parser dictionary guard keeps NVIDIA joined (prev>=4, next>=2)', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'developed by NVID' } }] }),
    sseChunk({ choices: [{ delta: { content: 'IA for research.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['developed by NVID', 'IA for research.']);
  t.is(result.content, 'developed by NVIDIA for research.');
});

test('stream parser dictionary guard does not block real word boundaries', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({ choices: [{ delta: { content: 'The internet' } }] }),
    sseChunk({ choices: [{ delta: { content: 'began in the 1960s.' } }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['The internet ', 'began in the 1960s.']);
  t.is(result.content, 'The internet began in the 1960s.');
});

test('stream parser accepts nested structured content parts', async (t) => {
  const deltas: string[] = [];
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            content: [
              { type: 'output_text', text: { value: 'structured' } },
              { type: 'output_text', text: { value: ' ' } },
              { type: 'output_text', text: { value: 'text' } },
            ],
          },
        },
      ],
    }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, (delta) => deltas.push(delta));
  t.deepEqual(deltas, ['structured text']);
  t.is(result.content, 'structured text');
});

test('stream parser joins multiline data events with newlines', async (t) => {
  const raw = 'data: {"choices":[{"delta":\n' + 'data: {"content":"hi there"}}]}\n\n';
  const stream = makeStream([new TextEncoder().encode(raw)]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});
  t.is(result.content, 'hi there');
});

// ── Project-mode tools ──

const sampleFiles: ReaderAiFileEntry[] = [
  { path: 'README.md', content: '# Hello\n\nWelcome to the project.', size: 30 },
  { path: 'src/index.ts', content: 'import { foo } from "./foo";\nconsole.log(foo());', size: 48 },
  { path: 'src/foo.ts', content: 'export function foo() {\n  return "bar";\n}', size: 42 },
  { path: 'package.json', content: '{"name": "test", "version": "1.0.0"}', size: 36 },
];

test('read_file returns file content with line numbers', (t) => {
  const result = executeReaderAiReadFile(sampleFiles, { path: 'src/index.ts' });
  t.true(result.includes('src/index.ts'));
  t.true(result.includes('1: import { foo }'));
  t.true(result.includes('2: console.log'));
});

test('read_file returns error for missing file', (t) => {
  const result = executeReaderAiReadFile(sampleFiles, { path: 'nonexistent.ts' });
  t.true(result.includes('file not found'));
});

test('read_file supports case-insensitive path matching', (t) => {
  const result = executeReaderAiReadFile(sampleFiles, { path: 'README.MD' });
  t.true(result.includes('# Hello'));
});

test('read_file respects start_line and end_line', (t) => {
  const result = executeReaderAiReadFile(sampleFiles, { path: 'src/foo.ts', start_line: 2, end_line: 2 });
  t.true(result.includes('2:   return "bar";'));
  t.false(result.includes('1:'));
  t.false(result.includes('3:'));
});

test('search_files finds matches across files', (t) => {
  const result = executeReaderAiSearchFiles(sampleFiles, { query: 'foo' });
  t.true(result.includes('src/index.ts'));
  t.true(result.includes('src/foo.ts'));
});

test('search_files returns no matches message', (t) => {
  const result = executeReaderAiSearchFiles(sampleFiles, { query: 'xyznonexistent' });
  t.is(result, 'No matches found.');
});

test('search_files respects glob filter', (t) => {
  const result = executeReaderAiSearchFiles(sampleFiles, { query: 'foo', glob: '*.ts' });
  // Should not match files that don't end with .ts at root level
  t.false(result.includes('README.md'));
});

test('search_files reports no files for non-matching glob', (t) => {
  const result = executeReaderAiSearchFiles(sampleFiles, { query: 'foo', glob: '*.py' });
  t.true(result.includes('No files matching glob'));
});

test('list_files lists all files', (t) => {
  const result = executeReaderAiListFiles(sampleFiles, {});
  t.true(result.includes('4 files'));
  t.true(result.includes('README.md'));
  t.true(result.includes('src/index.ts'));
  t.true(result.includes('package.json'));
});

test('list_files filters by path prefix', (t) => {
  const result = executeReaderAiListFiles(sampleFiles, { path: 'src' });
  t.true(result.includes('2 files'));
  t.true(result.includes('src/index.ts'));
  t.true(result.includes('src/foo.ts'));
  t.false(result.includes('README.md'));
});

test('list_files returns error for empty path', (t) => {
  const result = executeReaderAiListFiles(sampleFiles, { path: 'nonexistent' });
  t.true(result.includes('no files under path'));
});

test('project sync tool dispatches read_file', (t) => {
  const result = executeReaderAiProjectSyncTool('read_file', '{"path":"README.md"}', sampleFiles);
  t.true(result.includes('# Hello'));
});

test('project sync tool omits CriticMarkup comments from read_file output', (t) => {
  const files = [{ path: 'README.md', content: 'start {>>hide<<} end', size: 20 }];
  const result = executeReaderAiProjectSyncTool('read_file', '{"path":"README.md"}', files);

  t.true(result.includes('1: start  end'));
  t.false(result.includes('hide'));
});

test('project sync tool dispatches search_files', (t) => {
  const result = executeReaderAiProjectSyncTool('search_files', '{"query":"foo"}', sampleFiles);
  t.true(result.includes('match'));
});

test('project sync tool dispatches list_files', (t) => {
  const result = executeReaderAiProjectSyncTool('list_files', '{}', sampleFiles);
  t.true(result.includes('4 files'));
});

test('project sync tool returns error for unknown tool', (t) => {
  const result = executeReaderAiProjectSyncTool('unknown_tool', '{}', sampleFiles);
  t.true(result.includes('unknown tool'));
});

test('READER_AI_PROJECT_TOOLS contains expected tools', (t) => {
  const names = READER_AI_PROJECT_TOOLS.map((t) => t.function.name);
  t.true(names.includes('read_file'));
  t.true(names.includes('search_files'));
  t.true(names.includes('list_files'));
  t.true(names.includes('task'));
});

test('READER_AI_PROJECT_SUBAGENT_TOOLS excludes task', (t) => {
  const names = READER_AI_PROJECT_SUBAGENT_TOOLS.map((t) => t.function.name);
  t.true(names.includes('read_file'));
  t.true(names.includes('propose_edit_file'));
  t.false(names.includes('task'));
});

test('project system prompt includes file tree and tools', (t) => {
  const prompt = buildReaderAiProjectSystemPrompt(sampleFiles, 'README.md');
  t.true(prompt.includes('read_file'));
  t.true(prompt.includes('search_files'));
  t.true(prompt.includes('list_files'));
  t.true(prompt.includes('propose_edit_file'));
  t.true(prompt.includes('task'));
  t.true(prompt.includes('README.md'));
  t.true(prompt.includes('src/index.ts'));
  t.true(prompt.includes('currently viewing'));
  t.true(prompt.includes('4 files'));
});

test('project system prompt omits CriticMarkup comments from current file preview', (t) => {
  const files = [{ path: 'README.md', content: 'alpha {>>hide<<} beta', size: 21 }];
  const prompt = buildReaderAiProjectSystemPrompt(files, 'README.md');

  t.true(prompt.includes('1: alpha  beta'));
  t.false(prompt.includes('hide'));
});

test('project system prompt works without current doc', (t) => {
  const prompt = buildReaderAiProjectSystemPrompt(sampleFiles, null);
  t.false(prompt.includes('currently viewing'));
  t.true(prompt.includes('4 files'));
});

test('project system prompt includes focused edit guidance when enabled', (t) => {
  const prompt = buildReaderAiProjectSystemPrompt(sampleFiles, 'README.md', true);
  t.true(prompt.includes('focused edit mode'));
  t.true(prompt.includes('Only edit this file: README.md'));
  t.true(prompt.includes('Do not create or delete files'));
  t.true(prompt.includes('Do not delegate edits to subagents'));
});

test('project system prompt discourages task by default and requires proposal tools for edits', (t) => {
  const prompt = buildReaderAiProjectSystemPrompt(sampleFiles, 'README.md');
  t.true(prompt.includes('Do not use the task tool unless the user explicitly asks for it'));
  t.true(prompt.includes('use propose_edit_file, propose_create_file, or propose_delete_file'));
});

// ── Token estimation ──

test('estimateTokens returns positive number', (t) => {
  t.true(estimateTokens(100) > 0);
  t.true(estimateTokens(0) === 0);
});

test('estimateMessagesTokens sums message content', (t) => {
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: 'Hello world' },
    { role: 'user', content: 'Test message' },
  ];
  const tokens = estimateMessagesTokens(messages);
  t.true(tokens > 0);
  t.true(tokens < 20); // should be modest for short messages
});

test('estimateMessagesTokens counts tool call arguments', (t) => {
  const messages: OpenRouterMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"foo.ts"}' } }],
    },
  ];
  const tokens = estimateMessagesTokens(messages);
  t.true(tokens > 0);
});

// ── Tool result compaction ──

test('compactToolResults truncates old tool results', (t) => {
  const longResult = 'x'.repeat(1000);
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 't1', content: longResult },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't2', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 't2', content: longResult },
  ];
  const reclaimed = compactToolResults(messages, 1);
  t.true(reclaimed > 0);
  // First tool result should be compacted, second preserved
  const firstToolResult = (messages[3] as { content: string }).content;
  const secondToolResult = (messages[5] as { content: string }).content;
  t.true(firstToolResult.length < 200);
  t.is(secondToolResult.length, 1000);
});

test('compactToolResults skips short results', (t) => {
  const messages: OpenRouterMessage[] = [{ role: 'tool', tool_call_id: 't1', content: 'short' }];
  const reclaimed = compactToolResults(messages, 0);
  t.is(reclaimed, 0);
  t.is((messages[0] as { content: string }).content, 'short');
});

test('compactToolResults returns 0 when nothing to compact', (t) => {
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ];
  const reclaimed = compactToolResults(messages, 1);
  t.is(reclaimed, 0);
});

// ── search_document with is_regex ──

test('search_document supports regex matching', (t) => {
  const lines = ['foo 123', 'bar 456', 'baz 789'];
  const result = executeReaderAiSearchDocument(lines, { query: '\\d{3}', is_regex: true });
  t.true(result.includes('3 matches'));
});

test('search_document regex returns error for invalid pattern', (t) => {
  const lines = ['hello'];
  const result = executeReaderAiSearchDocument(lines, { query: '(unclosed', is_regex: true });
  t.true(result.includes('invalid regular expression'));
});

test('search_document regex rejects patterns exceeding max length', (t) => {
  const lines = ['hello'];
  const longPattern = 'a'.repeat(READER_AI_MAX_REGEX_PATTERN_LENGTH + 1);
  const result = executeReaderAiSearchDocument(lines, { query: longPattern, is_regex: true });
  t.true(result.includes('invalid regular expression'));
});

test('search_files supports regex matching', (t) => {
  const files: ReaderAiFileEntry[] = [
    { path: 'a.ts', content: 'const x = 42;', size: 13 },
    { path: 'b.ts', content: 'let y = "hello";', size: 16 },
  ];
  const result = executeReaderAiSearchFiles(files, { query: '=\\s*\\d+', is_regex: true });
  t.true(result.includes('a.ts'));
  t.false(result.includes('b.ts'));
});

// ── generateUnifiedDiff ──

test('generateUnifiedDiff returns no changes for identical content', (t) => {
  const result = generateUnifiedDiff('file.txt', 'hello\nworld', 'hello\nworld');
  t.is(result, '(no changes)');
});

test('generateUnifiedDiff shows added lines', (t) => {
  const result = generateUnifiedDiff('file.txt', 'a\nb', 'a\nb\nc');
  t.true(result.includes('+c'));
  t.true(result.includes('--- a/file.txt'));
  t.true(result.includes('+++ b/file.txt'));
});

test('generateUnifiedDiff shows removed lines', (t) => {
  const result = generateUnifiedDiff('file.txt', 'a\nb\nc', 'a\nc');
  t.true(result.includes('-b'));
});

test('generateUnifiedDiff shows changed lines', (t) => {
  const result = generateUnifiedDiff('file.txt', 'old line', 'new line');
  t.true(result.includes('-old line'));
  t.true(result.includes('+new line'));
});

test('generateUnifiedDiff handles empty old content (new file)', (t) => {
  const result = generateUnifiedDiff('new.txt', '', 'hello\nworld');
  t.true(result.includes('+hello'));
  t.true(result.includes('+world'));
});

test('generateUnifiedDiff handles empty new content (deleted file)', (t) => {
  const result = generateUnifiedDiff('del.txt', 'hello\nworld', '');
  t.true(result.includes('-hello'));
  t.true(result.includes('-world'));
});

test('generateUnifiedDiff handles multiple separate hunks', (t) => {
  const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const newLines = [...oldLines];
  newLines[2] = 'CHANGED 3';
  newLines[17] = 'CHANGED 18';
  const result = generateUnifiedDiff('multi.txt', oldLines.join('\n'), newLines.join('\n'));
  t.true(result.includes('-line 3'));
  t.true(result.includes('+CHANGED 3'));
  t.true(result.includes('-line 18'));
  t.true(result.includes('+CHANGED 18'));
});

// ── StagedChanges ──

test('StagedChanges editFile replaces text and tracks change', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'hello world', size: 11 }];
  const sc = new StagedChanges(files);
  const result = sc.editFile('a.txt', 'hello', 'goodbye');
  t.true(result.includes('Edited a.txt'));
  t.is(sc.getContent('a.txt'), 'goodbye world');
  t.true(sc.hasChanges());
  const changes = sc.getChanges();
  t.is(changes.length, 1);
  t.is(changes[0].type, 'edit');
});

test('StagedChanges editFile returns error for missing file', (t) => {
  const sc = new StagedChanges([]);
  const result = sc.editFile('missing.txt', 'a', 'b');
  t.true(result.includes('file not found'));
});

test('StagedChanges editFile returns error for identical old/new text', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'hello', size: 5 }];
  const sc = new StagedChanges(files);
  const result = sc.editFile('a.txt', 'hello', 'hello');
  t.true(result.includes('identical'));
});

test('StagedChanges editFile returns error when old_text not found', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'hello', size: 5 }];
  const sc = new StagedChanges(files);
  const result = sc.editFile('a.txt', 'missing', 'x');
  t.true(result.includes('not found'));
});

test('StagedChanges editFile returns error for ambiguous match', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'aa bb aa', size: 8 }];
  const sc = new StagedChanges(files);
  const result = sc.editFile('a.txt', 'aa', 'cc');
  t.true(result.includes('multiple locations'));
});

test('StagedChanges editFile provides case-insensitive hint', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'Hello', size: 5 }];
  const sc = new StagedChanges(files);
  const result = sc.editFile('a.txt', 'hello', 'x');
  t.true(result.includes('case-insensitive'));
});

test('StagedChanges createFile adds new file', (t) => {
  const sc = new StagedChanges([]);
  const result = sc.createFile('new.txt', 'content');
  t.true(result.includes('Created new.txt'));
  t.is(sc.getContent('new.txt'), 'content');
  t.true(sc.hasFile('new.txt'));
});

test('StagedChanges createFile fails for existing file', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'x', size: 1 }];
  const sc = new StagedChanges(files);
  const result = sc.createFile('a.txt', 'y');
  t.true(result.includes('already exists'));
});

test('StagedChanges deleteFile removes file', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'x', size: 1 }];
  const sc = new StagedChanges(files);
  const result = sc.deleteFile('a.txt');
  t.true(result.includes('Deleted'));
  t.false(sc.hasFile('a.txt'));
  const changes = sc.getChanges();
  t.is(changes[0].type, 'delete');
});

test('StagedChanges deleteFile fails for missing file', (t) => {
  const sc = new StagedChanges([]);
  const result = sc.deleteFile('missing.txt');
  t.true(result.includes('file not found'));
});

test('StagedChanges create then delete removes the change entry', (t) => {
  const sc = new StagedChanges([]);
  sc.createFile('ghost.txt', 'content');
  t.true(sc.hasChanges());
  t.true(sc.hasFile('ghost.txt'));
  const result = sc.deleteFile('ghost.txt');
  t.true(result.includes('reverted create'));
  t.false(sc.hasChanges());
  t.false(sc.hasFile('ghost.txt'));
  t.is(sc.getChanges().length, 0);
});

test('StagedChanges reset restores original files', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'original', size: 8 }];
  const sc = new StagedChanges(files);
  sc.editFile('a.txt', 'original', 'modified');
  t.true(sc.hasChanges());
  sc.reset(files);
  t.false(sc.hasChanges());
  t.is(sc.getContent('a.txt'), 'original');
});

test('StagedChanges getWorkingFiles reflects staged changes', (t) => {
  const files: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'hello', size: 5 }];
  const sc = new StagedChanges(files);
  sc.editFile('a.txt', 'hello', 'goodbye');
  sc.createFile('b.txt', 'new');
  const working = sc.getWorkingFiles();
  t.is(working.length, 2);
  t.is(working.find((f) => f.path === 'a.txt')?.content, 'goodbye');
  t.is(working.find((f) => f.path === 'b.txt')?.content, 'new');
});

// ── simpleGlobMatch ──

test('simpleGlobMatch matches wildcard extensions', (t) => {
  t.true(simpleGlobMatch('*.ts', 'index.ts'));
  t.false(simpleGlobMatch('*.ts', 'index.js'));
  t.false(simpleGlobMatch('*.ts', 'src/index.ts'));
});

test('simpleGlobMatch matches ** across directories', (t) => {
  t.true(simpleGlobMatch('**/*.ts', 'src/index.ts'));
  t.true(simpleGlobMatch('**/*.ts', 'src/lib/deep/file.ts'));
  t.false(simpleGlobMatch('**/*.ts', 'src/index.js'));
});

test('simpleGlobMatch matches directory prefix', (t) => {
  t.true(simpleGlobMatch('src/**', 'src/index.ts'));
  t.true(simpleGlobMatch('src/**', 'src/lib/file.ts'));
  t.false(simpleGlobMatch('src/**', 'lib/file.ts'));
});

test('simpleGlobMatch matches ? for single char', (t) => {
  t.true(simpleGlobMatch('file?.ts', 'fileA.ts'));
  t.false(simpleGlobMatch('file?.ts', 'file.ts'));
  t.false(simpleGlobMatch('file?.ts', 'fileAB.ts'));
});

test('simpleGlobMatch is case-insensitive', (t) => {
  t.true(simpleGlobMatch('*.TS', 'index.ts'));
  t.true(simpleGlobMatch('README.*', 'readme.md'));
});
