import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { initDictionaryFromBuffer } from '../../shared/stream_boundary_dictionary.ts';
import { stripCriticMarkupComments } from '../../src/criticmarkup.ts';
import {
  buildReaderAiPromptListSystemPrompt,
  buildReaderAiSystemPrompt,
  compactToolResults,
  estimateMessagesTokens,
  estimateTokens,
  executeReaderAiEditDocumentTool,
  executeReaderAiReadDocument,
  executeReaderAiSearchDocument,
  executeReaderAiSyncTool,
  executeReaderAiSyncToolWithState,
  generateUnifiedDiff,
  type OpenRouterMessage,
  parseReaderAiUpstreamStream,
  parseSseFieldValue,
  parseUnifiedDiffHunks,
  READER_AI_MAX_REGEX_PATTERN_LENGTH,
  READER_AI_SUBAGENT_TOOLS,
  READER_AI_TOOL_RESULT_MAX_CHARS,
  READER_AI_TOOLS,
  readUpstreamError,
  repairToolArgumentsJson,
} from '../reader_ai_tools.ts';

function loadBloomFilterOrThrow(): Uint8Array {
  const bloomData = new Uint8Array(readFileSync(bloomPath));
  const lfsPointerPrefix = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1');
  const looksLikeLfsPointer =
    bloomData.length >= lfsPointerPrefix.length && lfsPointerPrefix.every((byte, index) => bloomData[index] === byte);
  if (looksLikeLfsPointer || bloomData.length < 1024) {
    throw new Error(
      'shared/dictionary.bloom is not materialized. It looks like a Git LFS pointer, not the real bloom filter. Run `git lfs pull` (or otherwise materialize the LFS object) before running reader_ai_tools tests.',
    );
  }
  return bloomData;
}

// Load the bloom filter for dictionary-backed boundary detection in tests.
// This must succeed with the real bloom data, not an LFS pointer, or
// dictionary-dependent tests (photosynthesis, NVIDIA, etc.) will produce
// misleading failures.
const bloomPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'dictionary.bloom');
initDictionaryFromBuffer(loadBloomFilterOrThrow());

// ── Helper ──

function makeLines(count: number, prefix = 'Line'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

function buildMarkdownParagraphDocument(paragraphs: string[]): string {
  return [
    '# Title',
    '',
    ...paragraphs.flatMap((paragraph, index) => (index < paragraphs.length - 1 ? [paragraph, ''] : [paragraph])),
  ].join('\n');
}

function buildSingleLineParagraphDocument(paragraphs: string[]): string {
  return [
    '# Title',
    '',
    ...paragraphs.flatMap((paragraph, index) => (index < paragraphs.length - 1 ? [paragraph, ''] : [paragraph])),
  ].join('\n');
}

function makeParagraph(index: number): string {
  return `Paragraph ${index} first sentence.\nParagraph ${index} second sentence.`;
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
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, { start_line: 2, end_line: 3 }, state);
  const raw = executeReaderAiEditDocumentTool(
    '{"start_line":2,"end_line":3,"expected_old_text":"b\\nc","new_text":"X\\nY","dry_run":false}',
    state,
  );
  const parsed = JSON.parse(raw) as {
    ok: boolean;
    mode?: string;
    document_state?: {
      current_document?: string;
      proposal_state?: string;
      staged_revision?: number;
      total_lines?: number;
    };
  };
  t.true(parsed.ok);
  t.is(parsed.mode, 'line_range');
  t.is(parsed.document_state?.current_document, 'staged');
  t.is(parsed.document_state?.proposal_state, 'pending');
  t.is(parsed.document_state?.staged_revision, 1);
  t.is(parsed.document_state?.total_lines, 4);
  t.is(state.source, 'a\nX\nY\nd');
  t.truthy(state.stagedContent);
  t.is(state.stagedOriginalContent, 'a\nb\nc\nd');
});

