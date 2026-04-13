import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import test from 'ava';
import { JSDOM } from 'jsdom';
import {
  bracePromptHintForText,
  bracePromptHintLabelForText,
  bracePromptRangesForText,
  markdownCodeLanguageSupport,
  markdownEditorLanguageSupport,
  promptListHintLabelForText,
} from '../../src/components/codemirror_markdown.ts';

function syntaxNodeNames(state: EditorState): Set<string> {
  const names = new Set<string>();
  syntaxTree(state).iterate({
    enter: (node) => {
      names.add(node.name);
    },
  });
  return names;
}

function installDomGlobals(dom: JSDOM): () => void {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousMutationObserver = globalThis.MutationObserver;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousWindowCtor = (globalThis as typeof globalThis & { Window?: typeof Window }).Window;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  dom.window.requestAnimationFrame = () => 0;
  dom.window.cancelAnimationFrame = () => {};
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver as typeof globalThis.MutationObserver;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement as typeof globalThis.HTMLElement;
  globalThis.Node = dom.window.Node as typeof globalThis.Node;
  (globalThis as typeof globalThis & { Window?: typeof Window }).Window = dom.window.Window as typeof Window;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

  return () => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.MutationObserver = previousMutationObserver;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.Node = previousNode;
    (globalThis as typeof globalThis & { Window?: typeof Window }).Window = previousWindowCtor;
    globalThis.getComputedStyle = previousGetComputedStyle;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  };
}

test('markdown editor language does not parse html comments', (t) => {
  const state = EditorState.create({
    doc: 'before <!--\nafter',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.false(names.has('HtmlComment'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown code view language does not parse html comments', (t) => {
  const state = EditorState.create({
    doc: 'before <!-- after',
    extensions: [markdownCodeLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.false(names.has('HtmlComment'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown editor language parses closed html comments without enabling html parsing', (t) => {
  const state = EditorState.create({
    doc: 'before <!-- comment --> after',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.true(names.has('HtmlComment'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown editor language parses multiline html comments without enabling html parsing', (t) => {
  const state = EditorState.create({
    doc: '<!--\n*comment*\n-->\nafter',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.true(names.has('HtmlCommentBlock'));
  t.false(names.has('Emphasis'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown editor language keeps inline comment content opaque to emphasis parsing', (t) => {
  const state = EditorState.create({
    doc: 'before <!-- *comment* --> after',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.true(names.has('HtmlComment'));
  t.false(names.has('Emphasis'));
});

test('markdown editor collapses markdown links until the selection enters them', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const doc = 'See [docs](https://example.com) here.';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [markdownEditorLanguageSupport()],
      }),
      parent: document.getElementById('app')!,
    });

    t.regex(view.dom.textContent ?? '', /See \[docs\] here\./);
    t.false((view.dom.textContent ?? '').includes('https://example.com'));
    t.truthy(view.dom.querySelector('.cm-collapsed-link-bracket'));

    const linkLabelFrom = doc.indexOf('docs');
    view.dispatch({ selection: EditorSelection.cursor(linkLabelFrom + 1) });

    t.regex(view.dom.textContent ?? '', /\[docs\]\(https:\/\/example\.com\)/);

    const linkEnd = doc.indexOf(' here.');
    view.dispatch({ selection: EditorSelection.cursor(linkEnd) });

    t.regex(view.dom.textContent ?? '', /\[docs\]\(https:\/\/example\.com\)/);
    view.destroy();
  } finally {
    restore();
  }
});

test('markdown editor collapses emphasis markers until the selection enters the formatted span', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const doc = 'Use *italic* and **bold** here.';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [markdownEditorLanguageSupport()],
      }),
      parent: document.getElementById('app')!,
    });

    t.regex(view.dom.textContent ?? '', /Use italic and bold here\./);
    t.false((view.dom.textContent ?? '').includes('*italic*'));
    t.false((view.dom.textContent ?? '').includes('**bold**'));

    const italicFrom = doc.indexOf('italic');
    view.dispatch({ selection: EditorSelection.cursor(italicFrom + 1) });
    t.regex(view.dom.textContent ?? '', /Use \*italic\* and bold here\./);

    const italicEnd = doc.indexOf(' and');
    view.dispatch({ selection: EditorSelection.cursor(italicEnd) });
    t.regex(view.dom.textContent ?? '', /Use \*italic\* and bold here\./);

    const boldFrom = doc.indexOf('bold');
    view.dispatch({ selection: EditorSelection.cursor(boldFrom + 1) });
    t.regex(view.dom.textContent ?? '', /Use italic and \*\*bold\*\* here\./);

    const boldEnd = doc.indexOf(' here.');
    view.dispatch({ selection: EditorSelection.cursor(boldEnd) });
    t.regex(view.dom.textContent ?? '', /Use italic and \*\*bold\*\* here\./);
    view.destroy();
  } finally {
    restore();
  }
});

test('markdown editor collapses strikethrough markers until the selection enters the formatted span', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const doc = 'Use ~~strike~~ here.';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [markdownEditorLanguageSupport()],
      }),
      parent: document.getElementById('app')!,
    });

    t.regex(view.dom.textContent ?? '', /Use strike here\./);
    t.false((view.dom.textContent ?? '').includes('~~strike~~'));

    const strikeFrom = doc.indexOf('strike');
    view.dispatch({ selection: EditorSelection.cursor(strikeFrom + 1) });
    t.regex(view.dom.textContent ?? '', /Use ~~strike~~ here\./);

    const strikeEnd = doc.indexOf(' here.');
    view.dispatch({ selection: EditorSelection.cursor(strikeEnd) });
    t.regex(view.dom.textContent ?? '', /Use ~~strike~~ here\./);
    view.destroy();
  } finally {
    restore();
  }
});

test('markdown editor leaves single-tilde markup literal', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const doc = 'Use ~strike~ here.';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [markdownEditorLanguageSupport()],
      }),
      parent: document.getElementById('app')!,
    });

    t.regex(view.dom.textContent ?? '', /Use ~strike~ here\./);
    view.destroy();
  } finally {
    restore();
  }
});

