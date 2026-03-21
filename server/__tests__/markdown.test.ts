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

test('marked renders CriticMarkup additions, deletions, highlights, comments, and substitutions', (t) => {
  const html = marked.parse('A {++new++} {--old--} {==focus==} {>>note<<} {~~before~>after~~} change.');

  t.true(typeof html === 'string');
  t.true(html.includes('<ins class="critic-addition">new</ins>'));
  t.true(html.includes('<del class="critic-deletion">old</del>'));
  t.true(html.includes('<mark class="critic-highlight">focus</mark>'));
  t.true(html.includes('<span class="critic-comment">note</span>'));
  t.true(
    html.includes(
      '<span class="critic-substitution"><del class="critic-deletion">before</del><ins class="critic-addition">after</ins></span>',
    ),
  );
});

test('marked leaves malformed CriticMarkup literal', (t) => {
  const html = marked.parse('Keep {--this literal.');

  t.true(typeof html === 'string');
  t.true(html.includes('Keep {--this literal.'));
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

test('marked renders prompt question and answer lines as list items inside a single unordered list', (t) => {
  const html = marked.parse(
    '-* Can you explain Solomonoff induction?\n-⏺ Solomonoff induction is a theoretical framework.',
  );

  t.true(typeof html === 'string');
  t.true(
    html.includes(
      '<ul class="prompt-list"><li class="prompt-question">Can you explain Solomonoff induction?</li><li class="prompt-answer">Solomonoff induction is a theoretical framework.</li></ul>',
    ),
  );
});

test('parseMarkdownToHtml keeps prompt list inline markdown inside custom prompt list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('-* Ask about **Solomonoff induction**'));

  t.true(
    html.includes(
      '<ul class="prompt-list"><li class="prompt-question">Ask about <strong>Solomonoff induction</strong></li></ul>',
    ),
  );
});

test('parseMarkdownToHtml keeps multiline prompt answer content inside the prompt-answer list item', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(
      ['-* Question', '-⏺ First paragraph', '  ', '  Second paragraph', '  - Nested item'].join('\n'),
    ),
  );

  t.true(html.includes('<li class="prompt-answer"><p>First paragraph</p>'));
  t.true(html.includes('<p>Second paragraph</p>'));
  t.true(html.includes('<ul>'));
  t.true(html.includes('<li>Nested item</li>'));
  t.true(html.includes('</ul> </li></ul>'));
});

test('parseMarkdownToHtml keeps a prompt list unified across a single blank line between items', (t) => {
  const html = withDom(() => parseMarkdownToHtml(['-* one', '-⏺ answer', '  ', '-* two', '-⏺ next'].join('\n')));

  t.is((html.match(/<ul class="prompt-list">/g) ?? []).length, 1);
  t.true(
    html.includes(
      '<ul class="prompt-list"><li class="prompt-question">one</li><li class="prompt-answer">answer</li><li class="prompt-question">two</li><li class="prompt-answer">next</li></ul>',
    ),
  );
});

test('parseMarkdownToHtml splits prompt lists across two blank lines between items', (t) => {
  const html = withDom(() => parseMarkdownToHtml(['-* one', '-⏺ answer', '  ', '  ', '-* two', '-⏺ next'].join('\n')));

  t.is((html.match(/<ul class="prompt-list">/g) ?? []).length, 2);
});

test('parseMarkdownToHtml does not preserve an extra leading space on resumed prompt-answer paragraphs', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(
      [
        '-* What symbols are used as prompts by different shells?',
        "-⏺ Different shells use various symbols as prompts to indicate the user's current context.",
        '   ',
        '   - $ for regular users',
        '   - # for root users',
        '   ',
        "   It's worth noting that prompts are customizable.",
      ].join('\n'),
    ),
  );

  t.true(html.includes("<p>It's worth noting that prompts are customizable.</p>"));
  t.false(html.includes('<span class="leading-indent"> </span>It'));
});

test('parseMarkdownToHtml preserves leading indentation in paragraphs', (t) => {
  const html = withDom(() => parseMarkdownToHtml('    one'));

  t.true(html.includes('<p class="leading-indent-block" style="--leading-indent-columns: 4;">one</p>'));
  t.false(html.includes('leading-indent">    </span>one'));
});

test('parseMarkdownToHtml preserves leading indentation after wrapped lines in list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('- item\n    continuation'));

  t.true(html.includes('item<span class="leading-indent">  </span>continuation'));
  t.false(html.includes('<br>'));
});

test('parseMarkdownToHtml does not preserve repeated inline spaces as indentation', (t) => {
  const html = withDom(() => parseMarkdownToHtml('keep  inline spaces'));

  t.false(html.includes('leading-indent'));
  t.true(html.includes('keep  inline spaces'));
});

test('parseMarkdownToHtml collapses soft line breaks inside paragraphs', (t) => {
  const html = withDom(() => parseMarkdownToHtml('foo\nbar'));

  t.true(html.includes('<p>foo bar</p>'));
  t.false(html.includes('<br>'));
});

test('parseMarkdownToHtml keeps fenced code blocks unchanged while preserving prose indentation', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```\n    code\n```'));

  t.true(html.includes('<pre><code>    code\n</code></pre>'));
  t.false(html.includes('leading-indent'));
});

test('parseMarkdownToHtml renders CriticMarkup inside prompt list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('-* Review {++this++}\n-⏺ Keep {--that--}'));

  t.true(html.includes('<li class="prompt-question">Review <ins class="critic-addition">this</ins></li>'));
  t.true(html.includes('<li class="prompt-answer">Keep <del class="critic-deletion">that</del></li>'));
});

