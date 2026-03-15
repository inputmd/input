import test from 'ava';
import { marked } from 'marked';
import '../../src/markdown.ts';

test('marked renders superscript links for caret-prefixed link labels', (t) => {
  const html = marked.parse('See [^docs](https://example.com) for details.');

  t.true(typeof html === 'string');
  t.true(html.includes('<sup class="superscript-link"><a href="https://example.com">docs</a></sup>'));
});

test('marked leaves regular footnote references unchanged', (t) => {
  const html = marked.parse('See [^note] for details.');

  t.true(typeof html === 'string');
  t.true(html.includes('[^note]'));
});
