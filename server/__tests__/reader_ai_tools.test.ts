import test from 'ava';
import {
  buildReaderAiProjectSystemPrompt,
  buildReaderAiSystemPrompt,
  compactToolResults,
  estimateMessagesTokens,
  estimateTokens,
  executeReaderAiListFiles,
  executeReaderAiProjectSyncTool,
  executeReaderAiReadDocument,
  executeReaderAiReadFile,
  executeReaderAiSearchDocument,
  executeReaderAiSearchFiles,
  executeReaderAiSyncTool,
  type OpenRouterMessage,
  parseReaderAiUpstreamStream,
  parseSseFieldValue,
  READER_AI_PROJECT_SUBAGENT_TOOLS,
  READER_AI_PROJECT_TOOLS,
  READER_AI_SUBAGENT_TOOLS,
  READER_AI_TOOL_RESULT_MAX_CHARS,
  READER_AI_TOOLS,
  type ReaderAiFileEntry,
  readUpstreamError,
} from '../reader_ai_tools.ts';

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
});

test('READER_AI_SUBAGENT_TOOLS excludes task tool', (t) => {
  const names = READER_AI_SUBAGENT_TOOLS.map((tool) => tool.function.name);
  t.false(names.includes('task'));
  t.true(names.includes('read_document'));
  t.true(names.includes('search_document'));
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

test('system prompt includes document info', (t) => {
  const source = 'a\nb\nc';
  const lines = source.split('\n');
  const prompt = buildReaderAiSystemPrompt(source, lines, 10_000);
  t.true(prompt.includes('3 lines'));
  t.true(prompt.includes(`${source.length} characters`));
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
  t.false(names.includes('task'));
});

test('project system prompt includes file tree and tools', (t) => {
  const prompt = buildReaderAiProjectSystemPrompt(sampleFiles, 'README.md');
  t.true(prompt.includes('read_file'));
  t.true(prompt.includes('search_files'));
  t.true(prompt.includes('list_files'));
  t.true(prompt.includes('task'));
  t.true(prompt.includes('README.md'));
  t.true(prompt.includes('src/index.ts'));
  t.true(prompt.includes('currently viewing'));
  t.true(prompt.includes('4 files'));
});

test('project system prompt works without current doc', (t) => {
  const prompt = buildReaderAiProjectSystemPrompt(sampleFiles, null);
  t.false(prompt.includes('currently viewing'));
  t.true(prompt.includes('4 files'));
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
