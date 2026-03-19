import test from 'ava';
import { formatPromptListAnswer } from '../../src/prompt_list_format.ts';

test('formatPromptListAnswer preserves unordered list continuation lines', (t) => {
  const formatted = formatPromptListAnswer('Intro\n- first\n* second', '');

  t.is(formatted, 'Intro\n   - first\n   * second');
});

test('formatPromptListAnswer still escapes ordered list continuation lines', (t) => {
  const formatted = formatPromptListAnswer('Intro\n1. first\n2) second', '');

  t.is(formatted, 'Intro\n   1\\. first\n   2\\) second');
});

test('formatPromptListAnswer still escapes headings and fences but preserves blockquotes', (t) => {
  const formatted = formatPromptListAnswer('Intro\n# heading\n> quote\n```ts', '');

  t.is(formatted, 'Intro\n   \\# heading\n   > quote\n   \\```ts');
});
