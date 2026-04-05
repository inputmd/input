const SCROLL_POSITIONS_STORAGE_KEY = 'input_scroll_positions_v1';
const MAX_SCROLL_POSITION_ENTRIES = 200;
const SCROLL_POSITION_TTL_MS = 10 * 60 * 1000;

interface ScrollPositionEntry {
  top: number;
  updatedAt: number;
}

let loaded = false;
const scrollPositions = new Map<string, ScrollPositionEntry>();

function isValidStoredTop(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isExpiredScrollPosition(entry: ScrollPositionEntry, now = Date.now()): boolean {
  return now - entry.updatedAt > SCROLL_POSITION_TTL_MS;
}

function pruneExpiredScrollPositions(now = Date.now()): boolean {
  let changed = false;
  for (const [key, entry] of scrollPositions.entries()) {
    if (!isExpiredScrollPosition(entry, now)) continue;
    scrollPositions.delete(key);
    changed = true;
  }
  return changed;
}

function loadScrollPositions(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;

  try {
    const raw = window.sessionStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return;

    const now = Date.now();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidStoredTop(value)) {
        scrollPositions.set(key, { top: value, updatedAt: now });
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const top = (value as { top?: unknown }).top;
      const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
      if (isValidStoredTop(top) && typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0) {
        scrollPositions.set(key, { top, updatedAt });
      }
    }
    pruneExpiredScrollPositions(now);
  } catch {
    scrollPositions.clear();
  }
}

function persistScrollPositions(): void {
  if (typeof window === 'undefined') return;

  try {
    const entries = Array.from(scrollPositions.entries());
    const trimmed = entries.slice(Math.max(0, entries.length - MAX_SCROLL_POSITION_ENTRIES));
    const payload = Object.fromEntries(trimmed);
    window.sessionStorage.setItem(SCROLL_POSITIONS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort only.
  }
}

export function getStoredScrollPosition(key: string): number | null {
  loadScrollPositions();
  if (pruneExpiredScrollPositions()) persistScrollPositions();
  return scrollPositions.get(key)?.top ?? null;
}

export function setStoredScrollPosition(key: string, value: number): void {
  loadScrollPositions();
  pruneExpiredScrollPositions();
  scrollPositions.delete(key);
  scrollPositions.set(key, { top: Math.max(0, value), updatedAt: Date.now() });
  persistScrollPositions();
}

export function clearStoredScrollPositions(): void {
  loadScrollPositions();
  scrollPositions.clear();
  persistScrollPositions();
}
