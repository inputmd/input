import test from 'ava';
import { parseCriticMarkupAt } from '../../src/criticmarkup.ts';

test('parseCriticMarkupAt parses the supported CriticMarkup forms', (t) => {
  t.like(parseCriticMarkupAt('{++new++}', 0), { kind: 'addition', text: 'new' });
  t.like(parseCriticMarkupAt('{--old--}', 0), { kind: 'deletion', text: 'old' });
  t.like(parseCriticMarkupAt('{==focus==}', 0), { kind: 'highlight', text: 'focus' });
  t.like(parseCriticMarkupAt('{>>note<<}', 0), { kind: 'comment', text: 'note' });
  t.like(parseCriticMarkupAt('{~~before~>after~~}', 0), {
    kind: 'substitution',
    oldText: 'before',
    newText: 'after',
  });
});

test('parseCriticMarkupAt trims comment padding inside delimiters', (t) => {
  t.like(parseCriticMarkupAt('{>> remark <<}', 0), { kind: 'comment', text: 'remark' });
});

test('parseCriticMarkupAt returns null for malformed CriticMarkup', (t) => {
  t.is(parseCriticMarkupAt('{++new}', 0), null);
  t.is(parseCriticMarkupAt('{~~before~~}', 0), null);
  t.is(parseCriticMarkupAt('{>>note}', 0), null);
});