test('parseMarkdownToHtml renders CriticMarkup inside footnote definitions', (t) => {
  const html = withDom(() => parseMarkdownToHtml('See [^edit].\n\n[^edit]: add {++this++}'));

  t.true(html.includes('<section class="footnotes"'));
  t.true(html.includes('<ins class="critic-addition">this</ins>'));
});

test('parseMarkdownToHtml does not parse CriticMarkup inside fenced code blocks', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```md\n{++literal++}\n```'));

  t.regex(html, /<pre><code(?: class="language-md")?>\{\+\+literal\+\+\}\n<\/code><\/pre>/);
  t.false(html.includes('critic-addition'));
});

test('parseMarkdownToHtml does not preserve extra leading indentation on standalone CriticMarkup comments in list paragraphs', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(
      ['- item', '  first paragraph', '  ', '    {>>critic<<}', '  ', '  second paragraph'].join('\n'),
    ),
  );

  t.true(html.includes('<p><span class="critic-comment">critic</span></p>'));
  t.false(html.includes('leading-indent'));
});

test('parseMarkdownToHtml trims padding inside standalone CriticMarkup comments in prompt answers', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(
      [
        '-* Question',
        '-⏺ Here is a short reply.',
        '',
        '   More detail here.',
        '',
        '   {>> note <<}',
        '',
        '   {>> this should be revised later <<}',
      ].join('\n'),
    ),
  );

  t.true(html.includes('<p><span class="critic-comment">note</span></p>'));
  t.true(html.includes('<p><span class="critic-comment">this should be revised later</span></p>'));
  t.false(html.includes('<span class="leading-indent"> </span>note'));
  t.false(html.includes('later </span>'));
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

test('parseMarkdownDocument loads google fonts from front matter shorthand', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
fonts: [Libre Franklin, Montserrat]
---
# Hello`,
    ),
  );

  t.true(document.html.includes('<h1 id="hello">Hello</h1>'));
  t.truthy(document.customCss);
  t.is(document.customCssScope, null);
  t.true(
    document.customCss?.includes(
      '@import url("https://fonts.googleapis.com/css2?family=Libre+Franklin&family=Montserrat&display=swap");',
    ),
  );
  t.is(document.cssWarning, null);
});

test('parseMarkdownDocument generates body and heading font rules from front matter', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
fonts:
  body: Libre Franklin
  headings: Montserrat
---
# Hello

Paragraph`,
    ),
  );

  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.true(
    document.customCss?.includes(
      '@import url("https://fonts.googleapis.com/css2?family=Libre+Franklin&family=Montserrat&display=swap");',
    ),
  );
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] p, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] ul, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] ol, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] blockquote, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] table, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] li, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] td, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] th, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] div, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] section, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] span { font-family: "Libre Franklin", var(--font-sans), sans-serif; }`,
    ),
  );
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h1, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h2, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h3, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h4, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h5, .rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] h6 { font-family: "Montserrat", var(--font-sans), sans-serif; }`,
    ),
  );
});

test('parseMarkdownDocument infers fonts load entries from structured body and headings', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
fonts:
  body: Libre Franklin
  headings: Montserrat
css: |
  p { color: #123456; }
---
hello`,
    ),
  );

  t.truthy(document.customCss);
  t.true(
    document.customCss?.includes(
      '@import url("https://fonts.googleapis.com/css2?family=Libre+Franklin&family=Montserrat&display=swap");',
    ),
  );
  t.true(document.customCss?.includes('font-family: "Libre Franklin", var(--font-sans), sans-serif;'));
  t.true(document.customCss?.includes('p { color: #123456; }'));
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

test('parseMarkdownDocument allows arbitrary class selectors inside scoped custom css', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  .prompt-answer { font-family: "Noto Serif", var(--font-sans), sans-serif; }
  li.prompt-answer:hover { color: #123456; }
---
-* Question
- Answer`,
    ),
  );

  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] .prompt-answer { font-family: "Noto Serif", var(--font-sans), sans-serif; }`,
    ),
  );
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] li.prompt-answer:hover { color: #123456; }`,
    ),
  );
  t.is(document.cssWarning, null);
});

test('parseMarkdownDocument allows opacity in scoped custom css', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  .prompt-answer { opacity: 0.65; }
---
-* Question
- Answer`,
    ),
  );

  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] .prompt-answer { opacity: 0.65; }`,
    ),
  );
  t.is(document.cssWarning, null);
});

test('parseMarkdownDocument allows additional low-risk layout and typography properties', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  .prompt-answer {
    display: inline-block;
    font-variant: small-caps;
    font-stretch: condensed;
    white-space: pre-wrap;
    max-width: 90%;
    width: 18rem;
    height: 3rem;
    vertical-align: middle;
    word-break: break-word;
    hyphens: auto;
    column-count: 2;
    column-gap: 1.5rem;
  }
---
-* Question
- Answer`,
    ),
  );

  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.true(
    document.customCss?.includes(
      `.rendered-markdown[data-markdown-custom-css="${document.customCssScope}"] .prompt-answer { display: inline-block; font-variant: small-caps; font-stretch: condensed; white-space: pre-wrap; max-width: 90%; width: 18rem; height: 3rem; vertical-align: middle; word-break: break-word; hyphens: auto; column-count: 2; column-gap: 1.5rem; }`,
    ),
  );
  t.is(document.cssWarning, null);
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

test('parseMarkdownDocument reports malformed font front matter as parse errors', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
fonts:
  load:
    Libre Franklin
---
hello`,
    ),
  );

  t.is(document.frontMatterError, 'Could not parse front matter');
  t.is(document.customCss, null);
  t.is(document.customCssScope, null);
});
