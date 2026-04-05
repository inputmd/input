import test from 'ava';
import { normalizeLlmOutputText } from '../../shared/llm_text_normalization.ts';

test('normalizeLlmOutputText replaces narrow no-break spaces with normal spaces', (t) => {
  t.is(normalizeLlmOutputText('A\u202fB'), 'A B');
  t.is(normalizeLlmOutputText('\u202fleading and trailing\u202f'), ' leading and trailing ');
});

test('normalizeLlmOutputText leaves ordinary text unchanged', (t) => {
  t.is(normalizeLlmOutputText('plain text'), 'plain text');
});
