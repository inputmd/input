import test from 'ava';
import { matchPromptListLine } from '../../src/prompt_list_syntax.ts';

test('matchPromptListLine parses prompt question markers', (t) => {
  t.deepEqual(matchPromptListLine('-* Can you explain Solomonoff induction?'), {
    indent: '',
    marker: '*',
    kind: 'question',
    content: 'Can you explain Solomonoff induction?',
    markerEnd: 3,
  });
});

test('matchPromptListLine parses prompt answer markers', (t) => {
  t.deepEqual(matchPromptListLine('-⏺ Solomonoff induction is a theoretical framework.'), {
    indent: '',
    marker: '⏺',
    kind: 'answer',
    content: 'Solomonoff induction is a theoretical framework.',
    markerEnd: 3,
  });
});

test('matchPromptListLine parses nested answer markers', (t) => {
  t.deepEqual(matchPromptListLine('    -⏺ Nested answer'), {
    indent: '    ',
    marker: '⏺',
    kind: 'answer',
    content: 'Nested answer',
    markerEnd: 7,
  });
});

test('matchPromptListLine ignores ordinary markdown bullets', (t) => {
  t.is(matchPromptListLine('- regular bullet'), null);
});