test('markdown editor collapses double-colon highlight markers until the selection enters the span', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const doc = 'Use ::highlighted text:: here.';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [markdownEditorLanguageSupport()],
      }),
      parent: document.getElementById('app')!,
    });

    t.regex(view.dom.textContent ?? '', /Use highlighted text here\./);
    t.false((view.dom.textContent ?? '').includes('::highlighted text::'));
    t.truthy(view.dom.querySelector('.cm-double-colon-highlight'));

    const highlightedFrom = doc.indexOf('highlighted');
    view.dispatch({ selection: EditorSelection.cursor(highlightedFrom + 1) });

    t.regex(view.dom.textContent ?? '', /Use ::highlighted text:: here\./);

    const highlightEnd = doc.indexOf(' here.');
    view.dispatch({ selection: EditorSelection.cursor(highlightEnd) });

    t.regex(view.dom.textContent ?? '', /Use ::highlighted text:: here\./);
    view.destroy();
  } finally {
    restore();
  }
});

test('markdown editor uncollapses double-colon highlights when the cursor sits just after the closing marker', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const doc = '- ::signal lantern:: stays highlighted when typing finishes.';
    const highlightEnd = doc.indexOf(' stays highlighted');
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(highlightEnd),
        extensions: [markdownEditorLanguageSupport()],
      }),
      parent: document.getElementById('app')!,
    });

    t.truthy(view.dom.querySelector('.cm-double-colon-highlight'));
    t.true((view.dom.textContent ?? '').includes('::signal lantern::'));
    view.destroy();
  } finally {
    restore();
  }
});

test('markdown editor decorates double-colon highlights inside long list items', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const doc =
      '- ::"Lantern systems":: are described here as a coordination pattern for nested teams, with enough trailing prose to keep the list item long and exercise the wrapped-line decoration path in CodeMirror.';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [markdownEditorLanguageSupport()],
      }),
      parent: document.getElementById('app')!,
    });

    t.truthy(view.dom.querySelector('.cm-double-colon-highlight'));
    t.false((view.dom.textContent ?? '').includes('::"Lantern systems"::'));
    view.destroy();
  } finally {
    restore();
  }
});