test('propose_edit_document requires explicit dry_run for line-range replacement', (t) => {
  const state = {
    source: 'a\nb\nc\nd',
    lines: ['a', 'b', 'c', 'd'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, { start_line: 2, end_line: 3 }, state);
  const raw = executeReaderAiEditDocumentTool(
    '{"start_line":2,"end_line":3,"expected_old_text":"b\\nc","new_text":"X\\nY"}',
    state,
  );
  const parsed = JSON.parse(raw) as {
    ok: boolean;
    error?: { code?: string; message?: string; next_action?: string; details?: { missing_fields?: string[] } };
    document_state?: { current_document?: string; proposal_state?: string };
  };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'invalid_args');
  t.true(parsed.error?.message?.includes('explicit dry_run value') ?? false);
  t.true(parsed.error?.next_action?.includes('Set dry_run to true') ?? false);
  t.deepEqual(parsed.error?.details?.missing_fields, ['dry_run']);
  t.is(parsed.document_state?.current_document, 'original');
  t.is(parsed.document_state?.proposal_state, 'none');
  t.is(state.source, 'a\nb\nc\nd');
  t.is(state.stagedOriginalContent, null);
  t.is(state.stagedContent, null);
});

test('propose_edit_document supports atomic batched edits', (t) => {
  const state = {
    source: 'one\ntwo\nthree',
    lines: ['one', 'two', 'three'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, { start_line: 1, end_line: 2 }, state);
  const raw = executeReaderAiEditDocumentTool(
    '{"edits":[{"old_text":"one","new_text":"ONE"},{"start_line":2,"end_line":2,"expected_old_text":"two","new_text":"TWO"}],"dry_run":false}',
    state,
  );
  const parsed = JSON.parse(raw) as { ok: boolean; mode?: string; edits_applied?: number };
  t.true(parsed.ok);
  t.is(parsed.mode, 'batch');
  t.is(parsed.edits_applied, 2);
  t.is(state.source, 'ONE\nTWO\nthree');
});

test('propose_edit_document defaults new_text to empty string for snippet deletion', (t) => {
  const state = {
    source: 'keep\ndelete me\nkeep too',
    lines: ['keep', 'delete me', 'keep too'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, {}, state);
  const raw = executeReaderAiEditDocumentTool('{"old_text":"\\ndelete me"}', state);
  const parsed = JSON.parse(raw) as { ok: boolean; mode?: string };
  t.true(parsed.ok);
  t.is(parsed.mode, 'snippet');
  t.is(state.source, 'keep\nkeep too');
});

test('propose_edit_document defaults new_text to empty string for batch snippet deletion', (t) => {
  const state = {
    source: 'aaa\nbbb\nccc\nddd\neee',
    lines: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, {}, state);
  const raw = executeReaderAiEditDocumentTool(
    '{"edits":[{"old_text":"bbb"},{"old_text":"ddd"}]}',
    state,
  );
  const parsed = JSON.parse(raw) as { ok: boolean; edits_applied?: number };
  t.true(parsed.ok);
  t.is(parsed.edits_applied, 2);
  t.is(state.source, 'aaa\n\nccc\n\neee');
});

test('propose_edit_document batch line-range edits use original line numbers', (t) => {
  const state = {
    source: 'line1\nline2\nline3\nline4\nline5',
    lines: ['line1', 'line2', 'line3', 'line4', 'line5'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, {}, state);
  // Delete lines 2 and 4 using original-document line numbers.
  // Without offset adjustment, the second edit would hit line 4 in the
  // mutated document (originally line 5) instead of original line 4.
  const raw = executeReaderAiEditDocumentTool(
    '{"edits":[{"start_line":2,"end_line":2,"expected_old_text":"line2","dry_run":false},{"start_line":4,"end_line":4,"expected_old_text":"line4","dry_run":false}],"dry_run":false}',
    state,
  );
  const parsed = JSON.parse(raw) as { ok: boolean; edits_applied?: number };
  t.true(parsed.ok);
  t.is(parsed.edits_applied, 2);
  t.is(state.source, 'line1\n\nline3\n\nline5');
});

test('propose_edit_document batch failures are atomic', (t) => {
  const state = {
    source: 'alpha\nbeta',
    lines: ['alpha', 'beta'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, { start_line: 1, end_line: 2 }, state);
  const raw = executeReaderAiEditDocumentTool(
    '{"edits":[{"old_text":"alpha","new_text":"ALPHA"},{"old_text":"missing","new_text":"x"}]}',
    state,
  );
  const parsed = JSON.parse(raw) as {
    ok: boolean;
    error?: { code?: string; next_action?: string };
    document_state?: { proposal_state?: string };
  };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'missing_read');
  t.true(parsed.error?.next_action?.includes('Call read_document') ?? false);
  t.is(parsed.document_state?.proposal_state, 'none');
  t.is(state.source, 'alpha\nbeta');
  t.is(state.stagedContent, null);
});

test('propose_edit_document guarded line-range edits fail on stale text', (t) => {
  const state = {
    source: 'alpha\nbeta\ngamma',
    lines: ['alpha', 'beta', 'gamma'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, { start_line: 2, end_line: 2 }, state);
  const raw = executeReaderAiEditDocumentTool(
    '{"start_line":2,"end_line":2,"new_text":"BETA","expected_old_text":"stale beta","dry_run":false}',
    state,
  );
  const parsed = JSON.parse(raw) as {
    ok: boolean;
    error?: {
      code?: string;
      message?: string;
      next_action?: string;
      details?: { current_text?: string; expected_old_text?: string; edit_mode?: string };
    };
  };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'missing_read');
  t.true(parsed.error?.message?.includes('expected_old_text copied from the latest read_document result') ?? false);
  t.true(parsed.error?.next_action?.includes('Call read_document for the exact line range') ?? false);
  t.is(parsed.error?.details?.edit_mode, 'line_range');
  t.is(state.source, 'alpha\nbeta\ngamma');
  t.is(state.stagedContent, null);
});

test('propose_edit_document dry_run previews without applying', (t) => {
  const state = {
    source: 'left right',
    lines: ['left right'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, { start_line: 1, end_line: 1 }, state);
  const raw = executeReaderAiEditDocumentTool('{"old_text":"left","new_text":"LEFT","dry_run":true}', state);
  const parsed = JSON.parse(raw) as { ok: boolean; dry_run?: boolean; applied?: boolean };
  t.true(parsed.ok);
  t.true(parsed.dry_run);
  t.false(parsed.applied);
  t.is(state.source, 'left right');
  t.is(state.stagedOriginalContent, null);
  t.is(state.stagedContent, null);
});

test('propose_edit_document returns structured invalid_json error', (t) => {
  const state = {
    source: 'x',
    lines: ['x'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  const raw = executeReaderAiEditDocumentTool('{bad', state);
  const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string } };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'invalid_json');
});

test('propose_edit_document requires a fresh read before editing', (t) => {
  const state = {
    source: 'left right',
    lines: ['left right'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  const raw = executeReaderAiEditDocumentTool('{"old_text":"left","new_text":"LEFT","dry_run":false}', state);
  const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string; message?: string } };
  t.false(parsed.ok);
  t.is(parsed.error?.code, 'missing_read');
  t.true(parsed.error?.message?.includes('call read_document') ?? false);
});

test('propose_edit_document returns ambiguity hints', (t) => {
  const state = {
    source: 'repeat\nx\nrepeat\ny\nrepeat',
    lines: ['repeat', 'x', 'repeat', 'y', 'repeat'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };
  executeReaderAiReadDocument(state.lines, { start_line: 1, end_line: 5 }, state);
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

test('propose_edit_document preserves the true original and cumulative diff across successive proposals', (t) => {
  const state = {
    source: 'alpha\nbeta\ngamma',
    lines: ['alpha', 'beta', 'gamma'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: null as string | null,
    stagedDiff: null as string | null,
    stagedRevision: 0,
  };

  executeReaderAiReadDocument(state.lines, { start_line: 2, end_line: 2 }, state);
  const firstRaw = executeReaderAiEditDocumentTool('{"old_text":"beta","new_text":"BETA"}', state);
  const firstParsed = JSON.parse(firstRaw) as { ok: boolean; diff?: string };
  t.true(firstParsed.ok);
  t.is(state.stagedOriginalContent, 'alpha\nbeta\ngamma');
  t.is(state.stagedContent, 'alpha\nBETA\ngamma');
  t.is(firstParsed.diff, generateUnifiedDiff('doc.md', 'alpha\nbeta\ngamma', 'alpha\nBETA\ngamma'));

  executeReaderAiReadDocument(state.lines, { start_line: 3, end_line: 3 }, state);
  const secondRaw = executeReaderAiEditDocumentTool('{"old_text":"gamma","new_text":"GAMMA"}', state);
  const secondParsed = JSON.parse(secondRaw) as { ok: boolean; diff?: string };
  t.true(secondParsed.ok);
  t.is(state.stagedOriginalContent, 'alpha\nbeta\ngamma');
  t.is(state.stagedContent, 'alpha\nBETA\nGAMMA');
  t.is(state.stagedDiff, generateUnifiedDiff('doc.md', 'alpha\nbeta\ngamma', 'alpha\nBETA\nGAMMA'));
  t.is(secondParsed.diff, generateUnifiedDiff('doc.md', 'alpha\nbeta\ngamma', 'alpha\nBETA\nGAMMA'));
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

test('sync tool uses staged document state when provided', (t) => {
  const state = {
    source: 'alpha\nbeta',
    lines: ['alpha', 'beta'],
    currentDocPath: 'doc.md',
    stagedOriginalContent: null as string | null,
    stagedContent: 'alpha\nbeta' as string | null,
    stagedDiff: '--- a/doc.md\n+++ b/doc.md' as string | null,
    stagedRevision: 1,
  };
  const result = executeReaderAiSyncToolWithState('read_document', '{"start_line":2,"end_line":2}', {
    lines: ['stale one', 'stale two'],
    state,
  });
  t.is(result, '(staged document; staged revision 1; 2 total lines; proposal state: pending)\n2: beta');
});

// ── READER_AI_TOOLS / READER_AI_SUBAGENT_TOOLS ──

test('READER_AI_TOOLS contains task tool', (t) => {
  const names = READER_AI_TOOLS.map((tool) => tool.function.name);
  t.true(names.includes('task'));
  t.true(names.includes('read_document'));
  t.true(names.includes('search_document'));
  t.true(names.includes('propose_edit_document'));
});

test('edit-related tool descriptions steer toward atomic block edits', (t) => {
  const readTool = READER_AI_TOOLS.find((tool) => tool.function.name === 'read_document');
  const editTool = READER_AI_TOOLS.find((tool) => tool.function.name === 'propose_edit_document');
  const oldText = editTool?.function.parameters.properties.old_text as { description?: string } | undefined;
  const newText = editTool?.function.parameters.properties.new_text as { description?: string } | undefined;
  const startLine = editTool?.function.parameters.properties.start_line as { description?: string } | undefined;
  const edits = editTool?.function.parameters.properties.edits as { description?: string } | undefined;

  t.truthy(readTool);
  t.truthy(editTool);
  t.true(readTool?.function.description.includes('read the exact affected span immediately before proposing the edit'));
  t.true(readTool?.function.description.includes('copy old_text from the latest read_document result'));
  t.true(readTool?.function.description.includes('whether you are reading the original or staged document'));
  t.true(editTool?.function.description.includes('single atomic exact-text replacement after reading the target span'));
  t.true(editTool?.function.description.includes('preferred when the target text is stable'));
  t.true(editTool?.function.description.includes('omit it to delete the matched content'));
  t.true(editTool?.function.description.includes('Whitespace and blank lines are literal'));
  t.true(
    editTool?.function.description.includes('Line-range edits require expected_old_text and an explicit dry_run value'),
  );
  t.true(
    editTool?.function.description.includes(
      '{ ok: false, tool: "propose_edit_document", error: { code, message, details, next_action }, document_state }',
    ),
  );
  t.true(oldText?.description?.includes('full paragraph or enough surrounding text') ?? false);
  t.true(oldText?.description?.includes('latest read_document result') ?? false);
  t.true(newText?.description?.includes('Omit to delete the matched content') ?? false);
  t.true(newText?.description?.includes('Whitespace and newlines are literal') ?? false);
  t.true(startLine?.description?.includes('exact positions from a fresh read_document call') ?? false);
  t.true(
    edits?.description?.includes(
      '{ ok: false, tool: "propose_edit_document", error: { code, message, details, next_action }, document_state }',
    ) ?? false,
  );
  t.true(
    (
      editTool?.function.parameters.properties.expected_old_text as { description?: string } | undefined
    )?.description?.includes('For line-range edits this is required') ?? false,
  );
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

test('system prompt omits propose_edit_document when document edits are disabled', (t) => {
  const prompt = buildReaderAiSystemPrompt('hello', ['hello'], 10_000, 'doc.md', false);
  t.false(prompt.includes('propose_edit_document'));
  t.true(prompt.includes('read-only while the user is viewing the document'));
});

test('system prompt discourages task by default and requires proposal tools for edits', (t) => {
  const prompt = buildReaderAiSystemPrompt('hello', ['hello'], 10_000);
  t.true(prompt.includes('Do not use the task tool unless the user explicitly asks for it'));
  t.true(prompt.includes('whether you are looking at the original or staged document'));
  t.true(prompt.includes('call propose_edit_document instead of describing the edit in text'));
  t.true(prompt.includes('Use the latest read_document result as the only source for old_text or expected_old_text'));
  t.true(
    prompt.includes('prefer exact-text replacement with old_text copied directly from the latest read_document result'),
  );
  t.true(prompt.includes('first call read_document for the exact affected span'));
  t.true(prompt.includes('make exactly one propose_edit_document call'));
  t.true(prompt.includes('Splitting an intended edit into multiple delete/fix proposals WILL NOT WORK'));
  t.true(prompt.includes('document_state summary as the source of truth'));
  t.true(prompt.includes('Do not describe edit outcomes from memory'));
  t.true(prompt.includes('do not patch the previous proposal incrementally'));
  t.true(prompt.includes('set dry_run explicitly to true or false'));
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

test('stream parser tolerates repeated streamed tool-call name fragments', async (t) => {
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_repeat', function: { name: 'read', arguments: '{"pat' } }],
          },
        },
      ],
    }),
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: 'read_document', arguments: '{"path":"doc' } }],
          },
        },
      ],
    }),
    sseChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.md"}' } }] } }],
    }),
    sseChunk({ choices: [{ finish_reason: 'tool_calls' }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});

  t.is(result.toolCalls.length, 1);
  t.is(result.toolCalls[0].id, 'call_repeat');
  t.is(result.toolCalls[0].name, 'read_document');
  t.is(result.toolCalls[0].arguments, '{"path":"doc.md"}');
});

