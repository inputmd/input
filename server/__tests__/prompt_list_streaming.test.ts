import test from 'ava';
import { splitPromptListStableText } from '../../src/prompt_list_streaming.ts';

test('splitPromptListStableText keeps all text when it ends at a stable boundary', (t) => {
  t.deepEqual(splitPromptListStableText('Sure! '), { stable: 'Sure! ', remainder: '' });
  t.deepEqual(splitPromptListStableText('Sure!'), { stable: 'Sure!', remainder: '' });
});

test('splitPromptListStableText withholds the trailing token when no stable boundary is present', (t) => {
  t.deepEqual(splitPromptListStableText('I am a large language model'), {
    stable: 'I am a large language ',
    remainder: 'model',
  });
});

test('splitPromptListStableText keeps a single token buffered until more text arrives', (t) => {
  t.deepEqual(splitPromptListStableText('Nemotron'), { stable: '', remainder: 'Nemotron' });
});