test('promptListHintLabelForText returns question hint labels', (t) => {
  t.is(promptListHintLabelForText('~ '), 'Type to ask AI');
  t.is(promptListHintLabelForText('~ Explain Solomonoff induction'), null);
  t.is(promptListHintLabelForText('❯ '), null);
  t.is(promptListHintLabelForText('✻ '), null);
  t.is(promptListHintLabelForText('% '), null);
});

test('promptListHintLabelForText returns answering hint for blank answers while streaming', (t) => {
  t.is(promptListHintLabelForText('⏺ ', true), 'Answering... (Esc to cancel)');
  t.is(promptListHintLabelForText('⏺ Existing answer', true), null);
  t.is(promptListHintLabelForText('⏺ ', false), null);
});

test('promptListHintLabelForText ignores non-question lines', (t) => {
  t.is(promptListHintLabelForText('⏺ Existing answer'), null);
  t.is(promptListHintLabelForText('- regular bullet'), null);
});

test('bracePromptHintLabelForText returns a hint at the end of a brace prompt', (t) => {
  const text = 'today {come up with two more examples}';
  t.is(bracePromptHintLabelForText(text, text.length), '⇥');
  t.deepEqual(bracePromptHintForText(text, text.length), {
    position: text.length,
    label: '⇥',
    className: 'cm-brace-prompt-hint',
  });
});

test('bracePromptHintLabelForText returns a hint when the selection ends right before a single closing brace', (t) => {
  const text = 'today {come up with two more examples}';
  const closingBracePosition = text.length - 1;

  t.is(bracePromptHintLabelForText(text, closingBracePosition), '⇥');
  t.deepEqual(bracePromptHintForText(text, closingBracePosition), {
    position: text.length,
    label: '⇥',
    className: 'cm-brace-prompt-hint',
  });
});

test('bracePromptHintLabelForText returns a hint when the selection ends right before the final double-brace closing marker', (t) => {
  const text = 'today {{come up with two more examples}}';
  const closingBracePosition = text.length - 1;

  t.is(bracePromptHintLabelForText(text, closingBracePosition), '⇥');
  t.deepEqual(bracePromptHintForText(text, closingBracePosition), {
    position: text.length,
    label: '⇥',
    className: 'cm-brace-prompt-hint',
  });
});

test('bracePromptHintLabelForText ignores positions away from a completed brace prompt', (t) => {
  const text = 'today {come up with two more examples} next';
  t.is(bracePromptHintLabelForText(text, text.length), null);
  t.is(bracePromptHintLabelForText(text, 'today {come'.length), null);
  t.deepEqual(bracePromptHintForText(text, text.length), null);
});

test('brace prompt syntax exists inside code, but editor parsing can identify those code contexts', (t) => {
  const inlineState = EditorState.create({
    doc: '`{query}`',
    extensions: [markdownEditorLanguageSupport()],
  });
  const fencedState = EditorState.create({
    doc: '```md\n{query}\n```',
    extensions: [markdownEditorLanguageSupport()],
  });

  t.true(syntaxNodeNames(inlineState).has('InlineCode'));
  t.true(syntaxNodeNames(fencedState).has('FencedCode'));
});

test('bracePromptHintForText anchors the hint at the closing brace', (t) => {
  const text = 'today {come up with two more examples} next';
  t.deepEqual(bracePromptHintForText(text, 'today {come up with two more examples}'.length), {
    position: 'today {come up with two more examples}'.length,
    label: '⇥',
    className: 'cm-brace-prompt-hint',
  });
});

test('bracePromptRangesForText returns valid brace prompt spans only', (t) => {
  t.deepEqual(bracePromptRangesForText('before {prompt} after'), [{ from: 7, to: 15 }]);
  t.deepEqual(bracePromptRangesForText('before {{skip}} and {keep}'), [
    { from: 7, to: 15 },
    { from: 20, to: 26 },
  ]);
  t.deepEqual(bracePromptRangesForText('before {++critic++} and {keep}'), [{ from: 24, to: 30 }]);
});
