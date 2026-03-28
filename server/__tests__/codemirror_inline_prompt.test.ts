import { EditorState } from '@codemirror/state';
import test from 'ava';
import {
  bracePromptContextRangesForPosition,
  buildBracePromptRequest,
  findBracePromptMatch,
  findInlinePromptMatch,
  isBracePromptBlockedInCode,
  lineRangeAt,
} from '../../src/components/codemirror_inline_prompt.ts';
import { markdownEditorLanguageSupport } from '../../src/components/codemirror_markdown.ts';
import { READER_AI_SELECTION_MAX_CHARS } from '../../src/reader_ai_limits.ts';

test('findInlinePromptMatch finds slash prompts at valid boundaries', (t) => {
  const text = 'Ask /rewrite this';
  const match = findInlinePromptMatch(text, text.length);

  t.deepEqual(match, {
    from: 4,
    to: 17,
    prompt: 'rewrite this',
  });
});

test('findInlinePromptMatch ignores slashes inside URLs and paths', (t) => {
  t.is(findInlinePromptMatch('https://example.com', 'https://example.com'.length), null);
  t.is(findInlinePromptMatch('path/to/file', 'path/to/file'.length), null);
});

test('findInlinePromptMatch ignores slash prompts with whitespace immediately after the slash', (t) => {
  t.is(findInlinePromptMatch('/ rewrite this', '/ rewrite this'.length), null);
  t.is(findInlinePromptMatch('/\trewrite this', '/\trewrite this'.length), null);
});

test('findBracePromptMatch finds brace prompts when the cursor is after the closing brace', (t) => {
  const text = 'today {come up with two more examples}';

  t.deepEqual(findBracePromptMatch(text, text.length), {
    from: 6,
    to: text.length,
    prompt: 'come up with two more examples',
    kind: 'single',
  });
});

test('findBracePromptMatch finds double-brace expansion directives', (t) => {
  const text = 'today {{expand this section}}';

  t.deepEqual(findBracePromptMatch(text, text.length), {
    from: 6,
    to: text.length,
    prompt: 'expand this section',
    kind: 'double',
  });
});

test('findBracePromptMatch ignores cursors that are not immediately after a closing brace', (t) => {
  t.is(findBracePromptMatch('today {query}', 'today {query'.length), null);
  t.is(findBracePromptMatch('today {query} next', 'today {query} '.length), null);
});

test('findBracePromptMatch ignores CriticMarkup spans', (t) => {
  t.is(findBracePromptMatch('{++addition++}', '{++addition++}'.length), null);
  t.is(findBracePromptMatch('{--deletion--}', '{--deletion--}'.length), null);
  t.is(findBracePromptMatch('{==highlight==}', '{==highlight==}'.length), null);
  t.is(findBracePromptMatch('{>>comment<<}', '{>>comment<<}'.length), null);
  t.is(findBracePromptMatch('{~~before~>after~~}', '{~~before~>after~~}'.length), null);
});

test('findBracePromptMatch ignores CriticMarkup-like shorthand and malformed variants', (t) => {
  t.is(findBracePromptMatch('{+ query +}', '{+ query +}'.length), null);
  t.is(findBracePromptMatch('{+query+}', '{+query+}'.length), null);
  t.is(findBracePromptMatch('{+query +}', '{+query +}'.length), null);
  t.is(findBracePromptMatch('{+ query+}', '{+ query+}'.length), null);
  t.is(findBracePromptMatch('{- query -}', '{- query -}'.length), null);
  t.is(findBracePromptMatch('{-query-}', '{-query-}'.length), null);
  t.is(findBracePromptMatch('{-query -}', '{-query -}'.length), null);
  t.is(findBracePromptMatch('{- query-}', '{- query-}'.length), null);
  t.is(findBracePromptMatch('{= query =}', '{= query =}'.length), null);
  t.is(findBracePromptMatch('{=query=}', '{=query=}'.length), null);
  t.is(findBracePromptMatch('{=query =}', '{=query =}'.length), null);
  t.is(findBracePromptMatch('{= query=}', '{= query=}'.length), null);
  t.is(findBracePromptMatch('{> query <}', '{> query <}'.length), null);
  t.is(findBracePromptMatch('{>query<}', '{>query<}'.length), null);
  t.is(findBracePromptMatch('{>query <}', '{>query <}'.length), null);
  t.is(findBracePromptMatch('{> query<}', '{> query<}'.length), null);
  t.is(findBracePromptMatch('{~ query ~}', '{~ query ~}'.length), null);
  t.is(findBracePromptMatch('{~query~}', '{~query~}'.length), null);
  t.is(findBracePromptMatch('{~query ~}', '{~query ~}'.length), null);
  t.is(findBracePromptMatch('{~ query~}', '{~ query~}'.length), null);
  t.is(findBracePromptMatch('{+ query}', '{+ query}'.length), null);
  t.is(findBracePromptMatch('{+query}', '{+query}'.length), null);
  t.is(findBracePromptMatch('{- query}', '{- query}'.length), null);
  t.is(findBracePromptMatch('{-query}', '{-query}'.length), null);
  t.is(findBracePromptMatch('{= query}', '{= query}'.length), null);
  t.is(findBracePromptMatch('{=query}', '{=query}'.length), null);
  t.is(findBracePromptMatch('{> query}', '{> query}'.length), null);
  t.is(findBracePromptMatch('{>query}', '{>query}'.length), null);
  t.is(findBracePromptMatch('{~ query}', '{~ query}'.length), null);
  t.is(findBracePromptMatch('{~query}', '{~query}'.length), null);
});