test('stream parser preserves tool call order without explicit indices', async (t) => {
  const stream = makeStream([
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'call_a', function: { name: 'read_document', arguments: '{}' } },
              { id: 'call_b', function: { name: 'search_document', arguments: '{"query":"needle"}' } },
            ],
          },
        },
      ],
    }),
    sseChunk({ choices: [{ finish_reason: 'tool_calls' }] }),
    sseDone(),
  ]);

  const result = await parseReaderAiUpstreamStream(stream, () => {});

  t.deepEqual(
    result.toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments })),
    [
      { id: 'call_a', name: 'read_document', arguments: '{}' },
      { id: 'call_b', name: 'search_document', arguments: '{"query":"needle"}' },
    ],
  );
});

test('repairToolArgumentsJson can close truncated object payloads', (t) => {
  t.is(
    repairToolArgumentsJson('{"path":"src/app.ts","query":"reader ai"'),
    '{"path":"src/app.ts","query":"reader ai"}',
  );
});

test('repairToolArgumentsJson trims trailing commas before close', (t) => {
  t.is(
    repairToolArgumentsJson('{"path":"src/app.ts","query":"reader ai",}'),
    '{"path":"src/app.ts","query":"reader ai"}',
  );
});

test('repairToolArgumentsJson can close truncated object payloads without file-tool support', (t) => {
  const repaired = repairToolArgumentsJson('{"query":"reader ai",}') ?? '';
  t.is(repaired, '{"query":"reader ai"}');
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

test('parseUnifiedDiffHunks splits a merged raw hunk into smaller review hunks', (t) => {
  const oldLines = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[1] = 'CHANGED 2';
  newLines[5] = 'CHANGED 6';

  const diff = generateUnifiedDiff('split.txt', oldLines.join('\n'), newLines.join('\n'));
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.is(hunks.length, 2);
  t.deepEqual(
    hunks.map((hunk) => ({
      header: hunk.header,
      lines: hunk.lines,
    })),
    [
      {
        header: '@@ -1,3 +1,3 @@',
        lines: [
          { type: 'context', content: 'line 1' },
          { type: 'del', content: 'line 2' },
          { type: 'add', content: 'CHANGED 2' },
          { type: 'context', content: 'line 3' },
        ],
      },
      {
        header: '@@ -4,5 +4,5 @@',
        lines: [
          { type: 'context', content: 'line 4' },
          { type: 'context', content: 'line 5' },
          { type: 'del', content: 'line 6' },
          { type: 'add', content: 'CHANGED 6' },
          { type: 'context', content: 'line 7' },
          { type: 'context', content: 'line 8' },
        ],
      },
    ],
  );
});

test('parseUnifiedDiffHunks keeps markdown paragraph context intact when deleting alternating paragraphs', (t) => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => makeParagraph(index + 1));
  const original = buildMarkdownParagraphDocument(paragraphs);
  const modified = buildMarkdownParagraphDocument(paragraphs.filter((_, index) => ![0, 2, 4].includes(index)));

  const diff = generateUnifiedDiff('doc.md', original, modified);
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.is(hunks.length, 3);
  t.true(
    hunks.every((hunk) => {
      const hasParagraph2Line1 = hunk.lines.some((line) => line.content === 'Paragraph 2 first sentence.');
      const hasParagraph2Line2 = hunk.lines.some((line) => line.content === 'Paragraph 2 second sentence.');
      return hasParagraph2Line1 === hasParagraph2Line2;
    }),
  );
  t.true(
    hunks.every((hunk) => {
      const hasParagraph4Line1 = hunk.lines.some((line) => line.content === 'Paragraph 4 first sentence.');
      const hasParagraph4Line2 = hunk.lines.some((line) => line.content === 'Paragraph 4 second sentence.');
      return hasParagraph4Line1 === hasParagraph4Line2;
    }),
  );
});

