import { readFileSync } from 'node:fs';
import test from 'ava';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { BRACE_PROMPT_HINT_LABEL } from '../../src/brace_prompt.ts';
import { parseMarkdownDocument, parseMarkdownToHtml } from '../../src/markdown.ts';
import {
  capturePromptAnswerExpandedStates,
  capturePromptListCollapsedStates,
  restorePromptAnswerExpandedStates,
  restorePromptListCollapsedStates,
  setPromptAnswerExpandedState,
  setPromptListCollapsedState,
  syncPromptAnswerExpandedStateInUrl,
  togglePromptAnswerExpandedState,
} from '../../src/prompt_list_state.ts';
import { EMPTY_PROMPT_QUESTION_PLACEHOLDER } from '../../src/prompt_list_syntax.ts';
import { syncToggleListPersistedState, toggleToggleListState } from '../../src/toggle_list_state.ts';

function withDom<T>(callback: () => T): T {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://input.test/doc' });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    HTMLElement: globalThis.HTMLElement,
    HTMLDetailsElement: globalThis.HTMLDetailsElement,
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
    HTMLDetailsElement: dom.window.HTMLDetailsElement,
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

test('parseMarkdownToHtml auto-numbers inline citation links and reuses numbers for repeated urls', (t) => {
  const citations = withDom(() => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = parseMarkdownToHtml(
      'See [^](https://example.com/a), [^](https://example.com/b), and [^](https://example.com/a).',
    );
    return Array.from(wrapper.querySelectorAll('sup.superscript-link > a')).map((anchor) => ({
      text: anchor.textContent,
      href: anchor.getAttribute('href'),
      label: anchor.getAttribute('aria-label'),
    }));
  });

  t.deepEqual(citations, [
    { text: '1', href: 'https://example.com/a', label: 'Citation 1' },
    { text: '2', href: 'https://example.com/b', label: 'Citation 2' },
    { text: '1', href: 'https://example.com/a', label: 'Citation 1' },
  ]);
});

test('parseMarkdownToHtml auto-numbers keyed inline citation links', (t) => {
  const citations = withDom(() => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = parseMarkdownToHtml(
      'See [^#paper](https://example.com/paper) and [^#paper](https://example.com/paper).',
    );
    return Array.from(wrapper.querySelectorAll('sup.superscript-link > a')).map((anchor) => ({
      text: anchor.textContent,
      href: anchor.getAttribute('href'),
      label: anchor.getAttribute('aria-label'),
    }));
  });

  t.deepEqual(citations, [
    { text: '1', href: 'https://example.com/paper', label: 'Citation 1' },
    { text: '1', href: 'https://example.com/paper', label: 'Citation 1' },
  ]);
});

test('parseMarkdownToHtml renders # inline citations as TODO placeholders without consuming citation numbers', (t) => {
  const citations = withDom(() => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = parseMarkdownToHtml('See [^](#), [^](https://example.com/a), and [^](https://example.com/b).');
    return Array.from(wrapper.querySelectorAll('sup.superscript-link > a')).map((anchor) => ({
      text: anchor.textContent,
      href: anchor.getAttribute('href'),
      label: anchor.getAttribute('aria-label'),
    }));
  });

  t.deepEqual(citations, [
    { text: 'TODO', href: '#', label: null },
    { text: '1', href: 'https://example.com/a', label: 'Citation 1' },
    { text: '2', href: 'https://example.com/b', label: 'Citation 2' },
  ]);
});

