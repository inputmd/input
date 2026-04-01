import test from 'ava';
import { JSDOM } from 'jsdom';
import { collectPreviewHighlights } from '../../src/components/preview_highlights.ts';

function withDom<T>(callback: () => T): T {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    Range: globalThis.Range,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    Range: dom.window.Range,
  });

  try {
    return callback();
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

test('collectPreviewHighlights returns entry text and surrounding context', (t) => {
  withDom(() => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ul>
        <li>
          Parent item
          <ul>
            <li><p>Before <mark class="critic-highlight">target text</mark> after words.</p></li>
          </ul>
        </li>
      </ul>
    `;

    const { entries, elementsById } = collectPreviewHighlights(root);

    t.is(entries.length, 1);
    t.is(entries[0]?.text, 'target text');
    t.true((entries[0]?.prefix ?? '').includes('Parent item'));
    t.is(entries[0]?.suffix?.trim(), 'after words.');
    t.is(elementsById.get(entries[0]?.id ?? '')?.textContent, 'target text');
  });
});