test('parseUnifiedDiffHunks splits insertion-only clusters inside a single raw hunk', (t) => {
  const original = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
  const modifiedLines = ['a', 'b', 'insert 1', 'c', 'd', 'e', 'insert 2', 'f', 'g', 'h'];

  const diff = generateUnifiedDiff('insertions.txt', original, modifiedLines.join('\n'));
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.deepEqual(
    hunks.map((hunk) => hunk.header),
    ['@@ -1,3 +1,4 @@', '@@ -4,5 +5,6 @@'],
  );
});

test('parseUnifiedDiffHunks splits deletion-only clusters inside a single raw hunk', (t) => {
  const originalLines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const modified = originalLines.filter((_, index) => index !== 2 && index !== 5).join('\n');

  const diff = generateUnifiedDiff('deletions.txt', originalLines.join('\n'), modified);
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.deepEqual(
    hunks.map((hunk) => hunk.header),
    ['@@ -1,4 +1,3 @@', '@@ -5,4 +4,3 @@'],
  );
});

test('parseUnifiedDiffHunks keeps adjacent replacements merged into one review hunk', (t) => {
  const original = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
  const modified = ['a', 'b', 'C1', 'D1', 'e', 'f'].join('\n');

  const diff = generateUnifiedDiff('adjacent.txt', original, modified);
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.is(hunks.length, 1);
  t.is(hunks[0]?.header, '@@ -1,6 +1,6 @@');
});

