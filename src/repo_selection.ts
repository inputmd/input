import { isPathInFolder, renamePathWithNewFolder } from './path_utils.ts';

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
