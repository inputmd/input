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

const SCROLL_POSITIONS_STORAGE_KEY = 'input_scroll_positions_v1';
const TEN_MINUTES_MS = 10 * 60 * 1000;

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

test.beforeEach(() => {
  clearStoredScrollPositions();
});

test.serial('clearStoredScrollPositions removes all saved page scroll offsets', (t) => {
  setStoredScrollPosition('repo:a:file-1.md', 120);
  setStoredScrollPosition('repo:a:file-2.md', 240);

  clearStoredScrollPositions();

  t.is(getStoredScrollPosition('repo:a:file-1.md'), null);
  t.is(getStoredScrollPosition('repo:a:file-2.md'), null);
  t.is(window.sessionStorage.getItem('input_scroll_positions_v1'), '{}');
});

test.serial('stored scroll positions expire after 10 minutes', (t) => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;

  try {
    setStoredScrollPosition('repo:a:file-1.md', 120);
    t.is(getStoredScrollPosition('repo:a:file-1.md'), 120);

    now += TEN_MINUTES_MS + 1;

    t.is(getStoredScrollPosition('repo:a:file-1.md'), null);
    t.is(window.sessionStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY), '{}');
  } finally {
    Date.now = originalNow;
  }
});

test.serial('stored scroll positions persist timestamps with the saved offset', (t) => {
  const originalNow = Date.now;
  const now = 1_700_000_000_000;
  Date.now = () => now;

  try {
    setStoredScrollPosition('repo:a:file-1.md', 240);

    const raw = window.sessionStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY);
    t.truthy(raw);
    const parsed = JSON.parse(raw ?? '{}') as Record<string, { top: number; updatedAt: number }>;
    t.deepEqual(parsed['repo:a:file-1.md'], { top: 240, updatedAt: now });
  } finally {
    Date.now = originalNow;
  }
});
