import { isPathInFolder, renamePathWithNewFolder } from './path_utils.ts';

const KEEP_REPO_SELECTION_EMPTY_KEY = 'keepRepoSelectionEmpty';

export function renameSelectedRepoFilePath(
  currentPath: string | null,
  oldPath: string,
  newPath: string,
): string | null {
  return currentPath === oldPath ? newPath : currentPath;
}

export function renameSelectedRepoFolderPath(
  currentPath: string | null,
  oldPath: string,
  newPath: string,
): string | null {
  if (!currentPath || !isPathInFolder(currentPath, oldPath)) return currentPath;
  return renamePathWithNewFolder(currentPath, oldPath, newPath);
}

export function withKeepRepoSelectionEmpty(state: unknown): Record<string, unknown> {
  const base = state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  return {
    ...base,
    [KEEP_REPO_SELECTION_EMPTY_KEY]: true,
  };
}

export function shouldKeepRepoSelectionEmpty(state: unknown): boolean {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  return (state as Record<string, unknown>)[KEEP_REPO_SELECTION_EMPTY_KEY] === true;
}
