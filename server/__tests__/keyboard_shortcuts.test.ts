import test from 'ava';
import { JSDOM } from 'jsdom';
import {
  APP_SHORTCUTS_ALLOWED_ATTR,
  getTerminalInputOverride,
  isEditableShortcutTarget,
  shouldBypassTerminalMetaShortcut,
  TERMINAL_OPTION_ENTER_SEQUENCE,
} from '../../src/keyboard_shortcuts.ts';

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

test('shouldBypassTerminalMetaShortcut keeps Cmd+K inside the terminal', (t) => {
  const dom = new JSDOM('');
  try {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true });
    t.false(shouldBypassTerminalMetaShortcut(event));
  } finally {
    dom.window.close();
  }
});

test('shouldBypassTerminalMetaShortcut still bypasses browser shortcuts like Cmd+L', (t) => {
  const dom = new JSDOM('');
  try {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'l', code: 'KeyL', metaKey: true });
    t.true(shouldBypassTerminalMetaShortcut(event));
  } finally {
    dom.window.close();
  }
});

test('getTerminalInputOverride remaps Shift+Enter to the terminal option-enter sequence', (t) => {
  const dom = new JSDOM('');
  try {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
    t.is(getTerminalInputOverride(event), TERMINAL_OPTION_ENTER_SEQUENCE);
  } finally {
    dom.window.close();
  }
});

test('getTerminalInputOverride ignores plain and already-modified Enter presses', (t) => {
  const dom = new JSDOM('');
  try {
    t.is(getTerminalInputOverride(new dom.window.KeyboardEvent('keydown', { key: 'Enter' })), null);
    t.is(getTerminalInputOverride(new dom.window.KeyboardEvent('keydown', { key: 'Enter', altKey: true })), null);
    t.is(
      getTerminalInputOverride(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, ctrlKey: true }),
      ),
      null,
    );
  } finally {
    dom.window.close();
  }
});