test('parseUnifiedDiffHunks preserves valid edge ranges when splitting start and end edits', (t) => {
  const original = ['start', 'a', 'b', 'c', 'd', 'e', 'end'].join('\n');
  const modified = ['START', 'a', 'b', 'c', 'd', 'E', 'end'].join('\n');

  const diff = generateUnifiedDiff('edges.txt', original, modified);
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.deepEqual(
    hunks.map((hunk) => hunk.header),
    ['@@ -1,3 +1,3 @@', '@@ -4,4 +4,4 @@'],
  );
});

test('parseUnifiedDiffHunks splits mixed delete and replace clusters into separate review hunks', (t) => {
  const original = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].join('\n');
  const modified = ['alpha', 'gamma', 'delta', 'epsilon', 'ZETA!', 'eta', 'theta'].join('\n');

  const diff = generateUnifiedDiff('mixed.txt', original, modified);
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.deepEqual(
    hunks.map((hunk) => hunk.header),
    ['@@ -1,3 +1,2 @@', '@@ -4,5 +3,5 @@'],
  );
});

test('parseUnifiedDiffHunks does not split a surviving markdown list item across review hunks', (t) => {
  const original = [
    '# List',
    '',
    '- item 1 line 1',
    '  item 1 line 2',
    '- item 2 line 1',
    '  item 2 line 2',
    '- item 3 line 1',
    '  item 3 line 2',
    '- item 4 line 1',
    '  item 4 line 2',
  ].join('\n');
  const modified = ['# List', '', '- item 2 line 1', '  item 2 line 2', '- item 4 line 1', '  item 4 line 2'].join(
    '\n',
  );

  const hunks = parseUnifiedDiffHunks(generateUnifiedDiff('list.md', original, modified));

  t.is(hunks.length, 2);
  t.true(
    hunks.every((hunk) => {
      const hasFirstLine = hunk.lines.some((line) => line.content === '- item 2 line 1');
      const hasSecondLine = hunk.lines.some((line) => line.content === '  item 2 line 2');
      return hasFirstLine === hasSecondLine;
    }),
  );
});

