import test from 'ava';
import { matchPromptListLine, parsePromptListBlock } from '../../src/prompt_list_syntax.ts';

test('matchPromptListLine parses prompt question markers', (t) => {
  t.deepEqual(matchPromptListLine('~ Can you explain Solomonoff induction?'), {
    indent: '',
    marker: '~',
    kind: 'question',
    content: 'Can you explain Solomonoff induction?',
    markerEnd: 2,
  });
});

test('matchPromptListLine parses chevron-prefixed prompt question markers', (t) => {
  t.deepEqual(matchPromptListLine('❯ Continue the conversation'), {
    indent: '',
    marker: '❯',
    kind: 'question',
    content: 'Continue the conversation',
    markerEnd: 2,
  });
});

test('matchPromptListLine parses star-prefixed prompt comment markers', (t) => {
  t.deepEqual(matchPromptListLine('✻ Internal note'), {
    indent: '',
    marker: '✻',
    kind: 'comment',
    content: 'Internal note',
    markerEnd: 2,
  });
});

test('matchPromptListLine parses percent-prefixed prompt comment markers', (t) => {
  t.deepEqual(matchPromptListLine('% Internal note'), {
    indent: '',
    marker: '%',
    kind: 'comment',
    content: 'Internal note',
    markerEnd: 2,
  });
});

test('matchPromptListLine parses prompt answer markers', (t) => {
  t.deepEqual(matchPromptListLine('⏺ Solomonoff induction is a theoretical framework.'), {
    indent: '',
    marker: '⏺',
    kind: 'answer',
    content: 'Solomonoff induction is a theoretical framework.',
    markerEnd: 2,
  });
});

test('matchPromptListLine parses nested answer markers', (t) => {
  t.deepEqual(matchPromptListLine('    ⏺ Nested answer'), {
    indent: '    ',
    marker: '⏺',
    kind: 'answer',
    content: 'Nested answer',
    markerEnd: 6,
  });
});

test('matchPromptListLine ignores ordinary markdown bullets', (t) => {
  t.is(matchPromptListLine('- regular bullet'), null);
});

test('parsePromptListBlock keeps a single blank line between prompt-list items in one block', (t) => {
  const block = parsePromptListBlock(['~ one', '⏺ answer', '  ', '~ two', '⏺ next'], 0);

  t.truthy(block);
  t.is(block?.items.length, 4);
  t.is(block?.endLineIndexExclusive, 5);
  t.deepEqual(
    block?.items.map((item) => ({ kind: item.match.kind, content: item.content })),
    [
      { kind: 'question', content: 'one' },
      { kind: 'answer', content: 'answer' },
      { kind: 'question', content: 'two' },
      { kind: 'answer', content: 'next' },
    ],
  );
});

test('parsePromptListBlock treats two blank lines before the next prompt item as a separator', (t) => {
  const block = parsePromptListBlock(['~ one', '⏺ answer', '  ', '  ', '~ two', '⏺ next'], 0);

  t.truthy(block);
  t.is(block?.items.length, 2);
  t.is(block?.endLineIndexExclusive, 2);
});

test('parsePromptListBlock lets chevron-prefixed questions continue with a single-space indent', (t) => {
  const block = parsePromptListBlock(['❯ one', ' continued', '⏺ answer'], 0);

  t.truthy(block);
  t.deepEqual(
    block?.items.map((item) => ({ kind: item.match.kind, content: item.content })),
    [
      { kind: 'question', content: 'one\ncontinued' },
      { kind: 'answer', content: 'answer' },
    ],
  );
});

test('parsePromptListBlock lets chevron-prefixed questions continue across contiguous unindented text lines', (t) => {
  const block = parsePromptListBlock(['❯ one', 'continued', ' more', '⏺ answer'], 0);

  t.truthy(block);
  t.deepEqual(
    block?.items.map((item) => ({ kind: item.match.kind, content: item.content })),
    [
      { kind: 'question', content: 'one\ncontinued\nmore' },
      { kind: 'answer', content: 'answer' },
    ],
  );
});

test('parsePromptListBlock keeps tilde-prefixed questions on the two-space continuation rule', (t) => {
  const block = parsePromptListBlock(['~ one', ' continued', '⏺ answer'], 0);

  t.truthy(block);
  t.deepEqual(
    block?.items.map((item) => ({ kind: item.match.kind, content: item.content })),
    [{ kind: 'question', content: 'one' }],
  );
  t.is(block?.endLineIndexExclusive, 1);
});

test('parsePromptListBlock resumes chevron-prefixed questions after a blank line with a two-space indent', (t) => {
  const block = parsePromptListBlock(['❯ one', '', '  continued', '⏺ answer'], 0);

  t.truthy(block);
  t.deepEqual(
    block?.items.map((item) => ({ kind: item.match.kind, content: item.content })),
    [
      { kind: 'question', content: 'one\n\ncontinued' },
      { kind: 'answer', content: 'answer' },
    ],
  );
});

test('parsePromptListBlock does not resume chevron-prefixed questions after a blank line with unindented text', (t) => {
  const block = parsePromptListBlock(['❯ one', '', 'continued', '⏺ answer'], 0);

  t.truthy(block);
  t.deepEqual(
    block?.items.map((item) => ({ kind: item.match.kind, content: item.content })),
    [{ kind: 'question', content: 'one' }],
  );
  t.is(block?.endLineIndexExclusive, 1);
});