test('findBracePromptMatch ignores tripled braces', (t) => {
  t.is(findBracePromptMatch('{{{multiply wrapped braces}}}', '{{{multiply wrapped braces}}}'.length), null);
});

test('buildBracePromptRequest keeps default brace prompts scoped to the document prefix', (t) => {
  const text = 'Alpha {rewrite this} beta\nstill same paragraph\n\nNext paragraph';
  const position = 'Alpha {rewrite this}'.length;

  t.deepEqual(buildBracePromptRequest(text, position), {
    prompt: 'rewrite this',
    from: 6,
    to: position,
    documentContent: text.slice(0, position),
    paragraphTail: '',
    mode: 'replace',
    candidateCount: 5,
    excludeOptions: [],
    chatMessages: [],
  });
});

test('buildBracePromptRequest scopes double-brace directives to the nearest header', (t) => {
  const text = ['Intro', '# Heading', 'Alpha', 'Beta {{expand}}'].join('\n');
  const position = text.length;

  t.deepEqual(buildBracePromptRequest(text, position), {
    prompt: 'expand',
    from: text.length - '{{expand}}'.length,
    to: position,
    documentContent: ['# Heading', 'Alpha', 'Beta {{expand}}'].join('\n'),
    paragraphTail: '',
    mode: 'replace',
    candidateCount: 5,
    excludeOptions: [],
    chatMessages: [],
  });
});

test('buildBracePromptRequest trims divider lines out of double-brace directive context', (t) => {
  const text = ['Intro', '---', 'Alpha', 'Beta {{expand}}'].join('\n');
  const position = text.length;

  t.deepEqual(buildBracePromptRequest(text, position), {
    prompt: 'expand',
    from: text.length - '{{expand}}'.length,
    to: position,
    documentContent: ['Alpha', 'Beta {{expand}}'].join('\n'),
    paragraphTail: '',
    mode: 'replace',
    candidateCount: 5,
    excludeOptions: [],
    chatMessages: [],
  });
});

test('bracePromptContextRangesForPosition spans earlier paragraphs for double-brace directives', (t) => {
  const text = ['# Heading', 'First paragraph.', '', 'Second paragraph.', 'Tail {{expand}}'].join('\n');

  t.deepEqual(bracePromptContextRangesForPosition(text, text.length), [{ from: 0, to: text.length }]);
});

test('buildBracePromptRequest caps double-brace context to the shared reader ai selection limit', (t) => {
  const longBody = Array.from({ length: 900 }, () => 'abcdefghij').join('');
  const text = `# Heading\n${longBody}\nTail {{expand}}`;
  const position = text.length;
  const request = buildBracePromptRequest(text, position);

  t.truthy(request);
  t.is(request?.documentContent.length, READER_AI_SELECTION_MAX_CHARS);
  t.true(request?.documentContent.startsWith('# Heading\n') ?? false);
  t.true(request?.documentContent.endsWith('Tail {{expand}}') ?? false);
});

test('buildBracePromptRequest includes the rest of the paragraph when requested', (t) => {
  const text = 'Alpha {rewrite this} beta\nstill same paragraph\n\nNext paragraph';
  const position = 'Alpha {rewrite this}'.length;

  t.deepEqual(buildBracePromptRequest(text, position, { includeParagraphTail: true }), {
    prompt: 'rewrite this',
    from: 6,
    to: position,
    documentContent: text.slice(0, position),
    paragraphTail: ' beta\nstill same paragraph',
    mode: 'replace-with-paragraph-tail',
    candidateCount: 5,
    excludeOptions: [],
    chatMessages: [],
  });
});

test('isBracePromptBlockedInCode returns true for inline code and fenced code', (t) => {
  const inlineState = EditorState.create({
    doc: '`{query}`',
    extensions: [markdownEditorLanguageSupport()],
  });
  const fencedState = EditorState.create({
    doc: '```md\n{query}\n```',
    extensions: [markdownEditorLanguageSupport()],
  });

  t.true(isBracePromptBlockedInCode(inlineState, '`{query}`'.length - 1));
  t.true(isBracePromptBlockedInCode(fencedState, '```md\n{query}'.length));
});

test('lineRangeAt returns the whole text for a single line', (t) => {
  t.deepEqual(lineRangeAt('hello', 2), { from: 0, to: 5 });
});

test('lineRangeAt returns the correct range for the first line of multiline text', (t) => {
  t.deepEqual(lineRangeAt('abc\ndef\nghi', 1), { from: 0, to: 3 });
});

test('lineRangeAt returns the correct range for a middle line', (t) => {
  t.deepEqual(lineRangeAt('abc\ndef\nghi', 5), { from: 4, to: 7 });
});

test('lineRangeAt returns the correct range for the last line', (t) => {
  t.deepEqual(lineRangeAt('abc\ndef\nghi', 9), { from: 8, to: 11 });
});

test('lineRangeAt handles position at a newline character', (t) => {
  t.deepEqual(lineRangeAt('abc\ndef', 3), { from: 0, to: 3 });
});

test('lineRangeAt handles position 0', (t) => {
  t.deepEqual(lineRangeAt('abc\ndef', 0), { from: 0, to: 3 });
});

test('lineRangeAt handles empty string', (t) => {
  t.deepEqual(lineRangeAt('', 0), { from: 0, to: 0 });
});

test('lineRangeAt handles trailing newline', (t) => {
  t.deepEqual(lineRangeAt('abc\n', 4), { from: 4, to: 4 });
});

test('lineRangeAt handles position at end of text', (t) => {
  t.deepEqual(lineRangeAt('abc', 3), { from: 0, to: 3 });
});