test('parseUnifiedDiffHunks does not split a surviving blockquote paragraph across review hunks', (t) => {
  const original = [
    '# Quote',
    '',
    '> quote 1 line 1',
    '> quote 1 line 2',
    '> quote 2 line 1',
    '> quote 2 line 2',
    '> quote 3 line 1',
    '> quote 3 line 2',
    '> quote 4 line 1',
    '> quote 4 line 2',
  ].join('\n');
  const modified = ['# Quote', '', '> quote 2 line 1', '> quote 2 line 2', '> quote 4 line 1', '> quote 4 line 2'].join(
    '\n',
  );

  const hunks = parseUnifiedDiffHunks(generateUnifiedDiff('quote.md', original, modified));

  t.is(hunks.length, 2);
  t.true(
    hunks.every((hunk) => {
      const hasFirstLine = hunk.lines.some((line) => line.content === '> quote 2 line 1');
      const hasSecondLine = hunk.lines.some((line) => line.content === '> quote 2 line 2');
      return hasFirstLine === hasSecondLine;
    }),
  );
});

test('parseUnifiedDiffHunks keeps edits inside one fenced code block merged', (t) => {
  const original = [
    '# Code',
    '',
    '```js',
    'const a = 1;',
    'const keep1 = true;',
    'const b = 2;',
    'const keep2 = true;',
    'const c = 3;',
    '```',
  ].join('\n');
  const modified = ['# Code', '', '```js', 'const keep1 = true;', 'const keep2 = true;', '```'].join('\n');

  const diff = generateUnifiedDiff('code.md', original, modified);
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.is(hunks.length, 1);
});

