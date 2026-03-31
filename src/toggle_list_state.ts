const TOGGLE_LIST_STORAGE_PREFIX = 'toggle_list_state_v1:';

function normalizeToggleListIdentifierText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashToggleListIdentifierText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getToggleListStorageNamespace(root: HTMLElement): string {
  const explicit = (root.getAttribute('data-toggle-list-storage-key') ?? '').trim();
  if (explicit) return explicit;
  return window.location.pathname;
}

function readToggleListStateMap(root: HTMLElement): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(`${TOGGLE_LIST_STORAGE_PREFIX}${getToggleListStorageNamespace(root)}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, boolean] => {
        return typeof entry[0] === 'string' && typeof entry[1] === 'boolean';
      }),
    );
  } catch {
    return {};
  }
}

function writeToggleListStateMap(root: HTMLElement, state: Record<string, boolean>): void {
  const storageKey = `${TOGGLE_LIST_STORAGE_PREFIX}${getToggleListStorageNamespace(root)}`;
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    return;
  }
}

function summaryForToggleList(details: HTMLDetailsElement): HTMLElement | null {
  const summary = details.querySelector(':scope > summary');
  return summary instanceof HTMLElement ? summary : null;
}

function setToggleListOpenState(details: HTMLDetailsElement, open: boolean): void {
  details.open = open;
  details.setAttribute('data-open', open ? 'true' : 'false');
  const summary = summaryForToggleList(details);
  if (summary) summary.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleListRootFromNode(root: ParentNode): HTMLElement | null {
  if (root instanceof HTMLElement && root.matches('.rendered-markdown')) return root;
  if ('querySelector' in root) {
    const nested = root.querySelector('.rendered-markdown');
    if (nested instanceof HTMLElement) return nested;
  }
  return null;
}

function persistToggleListState(details: HTMLDetailsElement): void {
  const root = details.closest<HTMLElement>('.rendered-markdown');
  const id = details.getAttribute('data-toggle-list-id');
  if (!root || !id) return;
  const state = readToggleListStateMap(root);
  if (details.open) {
    state[id] = true;
  } else {
    delete state[id];
  }
  writeToggleListStateMap(root, state);
}

export function syncToggleListPersistedState(rootNode: ParentNode): void {
  const root = toggleListRootFromNode(rootNode);
  if (!root) return;

  const state = readToggleListStateMap(root);
  const duplicateCounts = new Map<string, number>();
  root.querySelectorAll<HTMLDetailsElement>('details.toggle-list').forEach((details) => {
    const summaryText = summaryForToggleList(details)?.textContent ?? '';
    const summaryHash = hashToggleListIdentifierText(normalizeToggleListIdentifierText(summaryText));
    const duplicateIndex = duplicateCounts.get(summaryHash) ?? 0;
    duplicateCounts.set(summaryHash, duplicateIndex + 1);
    const id = `${summaryHash}-${duplicateIndex}`;
    details.setAttribute('data-toggle-list-id', id);
    setToggleListOpenState(details, state[id] === true);
  });
}

export function toggleToggleListState(details: HTMLDetailsElement): boolean {
  const nextOpen = !details.open;
  setToggleListOpenState(details, nextOpen);
  persistToggleListState(details);
  return nextOpen;
}

export function findToggleListFromTarget(target: EventTarget | null): HTMLDetailsElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const summary = target.closest('summary.toggle-list-summary');
  if (!(summary instanceof HTMLElement)) return null;
  const details = summary.parentElement;
  return details instanceof HTMLDetailsElement && details.classList.contains('toggle-list') ? details : null;
}
