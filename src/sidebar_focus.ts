export interface SidebarVisibleNode {
  kind: 'file' | 'folder';
  path: string;
  parentPath: string | null;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  combinedFilePath?: string;
}

function combinedFolderPathForFilePath(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const parentPath = slash === -1 ? '' : path.slice(0, slash);
  const fileName = slash === -1 ? path : path.slice(slash + 1);
  if (!fileName.toLowerCase().endsWith('.md')) return null;
  const baseName = fileName.slice(0, -3);
  if (!baseName) return null;
  return parentPath ? `${parentPath}/${baseName}` : baseName;
}

export function resolveSidebarFocusedPath(
  previousFocusedPath: string | null,
  activeFilePath: string | null,
  visibleNodes: readonly SidebarVisibleNode[],
): string | null {
  if (visibleNodes.length === 0) return null;

  const visibleIndexByPath = new Map<string, number>();
  for (const [index, node] of visibleNodes.entries()) {
    visibleIndexByPath.set(node.path, index);
    if (node.combinedFilePath) visibleIndexByPath.set(node.combinedFilePath, index);
  }

  if (previousFocusedPath && visibleIndexByPath.has(previousFocusedPath)) return previousFocusedPath;

  if (previousFocusedPath) {
    const combinedFolderPath = combinedFolderPathForFilePath(previousFocusedPath);
    if (combinedFolderPath && visibleIndexByPath.has(combinedFolderPath)) return combinedFolderPath;
  }

  if (activeFilePath && visibleIndexByPath.has(activeFilePath)) return activeFilePath;
  return visibleNodes[0]?.path ?? null;
}