test('parseUnifiedDiffHunks keeps surviving paragraphs intact when a blank line is removed between review blocks', (t) => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => makeParagraph(index + 1));
  const original = buildMarkdownParagraphDocument(paragraphs);
  const kept = paragraphs.filter((_, index) => ![0, 2, 4].includes(index));
  const modified = [
    '# Title',
    '',
    kept[0],
    kept[1],
    '',
    kept[2],
    '',
    kept[3],
    '',
    kept[4],
    '',
    kept[5],
    '',
    kept[6],
  ].join('\n');

  const hunks = parseUnifiedDiffHunks(generateUnifiedDiff('doc.md', original, modified));

  t.is(hunks.length, 3);
  t.true(
    hunks.every((hunk) => {
      const hasFirstLine = hunk.lines.some((line) => line.content === 'Paragraph 2 first sentence.');
      const hasSecondLine = hunk.lines.some((line) => line.content === 'Paragraph 2 second sentence.');
      return hasFirstLine === hasSecondLine;
    }),
  );
  t.true(
    hunks.every((hunk) => {
      const hasFirstLine = hunk.lines.some((line) => line.content === 'Paragraph 4 first sentence.');
      const hasSecondLine = hunk.lines.some((line) => line.content === 'Paragraph 4 second sentence.');
      return hasFirstLine === hasSecondLine;
    }),
  );
});

