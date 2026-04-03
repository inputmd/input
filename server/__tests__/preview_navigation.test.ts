import test from 'ava';
import { JSDOM } from 'jsdom';
import {
  findPreviewHashTarget,
  previewRouteHasFragment,
  previewRouteHistoryPath,
  previewRoutePathname,
  resolveInternalNavigationRoute,
  resolveInternalPreviewRoute,
} from '../../src/preview_navigation.ts';

function withDom<T>(callback: () => T): T {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://input.test/docs/current.md' });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    CSS: (globalThis as typeof globalThis & { CSS?: typeof CSS }).CSS,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLAnchorElement: dom.window.HTMLAnchorElement,
  });
  (globalThis as typeof globalThis & { CSS?: typeof CSS }).CSS = dom.window.CSS as typeof CSS;

  try {
    return callback();
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

test('findPreviewHashTarget resolves elements by id', (t) => {
  withDom(() => {
    const root = document.createElement('div');
    root.innerHTML = '<h2 id="target-section">Section</h2>';
    document.body.append(root);

    const target = findPreviewHashTarget(root, '#target-section');

    t.is(target?.id, 'target-section');
  });
});

test('findPreviewHashTarget resolves named anchors when no matching id exists', (t) => {
  withDom(() => {
    const root = document.createElement('div');
    root.innerHTML = '<p><a name="legacy-anchor"></a>Legacy target</p>';
    document.body.append(root);

    const target = findPreviewHashTarget(root, '#legacy-anchor');

    t.is(target?.getAttribute('name'), 'legacy-anchor');
  });
});

test('resolveInternalPreviewRoute strips hash fragments from same-origin markdown links', (t) => {
  withDom(() => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/docs/other.md#named-anchor');

    t.is(resolveInternalPreviewRoute(anchor), 'docs/other.md');
  });
});

test('resolveInternalNavigationRoute preserves hash fragments for same-origin markdown links', (t) => {
  withDom(() => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/docs/other.md#named-anchor');

    t.is(resolveInternalNavigationRoute(anchor), 'docs/other.md#named-anchor');
  });
});

test('resolveInternalNavigationRoute keeps direct hash links for same-document anchors', (t) => {
  withDom(() => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#named-anchor');

    t.is(resolveInternalNavigationRoute(anchor), '#named-anchor');
  });
});

test('preview route helpers split pathname and fragment correctly', (t) => {
  t.is(previewRoutePathname('/docs/other.md#named-anchor'), 'docs/other.md');
  t.is(previewRouteHistoryPath('docs/other.md#named-anchor'), '/docs/other.md#named-anchor');
  t.true(previewRouteHasFragment('docs/other.md#named-anchor'));
  t.false(previewRouteHasFragment('docs/other.md'));
});
