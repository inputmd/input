const SCROLL_POSITIONS_STORAGE_KEY = 'input_scroll_positions_v1';
const MAX_SCROLL_POSITION_ENTRIES = 200;

let loaded = false;
const scrollPositions = new Map<string, number>();

function loadScrollPositions(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;

  try {
    const raw = window.sessionStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return;

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        scrollPositions.set(key, value);
      }
    }
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
  return scrollPositions.get(key) ?? null;
}

export function setStoredScrollPosition(key: string, value: number): void {
  loadScrollPositions();
  scrollPositions.delete(key);
  scrollPositions.set(key, Math.max(0, value));
  persistScrollPositions();
}
