import test from 'ava';
import { findBracePromptMatch, findInlinePromptMatch } from '../../src/components/codemirror_inline_prompt.ts';

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

test('findBracePromptMatch ignores doubled braces', (t) => {
  t.is(findBracePromptMatch('{{multiply wrapped braces}}', '{{multiply wrapped braces}}'.length), null);
});
