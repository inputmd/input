import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import test from 'ava';
import { JSDOM } from 'jsdom';
import {
  buildDiffPreviewBlocksFromContent,
  buildDiffPreviewBlocksFromHunks,
  editorDiffPreviewExtension,
} from '../../src/components/codemirror_diff_preview.ts';
import { generateUnifiedDiff, parseUnifiedDiffHunks } from '../reader_ai_tools.ts';

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

test('buildDiffPreviewBlocksFromHunks returns one preview block per hunk', (t) => {
  const originalLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const modifiedLines = [...originalLines];
  modifiedLines[2] = 'CHANGED 3';
  modifiedLines[17] = 'CHANGED 18';

  const original = originalLines.join('\n');
  const modified = modifiedLines.join('\n');
  const diff = generateUnifiedDiff('multi.txt', original, modified);
  const hunks = parseUnifiedDiffHunks(diff);
  const blocks = buildDiffPreviewBlocksFromHunks(original, modified, hunks);

  t.is(hunks.length, 2);
  t.is(blocks.length, 2);

  t.deepEqual(
    blocks.map((block) => ({
      deletedText: block.deletedText,
      insertedText: block.insertedText,
      label: block.label,
    })),
    [
      {
        deletedText: 'line 3\n',
        insertedText: 'CHANGED 3\n',
        label: hunks[0]?.header,
      },
      {
        deletedText: 'line 18\n',
        insertedText: 'CHANGED 18\n',
        label: hunks[1]?.header,
      },
    ],
  );

  for (const block of blocks) {
    t.is(original.slice(block.from, block.to), block.deletedText ?? '');
  }
});

test('buildDiffPreviewBlocksFromHunks reflects split review hunks inside one raw diff hunk', (t) => {
  const originalLines = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
  const modifiedLines = [...originalLines];
  modifiedLines[1] = 'CHANGED 2';
  modifiedLines[5] = 'CHANGED 6';

  const original = `${originalLines.join('\n')}\n`;
  const modified = `${modifiedLines.join('\n')}\n`;
  const diff = generateUnifiedDiff('split.txt', originalLines.join('\n'), modifiedLines.join('\n'));
  const hunks = parseUnifiedDiffHunks(diff);
  const blocks = buildDiffPreviewBlocksFromHunks(original, modified, hunks);

  t.is(hunks.length, 2);
  t.is(blocks.length, 2);
  t.deepEqual(
    blocks.map((block) => ({
      deletedText: block.deletedText,
      insertedText: block.insertedText,
    })),
    [
      { deletedText: 'line 2\n', insertedText: 'CHANGED 2\n' },
      { deletedText: 'line 6\n', insertedText: 'CHANGED 6\n' },
    ],
  );
});

test('buildDiffPreviewBlocksFromContent returns one replacement block', (t) => {
  t.deepEqual(buildDiffPreviewBlocksFromContent('alpha beta gamma', 'alpha BETA gamma'), [
    {
      from: 6,
      to: 10,
      deletedText: 'beta',
      insertedText: 'BETA',
      label: undefined,
      status: undefined,
    },
  ]);
});

test('editorDiffPreviewExtension mounts block preview decorations without crashing render', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha\nbeta\ngamma\n',
        extensions: [
          editorDiffPreviewExtension({
            blocks: [
              {
                from: 0,
                to: 11,
                insertedText: 'ALPHA\nBETA\n',
                deletedText: 'alpha\nbeta\n',
                label: '@@ -1,2 +1,2 @@',
              },
            ],
          }),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    t.regex(view.dom.textContent ?? '', /ALPHA/);
    t.truthy(view.dom.querySelector('.cm-editor-diff-preview-widget--block'));
    t.true(view.state.facet(EditorView.atomicRanges).length > 0);
    view.destroy();
  } finally {
    restore();
  }
});

test('editorDiffPreviewExtension preserves paragraph breaks without an extra trailing widget newline', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const insertedText = [
      'Paragraph 1 line 1',
      'Paragraph 1 line 2',
      '',
      'Paragraph 2 line 1',
      'Paragraph 2 line 2',
      '',
    ].join('\n');
    const doc = 'Paragraph 1 line 1\nParagraph 1 line 2\n\nParagraph 2 line 1\nParagraph 2 line 2\n';
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          editorDiffPreviewExtension({
            blocks: [
              {
                from: 0,
                to: doc.length,
                insertedText,
                deletedText: '',
                label: '@@ -1,5 +1,5 @@',
              },
            ],
          }),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    const content = view.dom.querySelector<HTMLElement>('.cm-editor-diff-preview-content');
    t.truthy(content);
    t.is(content?.tagName, 'DIV');
    t.is(content?.textContent, insertedText.slice(0, -1));
    t.true((content?.textContent?.match(/\n\n/g)?.length ?? 0) === 1);
    view.destroy();
  } finally {
    restore();
  }
});

