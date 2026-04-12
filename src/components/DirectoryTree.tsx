import type { ComponentChildren } from 'preact';

export interface DirectoryTreeEntry {
  path: string;
}

export interface DirectoryTreeFileNode<TEntry extends DirectoryTreeEntry = DirectoryTreeEntry> {
  kind: 'file';
  path: string;
  name: string;
  entry: TEntry;
}

export interface DirectoryTreeFolderNode<TEntry extends DirectoryTreeEntry = DirectoryTreeEntry> {
  kind: 'folder';
  path: string;
  name: string;
  children: DirectoryTreeNode<TEntry>[];
}

export type DirectoryTreeNode<TEntry extends DirectoryTreeEntry = DirectoryTreeEntry> =
  | DirectoryTreeFileNode<TEntry>
  | DirectoryTreeFolderNode<TEntry>;

export const DIRECTORY_TREE_INDENT_PX = 16;
export const DIRECTORY_TREE_CHEVRON_SIZE = 14;

interface BuildDirectoryTreeOptions<TEntry extends DirectoryTreeEntry> {
  shouldIncludeFile?: (entry: TEntry) => boolean;
}

interface DirectoryTreeProps<TEntry extends DirectoryTreeEntry> {
  nodes: DirectoryTreeNode<TEntry>[];
  depth?: number;
  isFolderCollapsed?: (folder: DirectoryTreeFolderNode<TEntry>) => boolean;
  renderFolder: (folder: DirectoryTreeFolderNode<TEntry>, depth: number, collapsed: boolean) => ComponentChildren;
  renderFile: (file: DirectoryTreeFileNode<TEntry>, depth: number) => ComponentChildren;
  renderFolderChildren?: (
    folder: DirectoryTreeFolderNode<TEntry>,
    depth: number,
    children: ComponentChildren,
  ) => ComponentChildren;
  renderAfterChildren?: (folder: DirectoryTreeFolderNode<TEntry>, childDepth: number) => ComponentChildren;
}

function sortDirectoryTree<TEntry extends DirectoryTreeEntry>(nodes: DirectoryTreeNode<TEntry>[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const node of nodes) {
    if (node.kind === 'folder') sortDirectoryTree(node.children);
  }
}

export function buildDirectoryTree<TEntry extends DirectoryTreeEntry>(
  entries: readonly TEntry[],
  options: BuildDirectoryTreeOptions<TEntry> = {},
): DirectoryTreeFolderNode<TEntry> {
  const root: DirectoryTreeFolderNode<TEntry> = {
    kind: 'folder',
    path: '',
    name: '',
    children: [],
  };
  const folderMap = new Map<string, DirectoryTreeFolderNode<TEntry>>();
  folderMap.set('', root);
  const sortedEntries = [...entries].sort((left, right) => left.path.localeCompare(right.path));

  for (const entry of sortedEntries) {
    if (options.shouldIncludeFile && !options.shouldIncludeFile(entry)) continue;
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let parent = root;
    let currentPath = '';

    for (let index = 0; index < parts.length - 1; index += 1) {
      const segment = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = {
          kind: 'folder',
          path: currentPath,
          name: segment,
          children: [],
        };
        folderMap.set(currentPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }

    parent.children.push({
      kind: 'file',
      path: entry.path,
      name: parts[parts.length - 1]!,
      entry,
    });
  }

  sortDirectoryTree(root.children);
  return root;
}

export function collectDirectoryTreeFolderPaths<TEntry extends DirectoryTreeEntry>(
  node: DirectoryTreeFolderNode<TEntry>,
  out: Set<string>,
): void {
  for (const child of node.children) {
    if (child.kind !== 'folder') continue;
    out.add(child.path);
    collectDirectoryTreeFolderPaths(child, out);
  }
}

export function DirectoryTree<TEntry extends DirectoryTreeEntry>({
  nodes,
  depth = 0,
  isFolderCollapsed,
  renderFolder,
  renderFile,
  renderFolderChildren,
  renderAfterChildren,
}: DirectoryTreeProps<TEntry>) {
  return nodes.map((node) => {
    if (node.kind === 'folder') {
      const collapsed = isFolderCollapsed?.(node) ?? false;
      const children = collapsed ? null : (
        <>
          <DirectoryTree
            nodes={node.children}
            depth={depth + 1}
            isFolderCollapsed={isFolderCollapsed}
            renderFolder={renderFolder}
            renderFile={renderFile}
            renderFolderChildren={renderFolderChildren}
            renderAfterChildren={renderAfterChildren}
          />
          {renderAfterChildren?.(node, depth + 1)}
        </>
      );
      const wrappedChildren =
        children && renderFolderChildren ? renderFolderChildren(node, depth + 1, children) : children;
      return (
        <div key={`tree:${node.path}`}>
          {renderFolder(node, depth, collapsed)}
          {wrappedChildren}
        </div>
      );
    }
    return <div key={`tree:${node.path}`}>{renderFile(node, depth)}</div>;
  });
}
