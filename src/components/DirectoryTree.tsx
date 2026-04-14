import type { ComponentChildren } from 'preact';
import type {
  DirectoryTreeEntry,
  DirectoryTreeFileNode,
  DirectoryTreeFolderNode,
  DirectoryTreeNode,
} from '../directory_tree';

export {
  buildDirectoryTree,
  collectDirectoryTreeFolderPaths,
  DIRECTORY_TREE_CHEVRON_SIZE,
  DIRECTORY_TREE_INDENT_PX,
  type DirectoryTreeEntry,
  type DirectoryTreeFileNode,
  type DirectoryTreeFolderNode,
  type DirectoryTreeNode,
  findFirstDirectoryTreeFile,
} from '../directory_tree';

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
