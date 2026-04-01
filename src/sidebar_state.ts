const SIDEBAR_COLLAPSED_FOLDERS_STORAGE_KEY_PREFIX = 'sidebar_collapsed_folders_v1:';

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
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const collapsedFolders: Record<string, true> = {};
    for (const entry of parsed) {
      if (typeof entry !== 'string' || entry.length === 0) continue;
      collapsedFolders[entry] = true;
    }
    return collapsedFolders;
  } catch {
    return null;
  }
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
