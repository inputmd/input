import test from 'ava';
import { formatPromptListAnswer } from '../../src/prompt_list_format.ts';

test('formatPromptListAnswer preserves unordered list continuation lines', (t) => {
  const formatted = formatPromptListAnswer('Intro\n- first\n* second', '');

  t.is(formatted, 'Intro\n  - first\n  * second');
});

test('formatPromptListAnswer preserves ordered list continuation lines', (t) => {
  const formatted = formatPromptListAnswer('Intro\n1. first\n2) second', '');

  t.is(formatted, 'Intro\n  1. first\n  2) second');
});

test('formatPromptListAnswer still escapes headings and fences but preserves blockquotes', (t) => {
  const formatted = formatPromptListAnswer('Intro\n# heading\n> quote\n```ts', '');

  t.is(formatted, 'Intro\n  \\# heading\n  > quote\n  \\```ts');
});

test('formatPromptListAnswer keeps later paragraphs aligned with the first paragraph', (t) => {
  const formatted = formatPromptListAnswer('First paragraph.\n\nSecond paragraph.', '');

  t.is(formatted, 'First paragraph.\n  \n  Second paragraph.');
});
