import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import test from 'ava';
import { JSDOM } from 'jsdom';
import {
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
      kind: block.kind,
      deletedText: block.deletedText,
      insert: block.insert,
      label: block.label,
    })),
    [
      {
        kind: 'replace',
        deletedText: 'line 3\n',
        insert: 'CHANGED 3\n',
        label: hunks[0]?.header,
      },
      {
        kind: 'replace',
        deletedText: 'line 18\n',
        insert: 'CHANGED 18\n',
        label: hunks[1]?.header,
      },
    ],
  );

  for (const block of blocks) {
    t.is(original.slice(block.from, block.to), block.deletedText ?? '');
  }
});

test('editorDiffPreviewExtension mounts block preview decorations without crashing render', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'alpha\nbeta\n',
        extensions: [
          editorDiffPreviewExtension({
            blocks: [
              {
                from: 0,
                to: 6,
                insert: 'ALPHA\n',
                kind: 'replace',
                deletedText: 'alpha\n',
                label: '@@ -1,1 +1,1 @@',
              },
            ],
          }),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    t.regex(view.dom.textContent ?? '', /ALPHA/);
    t.true(view.state.facet(EditorView.atomicRanges).length > 0);
    view.destroy();
  } finally {
    restore();
  }
});
