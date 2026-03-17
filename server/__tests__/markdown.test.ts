import test from 'ava';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { parseMarkdownDocument, parseMarkdownToHtml } from '../../src/markdown.ts';

function withDom<T>(callback: () => T): T {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    HTMLElement: globalThis.HTMLElement,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    HTMLImageElement: globalThis.HTMLImageElement,
    SVGElement: globalThis.SVGElement,
    Text: globalThis.Text,
    DocumentFragment: globalThis.DocumentFragment,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    HTMLElement: dom.window.HTMLElement,
    HTMLAnchorElement: dom.window.HTMLAnchorElement,
    HTMLImageElement: dom.window.HTMLImageElement,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
    DocumentFragment: dom.window.DocumentFragment,
  });

  try {
    return callback();
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

test('marked renders superscript links for caret-prefixed link labels', (t) => {
  const html = marked.parse('See [^docs](https://example.com) for details.');

  t.true(typeof html === 'string');
  t.true(html.includes('<sup class="superscript-link"><a href="https://example.com">docs</a></sup>'));
});

test('marked renders emoji shortcodes as unicode emoji', (t) => {
  const html = marked.parse('Status: :white_check_mark:');

  t.true(typeof html === 'string');
  t.true(html.includes('<span class="emoji-shortcode" role="img" aria-label="white_check_mark emoji">✅</span>'));
});

test('marked leaves unknown emoji shortcodes unchanged', (t) => {
  const html = marked.parse('Status: :not_a_real_emoji:');

  t.true(typeof html === 'string');
  t.true(html.includes(':not_a_real_emoji:'));
});

test('marked renders caret-wrapped superscript text', (t) => {
  const html = marked.parse('Water is H^2^O.');

  t.true(typeof html === 'string');
  t.true(html.includes('H<sup>2</sup>O.'));
});

test('marked leaves unmatched carets unchanged', (t) => {
  const html = marked.parse('Keep ^this literal.');

  t.true(typeof html === 'string');
  t.true(html.includes('Keep ^this literal.'));
});

test('marked renders github avatar inline tokens', (t) => {
  const html = marked.parse('See {github:@raykyri} for details.');

  t.true(typeof html === 'string');
  t.true(
    html.includes(
      '<a class="github-inline-avatar" href="https://github.com/raykyri" aria-label="@raykyri on GitHub"><img src="https://github.com/raykyri.png?size=32" alt="@raykyri" loading="lazy" decoding="async"></a>',
    ),
  );
});

test('marked renders ^src X profile links using the handle in the superscript', (t) => {
  const html = marked.parse('See [^src](https://x.com/foobar) for details.');

  t.true(typeof html === 'string');
  t.true(html.includes('<sup class="superscript-link"><a href="https://x.com/foobar">foobar</a></sup>'));
});

test('marked renders ^src X tweet links using the author handle in the superscript', (t) => {
  const html = marked.parse('See [^src](https://twitter.com/foobar/status/123) for details.');

  t.true(typeof html === 'string');
  t.true(
    html.includes('<sup class="superscript-link"><a href="https://twitter.com/foobar/status/123">foobar</a></sup>'),
  );
});

test('marked renders ^src non-X links using the domain in the superscript', (t) => {
  const html = marked.parse('See [^src](https://example.com/path) for details.');

  t.true(typeof html === 'string');
  t.true(html.includes('<sup class="superscript-link"><a href="https://example.com/path">example.com</a></sup>'));
});

test('marked strips www from ^src non-X domain labels', (t) => {
  const html = marked.parse('See [^src](https://www.docs.example.com/page) for details.');

  t.true(typeof html === 'string');
  t.true(
    html.includes(
      '<sup class="superscript-link"><a href="https://www.docs.example.com/page">docs.example.com</a></sup>',
    ),
  );
});

test('marked keeps ^src labels unchanged for excluded X intent paths', (t) => {
  const html = marked.parse('See [^src](https://x.com/i/bookmarks) for details.');

  t.true(typeof html === 'string');
  t.true(html.includes('<sup class="superscript-link"><a href="https://x.com/i/bookmarks">src</a></sup>'));
});

test('marked leaves regular footnote references unchanged', (t) => {
  const html = marked.parse('See [^note] for details.');

  t.true(typeof html === 'string');
  t.true(html.includes('[^note]'));
});

test('marked renders bare bracketed text without brackets', (t) => {
  const html = marked.parse('Use [draft] status.');

  t.true(html.includes('Use <span class="bracketed-text">draft</span> status.'));
  t.false(html.includes('[draft]'));
});

test('marked preserves markdown links while styling bare bracketed text', (t) => {
  const html = marked.parse('Use [draft] status and [docs](https://example.com).');

  t.true(html.includes('<span class="bracketed-text">draft</span>'));
  t.true(html.includes('<a href="https://example.com">docs</a>'));
});

test('parseMarkdownToHtml preserves leading indentation in paragraphs', (t) => {
  const html = withDom(() => parseMarkdownToHtml('    one'));

  t.true(html.includes('<p class="leading-indent-block" style="--leading-indent-columns: 4;">one</p>'));
  t.false(html.includes('leading-indent">    </span>one'));
});

test('parseMarkdownToHtml preserves leading indentation after soft breaks in list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('- item\n    continuation'));

  t.true(html.includes('item<br><span class="leading-indent">  </span>continuation'));
});