test('parseMarkdownToHtml keeps manual superscript links unchanged', (t) => {
  const citations = withDom(() => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = parseMarkdownToHtml('See [^docs](https://example.com) for details.');
    return Array.from(wrapper.querySelectorAll('sup.superscript-link > a')).map((anchor) => anchor.textContent);
  });

  t.deepEqual(citations, ['docs']);
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

test('marked renders double-colon highlight markup', (t) => {
  const html = marked.parse('Use ::highlighted text:: here.');

  t.true(typeof html === 'string');
  t.true(html.includes('Use <mark class="double-colon-highlight">highlighted text</mark> here.'));
});

test('marked renders double-plus inline comments as italic comment spans', (t) => {
  const html = marked.parse('Use ++note to self++ here.');

  t.true(typeof html === 'string');
  t.true(html.includes('Use <span class="inline-comment">note to self</span> here.'));
});

test('marked trims padding inside double-plus inline comments', (t) => {
  const html = marked.parse('Use ++ note to self ++ here.');

  t.true(typeof html === 'string');
  t.true(html.includes('Use <span class="inline-comment">note to self</span> here.'));
  t.false(html.includes('> note to self <'));
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

test('marked renders bare brace prompts without braces', (t) => {
  const html = marked.parse('Use {draft a reply} here.');

  t.true(html.includes('Use <span class="brace-prompt">{draft a reply}</span> here.'));
});

test('marked keeps CriticMarkup comments distinct from bare brace prompts', (t) => {
  const html = marked.parse('Use {draft a reply} and {>>note<<}.');

  t.true(html.includes('<span class="brace-prompt">{draft a reply}</span>'));
  t.true(html.includes('<span class="critic-comment">note</span>'));
});

test('marked renders prompt question and answer lines as list items inside a single unordered list', (t) => {
  const html = marked.parse(
    '~ Can you explain Solomonoff induction?\n⏺ Solomonoff induction is a theoretical framework.',
  );

  t.true(typeof html === 'string');
  t.true(html.includes('class="prompt-list-conversation"'));
  t.true(html.includes('<ul class="prompt-list prompt-list-tree">'));
  t.true(html.includes('<li class="prompt-question">Can you explain Solomonoff induction?</li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>Solomonoff induction is a theoretical framework\.<\/li>/);
  t.true(html.includes('<li class="prompt-ask" hidden>'));
  t.true(html.includes('>Open editor to branch</button>'));
  t.true(html.includes('<li class="prompt-continue" hidden>'));
  t.true(html.includes('>Open editor to continue</button>'));
});

test('marked renders chevron-prefixed user messages as prompt questions', (t) => {
  const html = marked.parse('❯ Continue the conversation\n⏺ Here is the next answer.');

  t.true(typeof html === 'string');
  t.true(html.includes('<li class="prompt-question">Continue the conversation</li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>Here is the next answer\.<\/li>/);
});

test('marked renders comment-prefixed rows inside prompt lists', (t) => {
  const html = marked.parse('✻ Keep the answer concise\n~ Continue\n⏺ Sure.');

  t.true(typeof html === 'string');
  t.true(html.includes('<li class="prompt-comment">Keep the answer concise</li>'));
  t.true(html.includes('<li class="prompt-question">Continue</li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>Sure\.<\/li>/);
});

test('marked renders tool-call-shaped assistant messages as prompt comments with only the tool name', (t) => {
  const html = marked.parse(
    [
      '⏺ Fetch(https://www.example.com/2026/01/30/sample-essay-about-technology.html)',
      '  ⎿  Received 12.3KB (200 OK)',
    ].join('\n'),
  );

  t.true(typeof html === 'string');
  t.true(html.includes('<ul class="prompt-list prompt-list-tree"'));
  t.true(html.includes('<li class="prompt-comment">Fetch</li>'));
  t.false(html.includes('Received 12.3KB'));
});

test('marked renders placeholders for empty prompt question and answer rows', (t) => {
  const html = marked.parse('~ \n⏺ ');

  t.true(html.includes('<span class="prompt-list-placeholder">Continue here</span>'));
  t.true(html.includes('<li class="prompt-question"><span class="prompt-list-placeholder">Continue here</span></li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*><span class="prompt-list-placeholder">Continue here<\/span><\/li>/);
});

test('marked keeps liquid-style template tag lines out of prompt lists', (t) => {
  const html = marked.parse('{% TODO %}');

  t.true(typeof html === 'string');
  t.true(html.includes('<p>{% TODO %}</p>'));
  t.false(html.includes('prompt-list-conversation'));
});

test('marked does not treat tilde content inside markdown list items as prompt-list syntax', (t) => {
  const html = marked.parse('- ~ Enter to generate a first response, or to replace the existing response');

  t.true(typeof html === 'string');
  t.true(html.includes('<li>~ Enter to generate a first response, or to replace the existing response</li>'));
  t.false(html.includes('prompt-list'));
});

test('marked does not treat tilde content inside blockquotes as prompt-list syntax', (t) => {
  const html = marked.parse('> ~ Enter to generate a first response');

  t.true(typeof html === 'string');
  t.true(html.includes('<blockquote>'));
  t.true(html.includes('<p>~ Enter to generate a first response</p>'));
  t.false(html.includes('prompt-list'));
});

test('marked renders plus-prefixed list items as collapsed toggle lists', (t) => {
  const html = marked.parse('+ Parent\n  - Child');

  t.true(typeof html === 'string');
  t.true(html.includes('<li class="toggle-list-item"><details class="toggle-list" data-open="false">'));
  t.true(html.includes('<summary class="toggle-list-summary" aria-expanded="false">Parent</summary>'));
  t.true(html.includes('<div class="toggle-list-body"><ul>'));
  t.true(html.includes('<li>Child</li>'));
});

test('parseMarkdownToHtml keeps prompt list inline markdown inside custom prompt list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('~ Ask about **Solomonoff induction**'));

  t.regex(
    html,
    /<ul class="prompt-list prompt-list-tree"[^>]*><li class="prompt-question">Ask about <strong>Solomonoff induction<\/strong><\/li><\/ul>/,
  );
});

test('parseMarkdownToHtml does not render a conversation header for a single prompt-list message', (t) => {
  const html = withDom(() => parseMarkdownToHtml('~ Ask about **Solomonoff induction**'));

  t.false(html.includes('prompt-list-conversation'));
  t.false(html.includes('Conversation with 1 message'));
});

test('parseMarkdownToHtml renders prompt-list header metadata and collapse action labels', (t) => {
  const html = withDom(() => parseMarkdownToHtml('~ One\n⏺ Two'));

  t.true(html.includes('class="prompt-list-header"'));
  t.true(html.includes('data-prompt-list-mode="map"'));
  t.true(html.includes('data-prompt-list-mode="read"'));
  t.true(html.includes('Map Mode'));
  t.true(html.includes('Read Mode'));
});

test('parseMarkdownToHtml renders tool-call-shaped assistant messages as comment blocks', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(
      [
        '~ Review this article',
        '⏺ Fetch(https://zhengdongwang.com/2026/01/30/a-straussian-reading-of-the-adolesc',
        '  ence-of-technology.html)',
        '  ⎿  Received 12.3KB (200 OK)',
      ].join('\n'),
    ),
  );

  t.true(html.includes('<li class="prompt-question">Review this article</li>'));
  t.true(html.includes('<li class="prompt-comment">Fetch</li>'));
  t.false(html.includes('Received 12.3KB'));
});

test('parseMarkdownToHtml keeps liquid-style template tag lines out of prompt lists', (t) => {
  const html = withDom(() => parseMarkdownToHtml('{% TODO %}'));

  t.true(html.includes('<p>{% TODO %}</p>'));
  t.false(html.includes('prompt-list-conversation'));
});

test('parseMarkdownToHtml does not treat tilde content inside markdown list items as prompt-list syntax', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml('- ~ Enter to generate a first response, or to replace the existing response'),
  );

  t.true(html.includes('<li>~ Enter to generate a first response, or to replace the existing response</li>'));
  t.false(html.includes('prompt-list-conversation'));
});

test('parseMarkdownToHtml does not treat tilde content inside blockquotes as prompt-list syntax', (t) => {
  const html = withDom(() => parseMarkdownToHtml('> ~ Enter to generate a first response'));

  t.regex(html, /<blockquote(?:\s+data-sync-id="[^"]+")?>/);
  t.regex(html, /<p(?:\s+data-sync-id="[^"]+")?>~ Enter to generate a first response<\/p>/);
  t.false(html.includes('prompt-list-conversation'));
});

test('toggle lists restore their persisted open state from localStorage', (t) => {
  withDom(() => {
    const first = parseMarkdownDocument('+ Parent\n  - Child');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<div class="rendered-markdown" data-toggle-list-storage-key="doc-1">${first.html}</div>`;
    const root = wrapper.firstElementChild;
    t.true(root instanceof HTMLElement);
    if (!(root instanceof HTMLElement)) return;

    syncToggleListPersistedState(root);
    const details = root.querySelector('details.toggle-list');
    t.true(details instanceof HTMLDetailsElement);
    if (!(details instanceof HTMLDetailsElement)) return;
    t.false(details.open);

    toggleToggleListState(details);
    t.true(details.open);

    const second = parseMarkdownDocument('+ Parent\n  - Child');
    const nextWrapper = document.createElement('div');
    nextWrapper.innerHTML = `<div class="rendered-markdown" data-toggle-list-storage-key="doc-1">${second.html}</div>`;
    const nextRoot = nextWrapper.firstElementChild;
    t.true(nextRoot instanceof HTMLElement);
    if (!(nextRoot instanceof HTMLElement)) return;

    syncToggleListPersistedState(nextRoot);
    const nextDetails = nextRoot.querySelector('details.toggle-list');
    t.true(nextDetails instanceof HTMLDetailsElement);
    if (!(nextDetails instanceof HTMLDetailsElement)) return;
    t.true(nextDetails.open);
  });
});

test('prompt-list styles do not strip ordinary nested markdown lists inside prompt answers', (t) => {
  const css = readFileSync(new URL('../../src/styles/markdown.css', import.meta.url), 'utf8');

  t.false(css.includes('.rendered-markdown ul.prompt-list ul {'));
  t.true(css.includes('.rendered-markdown li.prompt-list-branch > ul {'));
});

test('prompt-list styles preserve spacing after the first visible paragraph in question and answer items', (t) => {
  const css = readFileSync(new URL('../../src/styles/markdown.css', import.meta.url), 'utf8');

  t.true(
    css.includes('.rendered-markdown :is(li.prompt-question, li.prompt-answer) > p:first-child:not(:last-child) {'),
  );
  t.true(css.includes('margin-bottom: 0.65em;'));
});

test('parseMarkdownToHtml unwraps stripped mailto autolinks into plain text', (t) => {
  const html = withDom(() => parseMarkdownToHtml('Email test@example.com for details.'));

  t.regex(html, /<p(?:\s+data-sync-id="[^"]+")?>Email test@example\.com for details\.<\/p>/);
  t.false(html.includes('<a'));
  t.false(html.includes('mailto:'));
});

test('parseMarkdownToHtml marks rendered URL labels for aggressive wrapping', (t) => {
  withDom(() => {
    const html = parseMarkdownToHtml(
      [
        'From https://example.com',
        '',
        '[https://example.com/deep/path](https://example.com/deep/path)',
        '',
        '[docs](https://example.com/deep/path)',
      ].join('\n'),
    );
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const anchors = wrapper.querySelectorAll('a');

    t.is(anchors.length, 3);
    t.true(anchors[0]?.classList.contains('url-display-link') ?? false);
    t.true(anchors[1]?.classList.contains('url-display-link') ?? false);
    t.false(anchors[2]?.classList.contains('url-display-link') ?? true);
  });
});

test('parseMarkdownToHtml keeps multiline prompt answer content inside the prompt-answer list item', (t) => {
  withDom(() => {
    const thirdParagraphWords = Array.from({ length: 35 }, (_, index) => `word${index + 1}`);
    const html = parseMarkdownToHtml(
      [
        '~ Question',
        '⏺ First paragraph stays visible here.',
        '  ',
        '  Second paragraph also stays visible.',
        '  ',
        `  ${thirdParagraphWords.join(' ')}`,
      ].join('\n'),
    );
    const template = document.createElement('template');
    template.innerHTML = html;

    const answer = template.content.querySelector('li.prompt-answer');
    const excerptParagraphs = Array.from(answer?.children ?? []).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'P',
    );

    t.truthy(answer);
    t.is(answer?.getAttribute('data-expanded'), 'false');
    t.is(excerptParagraphs.length, 3);
    t.is(excerptParagraphs[0]?.textContent?.trim(), 'First paragraph stays visible here.');
    t.is(excerptParagraphs[1]?.textContent?.trim(), 'Second paragraph also stays visible.');
    t.is(excerptParagraphs[2]?.textContent?.trim(), thirdParagraphWords.join(' '));
    t.falsy(answer?.querySelector('.prompt-answer-preview'));
    t.falsy(answer?.querySelector('.prompt-answer-inline-rest'));
    t.falsy(answer?.querySelector('.prompt-answer-toggle'));
    t.falsy(answer?.querySelector('.prompt-answer-rest'));
  });
});

test('parseMarkdownToHtml breaks after a long first paragraph instead of splitting it mid-paragraph', (t) => {
  withDom(() => {
    const firstParagraphWords = Array.from({ length: 21 }, (_, index) => `word${index + 1}`);
    const html = parseMarkdownToHtml(
      ['~ Question', `⏺ ${firstParagraphWords.join(' ')}`, '  ', '  Second paragraph starts hidden.'].join('\n'),
    );
    const template = document.createElement('template');
    template.innerHTML = html;

    const answer = template.content.querySelector<HTMLElement>('li.prompt-answer');
    const previewParagraph = answer?.querySelector<HTMLElement>('p');
    const paragraphs = Array.from(answer?.querySelectorAll<HTMLElement>('p') ?? []);

    t.truthy(answer);
    t.is(previewParagraph?.textContent?.trim(), firstParagraphWords.join(' '));
    t.is(paragraphs.length, 2);
    t.is(paragraphs[1]?.textContent?.trim(), 'Second paragraph starts hidden.');
    t.falsy(answer?.querySelector('.prompt-answer-preview'));
    t.falsy(answer?.querySelector('.prompt-answer-toggle'));
  });
});

test('parseMarkdownToHtml replaces non-period preview punctuation with an ellipsis for collapsed prompt answers', (t) => {
  withDom(() => {
    const fortyWordQuestion = `${Array.from({ length: 39 }, (_, index) => `word${index + 1}`).join(' ')} question?`;
    const html = parseMarkdownToHtml(['~ Question', `⏺ ${fortyWordQuestion}`, '  ', '  More detail.'].join('\n'));
    const template = document.createElement('template');
    template.innerHTML = html;

    const answer = template.content.querySelector<HTMLElement>('li.prompt-answer');
    const paragraphs = Array.from(answer?.querySelectorAll<HTMLElement>('p') ?? []);

    t.truthy(answer);
    t.is(paragraphs.length, 2);
    t.is(paragraphs[0]?.textContent, fortyWordQuestion);
    t.falsy(answer?.querySelector('.prompt-answer-preview'));
  });
});

test('setPromptAnswerExpandedState updates prompt-answer expansion attributes without changing content', (t) => {
  withDom(() => {
    const thirdParagraphWords = Array.from({ length: 35 }, (_, index) => `word${index + 1}`);
    const html = parseMarkdownToHtml(
      [
        '~ Question',
        '⏺ First paragraph stays visible here.',
        '  ',
        '  Second paragraph also stays visible.',
        '  ',
        `  ${thirdParagraphWords.join(' ')}`,
        '  ',
        '  Final paragraph ends here.',
      ].join('\n'),
    );
    const template = document.createElement('template');
    template.innerHTML = html;

    const answer = template.content.querySelector<HTMLElement>('li.prompt-answer');
    t.truthy(answer);
    if (!answer) return;

    setPromptAnswerExpandedState(answer, true);

    const paragraphs = Array.from(answer.querySelectorAll<HTMLElement>('p'));
    t.is(answer.getAttribute('data-expanded'), 'true');
    t.is(answer.getAttribute('aria-expanded'), 'true');
    t.is(paragraphs[2]?.textContent?.trim(), thirdParagraphWords.join(' '));
    t.is(paragraphs.at(-1)?.textContent?.trim(), 'Final paragraph ends here.');
  });
});

test('togglePromptAnswerExpandedState keeps collapsed prompt answers aligned below the toolbar and prompt list header', (t) => {
  withDom(() => {
    const thirdParagraphWords = Array.from({ length: 45 }, (_, index) => `word${index + 1}`);
    const html = parseMarkdownToHtml(
      [
        '~ Question',
        '⏺ First paragraph stays visible here.',
        '  ',
        '  Second paragraph also stays visible.',
        '  ',
        `  ${thirdParagraphWords.join(' ')}`,
      ].join('\n'),
    );
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<header class="toolbar"></header><div class="content"><div class="rendered-markdown">${html}</div></div>`;
    document.body.append(wrapper);

    const toolbar = wrapper.querySelector<HTMLElement>('.toolbar');
    const header = wrapper.querySelector<HTMLElement>('.prompt-list-header');
    const answer = wrapper.querySelector<HTMLElement>('li.prompt-answer');
    t.truthy(toolbar);
    t.truthy(header);
    t.truthy(answer);
    if (!toolbar || !header || !answer) return;

    setPromptAnswerExpandedState(answer, true);

    Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, value: 52 });
    Object.defineProperty(header, 'offsetHeight', { configurable: true, value: 20 });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 300 });
    Object.defineProperty(answer, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          x: 0,
          y: 260,
          top: 260,
          right: 0,
          bottom: 320,
          left: 0,
          width: 0,
          height: 60,
          toJSON: () => ({}),
        }) satisfies DOMRect,
    });

    const scrollCalls: ScrollToOptions[] = [];
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: (options: ScrollToOptions) => {
        scrollCalls.push(options);
      },
    });

    togglePromptAnswerExpandedState(answer, { keepTopInViewOnCollapse: true });

    t.is(answer.getAttribute('data-expanded'), 'false');
    t.is(scrollCalls.length, 1);
    t.is(scrollCalls[0]?.behavior, 'auto');
    t.is(scrollCalls[0]?.top, 218);
  });
});

