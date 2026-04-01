const SIDEBAR_COLLAPSED_FOLDERS_STORAGE_KEY_PREFIX = 'sidebar_collapsed_folders_v1:';

function parsePersistedSidebarCollapsedFolders(raw: string): Record<string, true> | null {
  const parsed = JSON.parse(raw);
  const collapsedFolders: Record<string, true> = {};

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry !== 'string' || entry.length === 0) continue;
      collapsedFolders[entry] = true;
    }
    return collapsedFolders;
  }

  if (parsed && typeof parsed === 'object') {
    for (const [path, collapsed] of Object.entries(parsed)) {
      if (typeof path !== 'string' || path.length === 0 || collapsed !== true) continue;
      collapsedFolders[path] = true;
    }
    return collapsedFolders;
  }

  return null;
}

function sidebarCollapsedFoldersStorageKey(workspaceKey: string): string | null {
  const key = workspaceKey.trim();
  if (!key || key === 'none') return null;
  return `${SIDEBAR_COLLAPSED_FOLDERS_STORAGE_KEY_PREFIX}${key}`;
}

export function readPersistedSidebarCollapsedFolders(workspaceKey: string): Record<string, true> | null {
  if (typeof window === 'undefined') return null;
  const storageKey = sidebarCollapsedFoldersStorageKey(workspaceKey);
  if (!storageKey) return null;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    return parsePersistedSidebarCollapsedFolders(raw);
  } catch {
    return null;
  }
}

export function loadSidebarCollapsedFoldersState(
  workspaceKey: string,
  defaultCollapsedPaths: Iterable<string>,
  activeAncestors: Iterable<string>,
): { collapsedFolders: Record<string, true>; loadedFromPersistence: boolean } {
  const persisted = readPersistedSidebarCollapsedFolders(workspaceKey);
  if (persisted !== null) {
    return { collapsedFolders: persisted, loadedFromPersistence: true };
  }

  const expandedPaths = new Set(activeAncestors);
  const collapsedFolders: Record<string, true> = {};
  for (const path of defaultCollapsedPaths) {
    if (expandedPaths.has(path)) continue;
    collapsedFolders[path] = true;
  }
  return { collapsedFolders, loadedFromPersistence: false };
}

export function persistSidebarCollapsedFolders(workspaceKey: string, collapsedFolders: Record<string, true>): void {
  if (typeof window === 'undefined') return;
  const storageKey = sidebarCollapsedFoldersStorageKey(workspaceKey);
  if (!storageKey) return;

  const paths = Object.keys(collapsedFolders)
    .filter((path) => collapsedFolders[path])
    .sort((a, b) => a.localeCompare(b));

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(paths));
  } catch {
    // Ignore storage failures and fall back to in-memory state.
  }
}
