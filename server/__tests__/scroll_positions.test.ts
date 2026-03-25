import test from 'ava';
import {
  clearStoredScrollPositions,
  getStoredScrollPosition,
  setStoredScrollPosition,
} from '../../src/scroll_positions.ts';

function createSessionStorage() {
  const storage = new Map<string, string>();
  return {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
  };
}

test.before(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { sessionStorage: createSessionStorage() },
  });
});

test.after.always(() => {
  // `window` is test scaffolding for browser-only storage helpers.
  Reflect.deleteProperty(globalThis, 'window');
});

test.serial('clearStoredScrollPositions removes all saved page scroll offsets', (t) => {
  setStoredScrollPosition('repo:a:file-1.md', 120);
  setStoredScrollPosition('repo:a:file-2.md', 240);

  clearStoredScrollPositions();

  t.is(getStoredScrollPosition('repo:a:file-1.md'), null);
  t.is(getStoredScrollPosition('repo:a:file-2.md'), null);
  t.is(window.sessionStorage.getItem('input_scroll_positions_v1'), '{}');
});
