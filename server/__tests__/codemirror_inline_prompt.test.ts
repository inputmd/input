import test from 'ava';
import { findInlinePromptMatch } from '../../src/components/codemirror_inline_prompt.ts';

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