test('editorDiffPreviewExtension omits meta rows for proposal previews', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha\nbeta\ngamma\n',
        extensions: [
          editorDiffPreviewExtension({
            source: 'Reader AI',
            badge: 'Proposal',
            blocks: [
              {
                from: 0,
                to: 11,
                insertedText: 'ALPHA\nBETA\n',
                deletedText: 'alpha\nbeta\n',
                label: '@@ -1,2 +1,2 @@',
                detail: '1 of 1 review blocks selected from google/gemini-3-flash-preview.',
              },
            ],
          }),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    t.falsy(view.dom.querySelector('.cm-editor-diff-preview-meta'));
    t.falsy(view.dom.querySelector('.cm-editor-diff-preview-detail'));
    view.destroy();
  } finally {
    restore();
  }
});

test('editorDiffPreviewExtension renders mid-line previews inline without duplicating context', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha beta gamma\n',
        extensions: [
          editorDiffPreviewExtension({
            blocks: [
              {
                from: 6,
                to: 10,
                insertedText: 'BETA',
                deletedText: 'beta',
                label: '@@ -1 +1 @@',
              },
            ],
          }),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    const inlineWidget = view.dom.querySelector('.cm-editor-diff-preview-widget--inline');
    t.truthy(inlineWidget);
    t.falsy(view.dom.querySelector('.cm-editor-diff-preview-widget--block'));
    t.is(inlineWidget?.querySelectorAll('.cm-editor-diff-preview-inline-part--inserted').length, 1);
    t.is(inlineWidget?.textContent ?? '', 'BETA');
    t.regex(view.dom.textContent ?? '', /betaBETA gamma/);
    view.destroy();
  } finally {
    restore();
  }
});

test('editorDiffPreviewExtension promotes long single-line previews to block widgets', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha beta gamma\n',
        extensions: [
          editorDiffPreviewExtension({
            blocks: [
              {
                from: 6,
                to: 10,
                insertedText: 'B'.repeat(81),
                deletedText: 'beta',
                label: '@@ -1 +1 @@',
              },
            ],
          }),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    t.truthy(view.dom.querySelector('.cm-editor-diff-preview-widget--block'));
    t.falsy(view.dom.querySelector('.cm-editor-diff-preview-widget--inline'));
    view.destroy();
  } finally {
    restore();
  }
});

test('editorDiffPreviewExtension renders accept reject split buttons with state icons', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const events: Array<{ actionId: string; changeId: string; hunkId?: string }> = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha beta gamma\n',
        extensions: [
          editorDiffPreviewExtension(
            {
              blocks: [
                {
                  from: 6,
                  to: 10,
                  insertedText: 'BETA',
                  deletedText: 'beta',
                  status: 'accepted',
                  changeId: 'change-1',
                  hunkId: 'hunk-1',
                  actions: [{ id: 'review', label: 'Review' }],
                },
              ],
            },
            {
              onAction: (event) => {
                events.push({ actionId: event.actionId, changeId: event.changeId, hunkId: event.hunkId });
              },
            },
          ),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    const splitButtons = view.dom.querySelectorAll<HTMLButtonElement>(
      '.cm-editor-diff-preview-state-split .cm-editor-diff-preview-action',
    );
    t.is(splitButtons.length, 2);
    t.is(splitButtons[0]?.textContent?.includes('Accepted'), true);
    t.is(splitButtons[0]?.querySelectorAll('svg').length, 1);
    t.is(splitButtons[1]?.querySelectorAll('svg').length, 1);

    const buttons = view.dom.querySelectorAll<HTMLButtonElement>('.cm-editor-diff-preview-action');
    t.is(buttons.length, 3);
    buttons[0]?.click();
    buttons[1]?.click();
    buttons[2]?.click();
    t.deepEqual(events, [
      { actionId: 'accept', changeId: 'change-1', hunkId: 'hunk-1' },
      { actionId: 'reject', changeId: 'change-1', hunkId: 'hunk-1' },
      { actionId: 'review', changeId: 'change-1', hunkId: 'hunk-1' },
    ]);
    view.destroy();
  } finally {
    restore();
  }
});

test('editorDiffPreviewExtension renders inline delete widgets with actions', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const events: Array<{ actionId: string; changeId: string; hunkId?: string }> = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha beta gamma\n',
        extensions: [
          editorDiffPreviewExtension(
            {
              blocks: [
                {
                  from: 6,
                  to: 10,
                  deletedText: 'beta',
                  changeId: 'change-1',
                  hunkId: 'hunk-1',
                  actions: [{ id: 'reject', label: 'Reject', tone: 'danger' }],
                },
              ],
            },
            {
              onAction: (event) => {
                events.push({ actionId: event.actionId, changeId: event.changeId, hunkId: event.hunkId });
              },
            },
          ),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    const inlineWidget = view.dom.querySelector('.cm-editor-diff-preview-widget--inline');
    t.truthy(inlineWidget);
    t.is(inlineWidget?.textContent?.includes('Deleted'), true);
    const button = inlineWidget?.querySelector<HTMLButtonElement>('.cm-editor-diff-preview-action');
    t.truthy(button);
    button?.click();
    t.deepEqual(events, [{ actionId: 'reject', changeId: 'change-1', hunkId: 'hunk-1' }]);
    view.destroy();
  } finally {
    restore();
  }
});
