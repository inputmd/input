import { buildDirectoryTree, type DirectoryTreeFileNode, type DirectoryTreeFolderNode } from './directory_tree.ts';

export interface SidebarTreeFileEntry {
  path: string;
  active: boolean;
}

export type SidebarTreeFileNode<TEntry extends SidebarTreeFileEntry = SidebarTreeFileEntry> =
  DirectoryTreeFileNode<TEntry>;

export interface SidebarTreeFolderNode<TEntry extends SidebarTreeFileEntry = SidebarTreeFileEntry>
  extends Omit<DirectoryTreeFolderNode<TEntry>, 'children'> {
  children: SidebarTreeNode<TEntry>[];
  deemphasized: boolean;
  hasActiveDescendant: boolean;
}

export type SidebarTreeNode<TEntry extends SidebarTreeFileEntry = SidebarTreeFileEntry> =
  | SidebarTreeFileNode<TEntry>
  | SidebarTreeFolderNode<TEntry>;

function isKeepMarkerPath(path: string): boolean {
  return /(?:^|\/)\.keep$/i.test(path);
}

function isHiddenFolderPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

export function buildSidebarTree<TEntry extends SidebarTreeFileEntry>(files: TEntry[]): SidebarTreeFolderNode<TEntry> {
  const genericRoot = buildDirectoryTree(files);

  const annotateFolders = (folder: DirectoryTreeFolderNode<TEntry>): SidebarTreeFolderNode<TEntry> => {
    const children: SidebarTreeNode<TEntry>[] = [];
    let hasActiveDescendant = false;

    for (const child of folder.children) {
      if (child.kind === 'folder') {
        const annotatedChild = annotateFolders(child);
        if (annotatedChild.hasActiveDescendant) hasActiveDescendant = true;
        children.push(annotatedChild);
        continue;
      }
      if (isKeepMarkerPath(child.path)) {
        if (child.entry.active) hasActiveDescendant = true;
        continue;
      }
      if (child.entry.active) hasActiveDescendant = true;
      children.push(child);
    }

    return {
      ...folder,
      children,
      deemphasized: folder.path ? isHiddenFolderPath(folder.path) : false,
      hasActiveDescendant,
    };
  };

  return annotateFolders(genericRoot);
}