test('parseMarkdownToHtml does not preserve repeated inline spaces as indentation', (t) => {
  const html = withDom(() => parseMarkdownToHtml('keep  inline spaces'));

  t.false(html.includes('leading-indent'));
  t.true(html.includes('keep  inline spaces'));
});

test('parseMarkdownToHtml keeps fenced code blocks unchanged while preserving prose indentation', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```\n    code\n```'));

  t.true(html.includes('<pre><code>    code\n</code></pre>'));
  t.false(html.includes('leading-indent'));
});

test('parseMarkdownDocument extracts and scopes allowed custom css from front matter', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap");
  h1, p { color: #123456; font-family: "IBM Plex Sans", var(--reader-font-family), sans-serif; }
---
# Hello`,
    ),
  );

  t.true(document.html.includes('<h1 id="hello">Hello</h1>'));
  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.true(
    document.customCss?.includes(
      '@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap");',
    ),
  );
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h1, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] p`,
    ),
  );
});

test('parseMarkdownDocument drops custom css that uses disallowed imports', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  @import url("https://example.com/evil.css");
  p { color: red; }
---
hello`,
    ),
  );

  t.is(document.customCss, null);
  t.is(document.customCssScope, null);
  t.true(document.html.includes('<p>hello</p>'));
});

test('parseMarkdownDocument drops only invalid custom css rules', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  h1 {}
  p { position: fixed; color: red; }
  h2 { color: #123456; }
---
hello`,
    ),
  );

  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.is(document.cssWarning, 'Some custom CSS rules were ignored');
  t.true(document.customCss?.includes('position: fixed'));
  t.false(document.customCss?.includes('h1'));
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] p { position: fixed; color: red; }`,
    ),
  );
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h2 { color: #123456; }`,
    ),
  );
});

test('parseMarkdownDocument rewrites :light and :dark custom css selectors to theme-scoped rules', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  :light h1 { color: #123456; }
  :dark p { color: #abcdef; }
---
# Hello

Text`,
    ),
  );

  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.true(
    document.customCss?.includes(
      `[data-theme="light"] .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h1 { color: #123456; }`,
    ),
  );
  t.true(
    document.customCss?.includes(
      `[data-theme="dark"] .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] p { color: #abcdef; }`,
    ),
  );
  t.is(document.cssWarning, null);
});

test('parseMarkdownDocument reports malformed front matter bodies as parse errors', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  h1 { color: red; }
broken
---
hello`,
    ),
  );

  t.is(document.frontMatterError, 'Could not parse front matter');
  t.is(document.customCss, null);
  t.is(document.customCssScope, null);
});