test('parseUnifiedDiffHunks keeps deletion blocks grouped when an extra blank line is added between review blocks', (t) => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => makeParagraph(index + 1));
  const original = buildMarkdownParagraphDocument(paragraphs);
  const kept = paragraphs.filter((_, index) => ![0, 2, 4].includes(index));
  const modified = [
    '# Title',
    '',
    kept[0],
    '',
    '',
    kept[1],
    '',
    kept[2],
    '',
    kept[3],
    '',
    kept[4],
    '',
    kept[5],
    '',
    kept[6],
  ].join('\n');

  const hunks = parseUnifiedDiffHunks(generateUnifiedDiff('doc.md', original, modified));

  t.is(hunks.length, 3);
  t.true(
    hunks.every((hunk) =>
      hunk.lines.some((line) => line.type === 'del') ? hunk.lines.some((line) => line.content === '') : true,
    ),
  );
  t.true(
    hunks.every((hunk) => {
      const hasParagraph4 = hunk.lines.some((line) => line.content === 'Paragraph 4 first sentence.');
      if (!hasParagraph4) return true;
      return hunk.lines.some((line) => line.content === 'Paragraph 4 second sentence.');
    }),
  );
});

test('parseUnifiedDiffHunks keeps paragraph deletions grouped with adjacent blank-line additions for single-line paragraphs', (t) => {
  const paragraphs = Array.from({ length: 7 }, (_, index) => `Paragraph ${index + 1}.`);
  const original = buildSingleLineParagraphDocument(paragraphs);
  const kept = paragraphs.filter((_, index) => ![0, 2, 4].includes(index));
  const modified = ['# Title', '', kept[0], '', '', kept[1], '', '', kept[2], '', kept[3]].join('\n');

  const diff = generateUnifiedDiff('doc.md', original, modified);
  t.is(diff.match(/^@@/gm)?.length ?? 0, 1);

  const hunks = parseUnifiedDiffHunks(diff);

  t.is(hunks.length, 3);
  t.true(
    hunks.every((hunk) => {
      const blankAddCount = hunk.lines.filter((line) => line.type === 'add' && line.content === '').length;
      const nonBlankDeleteCount = hunk.lines.filter(
        (line) => line.type === 'del' && line.content.trim().length > 0,
      ).length;
      return blankAddCount === 0 || nonBlankDeleteCount > 0;
    }),
  );
});
