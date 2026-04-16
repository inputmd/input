import { buildDirectoryTree, type DirectoryTreeFileNode, type DirectoryTreeFolderNode } from './directory_tree.ts';
import { isHiddenSidebarPath } from './path_utils.ts';

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
  combinedFile: SidebarTreeFileNode<TEntry> | null;
}

export type SidebarTreeNode<TEntry extends SidebarTreeFileEntry = SidebarTreeFileEntry> =
  | SidebarTreeFileNode<TEntry>
  | SidebarTreeFolderNode<TEntry>;

function sidebarNodeSortRank<TEntry extends SidebarTreeFileEntry>(node: SidebarTreeNode<TEntry>): number {
  if (node.kind === 'folder' && !node.combinedFile) return 0;
  return 1;
}

function sidebarNodeSortName<TEntry extends SidebarTreeFileEntry>(node: SidebarTreeNode<TEntry>): string {
  if (node.kind === 'folder' && node.combinedFile) return node.combinedFile.name;
  return node.name;
}

function sortSidebarTreeNodes<TEntry extends SidebarTreeFileEntry>(nodes: SidebarTreeNode<TEntry>[]): void {
  nodes.sort((left, right) => {
    const rankDiff = sidebarNodeSortRank(left) - sidebarNodeSortRank(right);
    if (rankDiff !== 0) return rankDiff;

    const nameDiff = sidebarNodeSortName(left).localeCompare(sidebarNodeSortName(right));
    if (nameDiff !== 0) return nameDiff;

    return left.path.localeCompare(right.path);
  });
}

function isMatchingCombinedMarkdownFile<TEntry extends SidebarTreeFileEntry>(
  folder: SidebarTreeFolderNode<TEntry>,
  file: SidebarTreeFileNode<TEntry>,
): boolean {
  const extIndex = file.name.lastIndexOf('.');
  if (extIndex <= 0) return false;
  const basename = file.name.slice(0, extIndex);
  const extension = file.name.slice(extIndex);
  return basename === folder.name && extension.toLowerCase() === '.md';
}

export function buildSidebarTree<TEntry extends SidebarTreeFileEntry>(files: TEntry[]): SidebarTreeFolderNode<TEntry> {
  const genericRoot = buildDirectoryTree(files);

  const annotateFolders = (folder: DirectoryTreeFolderNode<TEntry>): SidebarTreeFolderNode<TEntry> => {
    const annotatedChildren = folder.children.map((child) =>
      child.kind === 'folder' ? annotateFolders(child) : child,
    ) as SidebarTreeNode<TEntry>[];

    const children: SidebarTreeNode<TEntry>[] = [];
    const fileNodesByName = new Map<string, SidebarTreeFileNode<TEntry>>();
    const mergedFilePaths = new Set<string>();
    let hasActiveDescendant = false;

    for (const child of annotatedChildren) {
      if (child.kind === 'file') fileNodesByName.set(child.name, child);
    }

    for (const child of annotatedChildren) {
      if (child.kind === 'folder') {
        const matchingFile = fileNodesByName.get(`${child.name}.md`);
        const combinedFile = matchingFile && isMatchingCombinedMarkdownFile(child, matchingFile) ? matchingFile : null;
        if (combinedFile) {
          mergedFilePaths.add(combinedFile.path);
          child.combinedFile = combinedFile;
          if (combinedFile.entry.active) child.hasActiveDescendant = true;
        }
        if (child.hasActiveDescendant || combinedFile?.entry.active) hasActiveDescendant = true;
        children.push(child);
        continue;
      }
      if (mergedFilePaths.has(child.path)) continue;
      if (child.entry.active) hasActiveDescendant = true;
      children.push(child);
    }

    sortSidebarTreeNodes(children);

    return {
      ...folder,
      children,
      deemphasized: folder.path ? isHiddenSidebarPath(folder.path) : false,
      hasActiveDescendant,
      combinedFile: null,
    };
  };

  return annotateFolders(genericRoot);
}
