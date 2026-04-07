import test from 'ava';
import { JSDOM } from 'jsdom';
import { APP_SHORTCUTS_ALLOWED_ATTR, isEditableShortcutTarget } from '../../src/keyboard_shortcuts.ts';

function withDom<T>(callback: () => T): T {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://input.test/doc' });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });

  try {
    return callback();
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

test('isEditableShortcutTarget keeps regular textareas opt-out for app shortcuts', (t) => {
  withDom(() => {
    const input = document.createElement('textarea');
    document.body.append(input);

    t.true(isEditableShortcutTarget(input));
  });
});

test('isEditableShortcutTarget allows marked composer targets to receive app shortcuts', (t) => {
  withDom(() => {
    const input = document.createElement('textarea');
    input.setAttribute(APP_SHORTCUTS_ALLOWED_ATTR, 'true');
    document.body.append(input);

    t.false(isEditableShortcutTarget(input));
  });
});