test('setPromptListCollapsedState can clear conversation collapse without expanding sibling answers', (t) => {
  withDom(() => {
    const html = parseMarkdownToHtml(
      [
        '~ First question',
        '⏺ First answer paragraph.',
        '  ',
        '  First answer hidden tail.',
        '~ Second question',
        '⏺ Second answer paragraph.',
        '  ',
        '  Second answer hidden tail.',
      ].join('\n'),
    );
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<div class="rendered-markdown">${html}</div>`;

    const conversation = wrapper.querySelector<HTMLElement>('.prompt-list-conversation');
    const answers = Array.from(wrapper.querySelectorAll<HTMLElement>('li.prompt-answer'));
    t.truthy(conversation);
    t.is(answers.length, 2);
    if (!conversation || answers.length !== 2) return;

    setPromptListCollapsedState(conversation, true);
    t.is(conversation.getAttribute('data-collapsed'), 'true');
    t.deepEqual(
      answers.map((answer) => answer.getAttribute('data-expanded')),
      ['false', 'false'],
    );

    setPromptListCollapsedState(conversation, false, { syncAnswers: false });
    togglePromptAnswerExpandedState(answers[0]);

    t.is(conversation.getAttribute('data-collapsed'), 'false');
    t.deepEqual(
      answers.map((answer) => answer.getAttribute('data-expanded')),
      ['true', 'false'],
    );
  });
});

test('syncPromptAnswerExpandedStateInUrl persists prompt answer expansion keys while prompt lists default to read mode', (t) => {
  withDom(() => {
    const html = parseMarkdownToHtml(['~ Question', '⏺ Answer one.', '~ Follow up', '⏺ Answer two.'].join('\n'));
    const initialWrapper = document.createElement('div');
    initialWrapper.innerHTML = `<div class="rendered-markdown">${html}</div>`;

    const initialConversation = initialWrapper.querySelector<HTMLElement>('.prompt-list-conversation');
    const initialAnswers = Array.from(initialWrapper.querySelectorAll<HTMLElement>('li.prompt-answer'));
    t.truthy(initialConversation);
    t.is(initialAnswers.length, 2);
    if (!initialConversation || initialAnswers.length !== 2) return;

    togglePromptAnswerExpandedState(initialAnswers[0]);
    syncPromptAnswerExpandedStateInUrl(initialAnswers[0]);

    const rerenderedWrapper = document.createElement('div');
    rerenderedWrapper.innerHTML = `<div class="rendered-markdown">${parseMarkdownToHtml('~ Question\n⏺ Answer one.\n~ Follow up\n⏺ Answer two.')}</div>`;
    restorePromptListCollapsedStates(rerenderedWrapper, null, false);
    restorePromptAnswerExpandedStates(rerenderedWrapper);

    const rerenderedConversation = rerenderedWrapper.querySelector<HTMLElement>('.prompt-list-conversation');
    const rerenderedAnswers = Array.from(rerenderedWrapper.querySelectorAll<HTMLElement>('li.prompt-answer'));
    t.truthy(rerenderedConversation);
    t.deepEqual(
      rerenderedAnswers.map((answer) => answer.getAttribute('data-expanded')),
      ['true', 'true'],
    );
    t.is(rerenderedConversation?.getAttribute('data-collapsed'), 'false');
    t.is(
      new URLSearchParams(window.location.search).get('ple'),
      `${initialConversation.getAttribute('data-prompt-list-id')}:${initialAnswers[0]?.getAttribute('data-prompt-list-item-index')}`,
    );
  });
});

test('prompt answer expansion state survives prompt-list rerenders in read mode', (t) => {
  withDom(() => {
    const markdown = [
      '~ Question',
      '⏺ First answer paragraph.',
      '  ',
      '  First answer hidden tail.',
      '~ Follow up',
      '⏺ Second answer paragraph.',
      '  ',
      '  Second answer hidden tail.',
    ].join('\n');
    const html = parseMarkdownToHtml(markdown);
    const initialWrapper = document.createElement('div');
    initialWrapper.innerHTML = `<div class="rendered-markdown">${html}</div>`;

    const initialConversation = initialWrapper.querySelector<HTMLElement>('.prompt-list-conversation');
    const initialAnswers = Array.from(initialWrapper.querySelectorAll<HTMLElement>('li.prompt-answer'));
    t.truthy(initialConversation);
    t.is(initialAnswers.length, 2);
    if (!initialConversation || initialAnswers.length !== 2) return;

    setPromptListCollapsedState(initialConversation, false);
    togglePromptAnswerExpandedState(initialAnswers[1]);
    const collapsedSnapshot = capturePromptListCollapsedStates(initialWrapper);
    const snapshot = capturePromptAnswerExpandedStates(initialWrapper);

    const rerenderedWrapper = document.createElement('div');
    rerenderedWrapper.innerHTML = `<div class="rendered-markdown">${parseMarkdownToHtml(markdown)}</div>`;
    restorePromptListCollapsedStates(rerenderedWrapper, collapsedSnapshot, false);
    restorePromptAnswerExpandedStates(rerenderedWrapper, snapshot);

    const rerenderedConversation = rerenderedWrapper.querySelector<HTMLElement>('.prompt-list-conversation');
    const rerenderedAnswers = Array.from(rerenderedWrapper.querySelectorAll<HTMLElement>('li.prompt-answer'));
    t.is(rerenderedConversation?.getAttribute('data-collapsed'), 'false');
    t.deepEqual(
      rerenderedAnswers.map((answer) => answer.getAttribute('data-expanded')),
      ['true', 'false'],
    );
  });
});

test('prompt-list defaults to read mode on rerender when no prior snapshot exists', (t) => {
  withDom(() => {
    const markdown = ['~ Question', '⏺ First answer.', '~ Follow up', '⏺ Second answer.'].join('\n');
    const html = parseMarkdownToHtml(markdown);
    const initialWrapper = document.createElement('div');
    initialWrapper.innerHTML = `<div class="rendered-markdown">${html}</div>`;

    const conversation = initialWrapper.querySelector<HTMLElement>('.prompt-list-conversation');
    t.truthy(conversation);
    if (!conversation) return;

    setPromptListCollapsedState(conversation, false);

    const rerenderedWrapper = document.createElement('div');
    rerenderedWrapper.innerHTML = `<div class="rendered-markdown">${parseMarkdownToHtml(markdown)}</div>`;
    restorePromptListCollapsedStates(rerenderedWrapper, null, false);
    restorePromptAnswerExpandedStates(rerenderedWrapper);

    const rerenderedConversation = rerenderedWrapper.querySelector<HTMLElement>('.prompt-list-conversation');
    const rerenderedAnswers = Array.from(rerenderedWrapper.querySelectorAll<HTMLElement>('li.prompt-answer'));
    t.is(rerenderedConversation?.getAttribute('data-collapsed'), 'false');
    t.deepEqual(
      rerenderedAnswers.map((answer) => answer.getAttribute('data-expanded')),
      ['true', 'true'],
    );
  });
});

test('parseMarkdownToHtml leaves single-paragraph prompt answers uncollapsed', (t) => {
  const html = withDom(() => parseMarkdownToHtml(['~ Question', '⏺ Only one paragraph.'].join('\n')));

  t.regex(html, /<li class="prompt-answer"[^>]*>Only one paragraph\.<\/li>/);
  t.false(html.includes('prompt-answer-toggle'));
});

test('parseMarkdownToHtml renders placeholders for empty prompt question and answer rows', (t) => {
  const html = withDom(() => parseMarkdownToHtml('~ \n⏺ '));

  t.true(html.includes('<li class="prompt-question"><span class="prompt-list-placeholder">Continue here</span></li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*><span class="prompt-list-placeholder">Continue here<\/span><\/li>/);
});

test('parseMarkdownToHtml keeps a prompt list unified across a single blank line between items', (t) => {
  const html = withDom(() => parseMarkdownToHtml(['~ one', '⏺ answer', '  ', '~ two', '⏺ next'].join('\n')));

  t.is((html.match(/class="prompt-list-conversation"/g) ?? []).length, 1);
  t.true(html.includes('<li class="prompt-question">one</li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>answer<\/li>/);
  t.true(html.includes('<li class="prompt-question">two</li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>next<\/li>/);
});

test('parseMarkdownToHtml wraps nested prompt-list branches in nested lists', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(['~ root', '⏺ root answer', '  ~ branch', '  ⏺ branch answer', '~ next root'].join('\n')),
  );

  t.true(html.includes('<li class="prompt-question">root</li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>root answer<\/li>/);
  t.true(html.includes('<li class="prompt-list-branch"><ul class="prompt-list-tree">'));
  t.true(html.includes('<li class="prompt-question">branch</li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>branch answer<\/li>/);
  t.true(html.includes('<li class="prompt-question">next root</li>'));
});

test('parseMarkdownToHtml splits prompt lists across two blank lines between items', (t) => {
  const html = withDom(() => parseMarkdownToHtml(['~ one', '⏺ answer', '  ', '  ', '~ two', '⏺ next'].join('\n')));

  t.is((html.match(/class="prompt-list-conversation"/g) ?? []).length, 2);
});

test('parseMarkdownToHtml does not preserve an extra leading space on resumed prompt-answer paragraphs', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(
      [
        '~ What symbols are used as prompts by different shells?',
        "⏺ Different shells use various symbols as prompts to indicate the user's current context.",
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

test('parseMarkdownToHtml preserves thematic breaks inside prompt answers', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(['~ Question', '⏺ Intro paragraph.', '  ', '  ---', '  Following section.'].join('\n')),
  );

  t.true(html.includes('<hr'));
  t.true(html.includes('<p>Following section.</p>'));
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

test('parseMarkdownToHtml does not duplicate task list checkboxes when loose list items contain nested lists', (t) => {
  const { html, checkboxCount } = withDom(() => {
    const html = parseMarkdownToHtml(
      [
        '- Plain parent item',
        '',
        '- [ ] Parent task item',
        '  - [ ] Nested task item',
        '- [ ] Another parent task',
        '  - Nested plain item',
        '  - Another nested plain item',
      ].join('\n'),
    );
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    return {
      html,
      checkboxCount: wrapper.querySelectorAll('input[type="checkbox"]').length,
    };
  });

  t.is(checkboxCount, 3);
  t.false(html.includes('<input disabled="" type="checkbox"> <input disabled="" type="checkbox">'));
});

test('task list styles cover loose list items with paragraph-wrapped checkboxes', (t) => {
  const css = readFileSync(new URL('../../src/styles/markdown.css', import.meta.url), 'utf8');

  t.true(css.includes('.rendered-markdown li:has(> p > input[type="checkbox"]) {'));
  t.true(css.includes('.rendered-markdown li:has(> p > input[type="checkbox"]) > p > input[type="checkbox"] {'));
});

test('parseMarkdownToHtml splits unordered lists at <!-- list-break --> sentinels', (t) => {
  const html = withDom(() => parseMarkdownToHtml('- a\n\n<!-- list-break -->\n\n- b\n'));

  t.regex(html, /<\/ul>\s*<ul/);
  t.false(html.includes('<!-- list-break -->'));
  t.false(html.includes('<p>a</p>'));
  t.false(html.includes('<p>b</p>'));
});

test('parseMarkdownDocument keeps separate sync blocks for lists split by <!-- list-break -->', (t) => {
  const parsed = withDom(() => parseMarkdownDocument('- a\n\n<!-- list-break -->\n\n- b\n'));

  t.is(parsed.syncBlocks.filter((block) => block.type === 'list').length, 2);
});

test('parseMarkdownToHtml does not preserve repeated inline spaces as indentation', (t) => {
  const html = withDom(() => parseMarkdownToHtml('keep  inline spaces'));

  t.false(html.includes('leading-indent'));
  t.true(html.includes('keep  inline spaces'));
});

test('parseMarkdownToHtml collapses soft line breaks inside paragraphs', (t) => {
  const html = withDom(() => parseMarkdownToHtml('foo\nbar'));

  t.regex(html, /<p(?:\s+data-sync-id="[^"]+")?>foo bar<\/p>/);
  t.false(html.includes('<br>'));
});

test('parseMarkdownToHtml keeps fenced code blocks unchanged while preserving prose indentation', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```\n    code\n```'));

  t.regex(html, /<pre(?:\s+data-sync-id="[^"]+")?><code> {4}code\n<\/code><\/pre>/);
  t.false(html.includes('leading-indent'));
});

test('parseMarkdownToHtml keeps straight quotes unless smartQuotes is enabled', (t) => {
  const html = withDom(() => parseMarkdownToHtml('"hello", it\'s me.'));

  t.true(html.includes('"hello", it\'s me.'));
  t.false(html.includes('“hello”'));
  t.false(html.includes('it’s'));
});

test('parseMarkdownToHtml renders smart double quotes and apostrophes when enabled', (t) => {
  const html = withDom(() => parseMarkdownToHtml('"hello", it\'s me.', { smartQuotes: true }));

  t.true(html.includes('“hello”, it’s me.'));
});

test('parseMarkdownToHtml renders smart quotes across inline markup when enabled', (t) => {
  const html = withDom(() => parseMarkdownToHtml('"hello **world**"', { smartQuotes: true }));

  t.regex(html, /<p(?:\s+data-sync-id="[^"]+")?>“hello <strong>world<\/strong>”<\/p>/);
});

test('parseMarkdownToHtml keeps feet and inch marks literal when smartQuotes is enabled', (t) => {
  const html = withDom(() => parseMarkdownToHtml('He is 5\' 10" tall.', { smartQuotes: true }));

  t.true(html.includes('5\' 10" tall.'));
  t.false(html.includes('5’ 10”'));
});

test('parseMarkdownToHtml keeps fenced code quotes literal when smartQuotes is enabled', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```\nconst x = "quoted";\n```', { smartQuotes: true }));

  t.regex(html, /<pre(?:\s+data-sync-id="[^"]+")?><code>const x = "quoted";\n<\/code><\/pre>/);
  t.false(html.includes('“quoted”'));
});

test('parseMarkdownToHtml renders CriticMarkup inside prompt list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('~ Review {++this++}\n⏺ Keep {--that--}'));

  t.true(html.includes('<li class="prompt-question">Review <ins class="critic-addition">this</ins></li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>Keep <del class="critic-deletion">that<\/del><\/li>/);
});

test('parseMarkdownToHtml renders double-plus inline comments inside list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('- Keep ++internal note++ nearby.'));

  t.true(html.includes('<li>Keep <span class="inline-comment">internal note</span> nearby.</li>'));
});

test('parseMarkdownToHtml renders double-plus inline comments inside prompt list items', (t) => {
  const html = withDom(() => parseMarkdownToHtml('~ Ask ++private note++\n⏺ Answer ++draft thought++'));

  t.true(html.includes('<li class="prompt-question">Ask <span class="inline-comment">private note</span></li>'));
  t.regex(html, /<li class="prompt-answer"[^>]*>Answer <span class="inline-comment">draft thought<\/span><\/li>/);
});

test('parseMarkdownToHtml renders CriticMarkup inside footnote definitions', (t) => {
  const html = withDom(() => parseMarkdownToHtml('See [^edit].\n\n[^edit]: add {++this++}'));

  t.true(html.includes('<section class="footnotes"'));
  t.true(html.includes('<ins class="critic-addition">this</ins>'));
});

test('parseMarkdownToHtml does not treat leading space inside opening CriticMarkup as paragraph indentation', (t) => {
  const html = withDom(() =>
    parseMarkdownToHtml(
      '{== I think it should be possible to use ai to create a software system that captures snippets or pieces of general directions of thinking ==}, and allows people to collaborate on extending them.',
    ),
  );

  t.true(html.includes('<mark class="critic-highlight"> I think it should be possible'));
  t.false(html.includes('leading-indent-block'));
});

test('parseMarkdownToHtml does not parse CriticMarkup inside fenced code blocks', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```md\n{++literal++}\n```'));

  t.regex(html, /<pre(?:\s+data-sync-id="[^"]+")?><code(?: class="language-md")?>\{\+\+literal\+\+\}\n<\/code><\/pre>/);
  t.false(html.includes('critic-addition'));
});

test('parseMarkdownToHtml does not parse double-plus inline comments inside fenced code blocks', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```md\n++literal++\n```'));

  t.regex(html, /<pre(?:\s+data-sync-id="[^"]+")?><code(?: class="language-md")?>\+\+literal\+\+\n<\/code><\/pre>/);
  t.false(html.includes('inline-comment'));
});

test('parseMarkdownToHtml renders empty tilde prompt placeholders inside io code blocks', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```io\n~ \n⏺ Answer\n```'));

  t.true(html.includes('<code class="language-io'));
  t.true(
    html.includes(
      `<span class="io-hl-prompt-question-marker io-hl-prompt-prefix">~ </span><span class="io-hl-prompt-question-placeholder">${EMPTY_PROMPT_QUESTION_PLACEHOLDER}</span>`,
    ),
  );
  t.true(html.includes('<span class="io-hl-prompt-marker io-hl-prompt-prefix">⏺ </span>Answer'));
});

test('parseMarkdownToHtml renders brace prompt tab hints only at the end of io code block lines', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```io\nbefore {prompt}\nbefore {inline} after\n```'));

  t.true(
    html.includes(
      `<span class="io-hl-brace-prompt">{prompt}</span><span class="io-hl-brace-prompt-hint">${BRACE_PROMPT_HINT_LABEL}</span>`,
    ),
  );
  t.true(html.includes('<span class="io-hl-brace-prompt">{inline}</span> after'));
  t.false(
    html.includes(
      `<span class="io-hl-brace-prompt">{inline}</span><span class="io-hl-brace-prompt-hint">${BRACE_PROMPT_HINT_LABEL}</span>`,
    ),
  );
});

test('parseMarkdownToHtml highlights double-plus inline comments inside io code blocks', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```io\nbefore ++note++ after\n```'));

  t.true(html.includes('before <span class="io-hl-inline-comment">++note++</span> after'));
});

test('parseMarkdownToHtml strips shallow prompt continuation indentation inside io code blocks', (t) => {
  const html = withDom(() => parseMarkdownToHtml('```io\n⏺ First paragraph.\n  \n  Second paragraph.\n```'));

  t.true(
    html.includes(
      '<span class="io-hl-prompt-marker io-hl-prompt-prefix">⏺ </span>First paragraph.\n\nSecond paragraph.',
    ),
  );
  t.false(
    html.includes(
      '<span class="io-hl-prompt-marker io-hl-prompt-prefix">⏺ </span>First paragraph.\n  \n  Second paragraph.',
    ),
  );
  t.false(
    html.includes(
      '<span class="io-hl-prompt-marker io-hl-prompt-prefix">⏺ </span>First paragraph.\n\n  Second paragraph.',
    ),
  );
});

test('io code block styles add a hanging prompt gutter', (t) => {
  const css = readFileSync(new URL('../../src/styles/markdown.css', import.meta.url), 'utf8');

  t.true(css.includes('.rendered-markdown pre code.language-io {'));
  t.true(css.includes('padding-left: 2ch;'));
  t.true(css.includes('.rendered-markdown .io-hl-prompt-prefix {'));
  t.true(css.includes('left: -2ch;'));
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
        '~ Question',
        '⏺ Here is a short reply.',
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

  t.regex(document.html, /<h1(?:\s+[^>]*?)?\sid="hello"(?:\s+[^>]*?)?>Hello<\/h1>/);
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

  t.regex(document.html, /<h1(?:\s+[^>]*?)?\sid="hello"(?:\s+[^>]*?)?>Hello<\/h1>/);
  t.truthy(document.customCss);
  t.is(document.customCssScope, null);
  t.true(
    document.customCss?.includes(
      '@import url("https://fonts.googleapis.com/css2?family=Libre+Franklin&family=Montserrat&display=swap");',
    ),
  );
  t.is(document.cssWarning, null);
});

test('parseMarkdownDocument loads google font variants from shorthand syntax', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
fonts: Lora@400,700,400italic,700italic
---
# Hello`,
    ),
  );

  t.truthy(document.customCss);
  t.true(
    document.customCss?.includes(
      '@import url("https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,700;1,400;1,700&display=swap");',
    ),
  );
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

test('parseMarkdownDocument generates body font rules from front matter variant shorthand', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
fonts:
  body: Lora@400,700,400italic,700italic
---
Paragraph`,
    ),
  );

  t.truthy(document.customCss);
  t.true(
    document.customCss?.includes(
      '@import url("https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,700;1,400;1,700&display=swap");',
    ),
  );
  t.true(document.customCss?.includes('font-family: "Lora", var(--font-sans), sans-serif;'));
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
  t.regex(document.html, /<p(?:\s+data-sync-id="[^"]+")?>hello<\/p>/);
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
~ Question
⏺ Answer`,
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

test('parseMarkdownDocument rewrites content container aliases to scoped selectors', (t) => {
  const document = withDom(() =>
    parseMarkdownDocument(
      `---
css: |
  .content { margin: -1rem; padding: 2rem; }
  .rendered-markdown { padding: 1rem; }
  main > .rendered-markdown { max-width: 42rem; }
---
# Hello`,
    ),
  );

  t.truthy(document.customCss);
  t.truthy(document.customCssScope);
  t.true(
    document.customCss?.includes(
      `[data-markdown-custom-css-content="${document.customCssScope}"] { margin: -1rem; padding: 2rem; }`,
    ),
  );
  t.true(document.customCss?.includes(`[data-markdown-custom-css="${document.customCssScope}"] { padding: 1rem; }`));
  t.true(
    document.customCss?.includes(
      `[data-markdown-custom-css-main="${document.customCssScope}"] > [data-markdown-custom-css="${document.customCssScope}"] { max-width: 42rem; }`,
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
~ Question
⏺ Answer`,
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
~ Question
⏺ Answer`,
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
