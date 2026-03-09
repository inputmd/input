import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileCode,
  FileJson,
  FileText,
  FolderClosed,
  FolderOpen,
  Image,
} from 'lucide-react';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

export interface SidebarFile {
  path: string;
  active: boolean;
  editable: boolean;
  deemphasized: boolean;
  size?: number;
}

export type SidebarFileFilter = 'text' | 'all';

interface SidebarProps {
  files: SidebarFile[];
  textFileCount: number;
  totalFileCount: number;
  fileFilter: SidebarFileFilter;
  onFileFilterChange: (value: SidebarFileFilter) => void;
  disabled?: boolean;
  readOnly?: boolean;
  onSelectFile: (path: string) => void;
  onEditFile: (path: string) => void;
  onViewOnGitHub: (path: string) => void;
  onViewFolderOnGitHub: (path: string) => void;
  canViewOnGitHub: boolean;
  onCreateFile: (path: string) => void | Promise<void>;
  onCreateDirectory: (path: string) => void | Promise<void>;
  onDeleteFile: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  onBeforeRenameFile?: (path: string) => boolean | Promise<boolean>;
  onRenameFile: (oldPath: string, newPath: string) => void | Promise<void>;
  onRenameFolder: (oldPath: string, newPath: string) => void | Promise<void>;
  onMoveFile: (filePath: string, targetFolderPath: string) => void | Promise<void>;
}

interface SidebarFileNode {
  kind: 'file';
  path: string;
  name: string;
  active: boolean;
  editable: boolean;
  deemphasized: boolean;
  size?: number;
}

interface SidebarFolderNode {
  kind: 'folder';
  path: string;
  name: string;
  deemphasized: boolean;
  hasActiveDescendant: boolean;
  children: SidebarTreeNode[];
}

type SidebarTreeNode = SidebarFileNode | SidebarFolderNode;
type RenameTarget = { kind: 'file' | 'folder'; path: string } | null;
type CreateKind = 'file' | 'directory';
type SidebarVisibleNode = {
  kind: 'file' | 'folder';
  path: string;
  parentPath: string | null;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
};

const INDENT_PX = 16;
const ICON_SIZE = 15;
const CHEVRON_SIZE = 14;

function getFileIcon(name: string, size?: number) {
  if (size === 0) return File;
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.md':
    case '.mdx':
    case '.txt':
      return FileText;
    case '.json':
    case '.jsonc':
      return FileJson;
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
    case '.css':
    case '.scss':
    case '.html':
    case '.vue':
    case '.svelte':
    case '.py':
    case '.rb':
    case '.go':
    case '.rs':
    case '.java':
    case '.c':
    case '.cpp':
    case '.h':
    case '.sh':
    case '.yaml':
    case '.yml':
    case '.toml':
    case '.xml':
      return FileCode;
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.svg':
    case '.webp':
    case '.ico':
      return Image;
    default:
      return File;
  }
}

function sanitizePathInput(input: string): string {
  const normalized = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return '';
  return normalized;
}

function sanitizeCreateNameInput(input: string): string {
  const normalized = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';
  if (normalized.includes('/') || normalized === '.' || normalized === '..') return '';
  return normalized;
}

function createParentDisplayPrefix(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  return `${parts[parts.length - 1]}/`;
}

function isKeepMarkerPath(path: string): boolean {
  return /(?:^|\/)\.keep$/i.test(path);
}

function sortNodes(nodes: SidebarTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === 'folder') sortNodes(node.children);
  }
}

function buildTree(files: SidebarFile[]): SidebarFolderNode {
  const root: SidebarFolderNode = {
    kind: 'folder',
    path: '',
    name: '',
    deemphasized: false,
    hasActiveDescendant: false,
    children: [],
  };
  const folderMap = new Map<string, SidebarFolderNode>();
  folderMap.set('', root);
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let parent = root;
    let currentPath = '';
    const ancestors: SidebarFolderNode[] = [];

    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = {
          kind: 'folder',
          path: currentPath,
          name: segment,
          deemphasized: isHiddenFolderPath(currentPath),
          hasActiveDescendant: false,
          children: [],
        };
        folderMap.set(currentPath, folder);
        parent.children.push(folder);
      }
      ancestors.push(folder);
      parent = folder;
    }

    if (file.active) {
      for (const folder of ancestors) {
        folder.hasActiveDescendant = true;
      }
    }

    if (isKeepMarkerPath(file.path)) continue;

    parent.children.push({
      kind: 'file',
      path: file.path,
      name: parts[parts.length - 1],
      active: file.active,
      editable: file.editable,
      deemphasized: file.deemphasized || isHiddenFolderPath(file.path),
      size: file.size,
    });
  }

  sortNodes(root.children);
  return root;
}

function collectFolderPaths(node: SidebarFolderNode, out: Set<string>): void {
  for (const child of node.children) {
    if (child.kind !== 'folder') continue;
    out.add(child.path);
    collectFolderPaths(child, out);
  }
}

function folderAncestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    ancestors.push(acc);
  }
  return ancestors;
}

function isHiddenFolderPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

function defaultCollapsedFolderPaths(folderPaths: Set<string>): Set<string> {
  const collapseAllByDefault = folderPaths.size > 10;
  const defaults = new Set<string>();
  for (const path of folderPaths) {
    if (!collapseAllByDefault && !isHiddenFolderPath(path)) continue;
    defaults.add(path);
  }
  return defaults;
}

function collapsedFolderRecord(paths: Iterable<string>): Record<string, true> {
  const record: Record<string, true> = {};
  for (const path of paths) record[path] = true;
  return record;
}

function resolveRenamePath(oldPath: string, input: string): string {
  const next = sanitizePathInput(input);
  if (!next) return '';
  if (next.includes('/')) return next;
  const slash = oldPath.lastIndexOf('/');
  if (slash === -1) return next;
  return `${oldPath.slice(0, slash + 1)}${next}`;
}

function parentFolderPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function resolveCreatePath(parentPath: string, input: string): string {
  const folder = sanitizePathInput(parentPath);
  const name = sanitizeCreateNameInput(input);
  if (!name) return '';
  return folder ? `${folder}/${name}` : name;
}

function hasSidebarTextExtension(name: string): boolean {
  return /\.(?:md(?:own|wn)?|markdown|txt|ts|js|py|tsx|jsx|json|jsonc|yml|yaml|toml|css|scss|html|sh|sql|xml|csv|mdx|rst)$/i.test(
    name,
  );
}

function normalizeCreateFileName(name: string, fileFilter: SidebarFileFilter): string {
  const sanitized = sanitizeCreateNameInput(name);
  if (!sanitized) return '';
  if (fileFilter !== 'text') return sanitized;
  return hasSidebarTextExtension(sanitized) ? sanitized : `${sanitized}.md`;
}

function flattenVisibleTree(
  nodes: SidebarTreeNode[],
  collapsedFolders: Record<string, true>,
  depth = 0,
  parentPath: string | null = null,
): SidebarVisibleNode[] {
  const visible: SidebarVisibleNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      const collapsed = Boolean(collapsedFolders[node.path]);
      const hasChildren = node.children.length > 0;
      visible.push({
        kind: 'folder',
        path: node.path,
        parentPath,
        depth,
        hasChildren,
        collapsed,
      });
      if (!collapsed && hasChildren) {
        visible.push(...flattenVisibleTree(node.children, collapsedFolders, depth + 1, node.path));
      }
      continue;
    }
    visible.push({
      kind: 'file',
      path: node.path,
      parentPath,
      depth,
      hasChildren: false,
      collapsed: false,
    });
  }
  return visible;
}

function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  const guides = [];
  for (let i = 0; i < depth; i++) {
    guides.push(
      <span key={i} class="sidebar-indent-guide" style={{ left: `${12 + i * INDENT_PX}px` }} aria-hidden="true" />,
    );
  }
  return <>{guides}</>;
}

export function Sidebar({
  files,
  textFileCount,
  totalFileCount,
  fileFilter,
  onFileFilterChange,
  disabled = false,
  readOnly = false,
  onSelectFile,
  onEditFile,
  onViewOnGitHub,
  onViewFolderOnGitHub,
  canViewOnGitHub,
  onCreateFile,
  onCreateDirectory,
  onDeleteFile,
  onDeleteFolder,
  onBeforeRenameFile,
  onRenameFile,
  onRenameFolder,
  onMoveFile,
}: SidebarProps) {
  const [creatingNew, setCreatingNew] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind>('file');
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [createParentPath, setCreateParentPath] = useState('');
  const [renamingTarget, setRenamingTarget] = useState<RenameTarget>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggingFilePath, setDraggingFilePath] = useState<string | null>(null);
  const [dropFolderPath, setDropFolderPath] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const newInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInFlightRef = useRef(false);
  const renameInFlightRef = useRef(false);
  const cancelCreateOnBlurRef = useRef(false);
  const cancelRenameOnBlurRef = useRef(false);

  const tree = useMemo(() => buildTree(files), [files]);
  const folderPaths = useMemo(() => {
    const paths = new Set<string>();
    collectFolderPaths(tree, paths);
    return paths;
  }, [tree]);
  const defaultCollapsedPaths = useMemo(() => defaultCollapsedFolderPaths(folderPaths), [folderPaths]);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, true>>(() =>
    collapsedFolderRecord(defaultCollapsedPaths),
  );
  const autoCollapsedDefaultsRef = useRef<Set<string>>(new Set(defaultCollapsedPaths));
  const activeFilePath = useMemo(() => files.find((file) => file.active)?.path ?? null, [files]);
  const activeAncestors = useMemo(() => (activeFilePath ? folderAncestors(activeFilePath) : []), [activeFilePath]);
  const hasFolders = folderPaths.size > 0;
  const visibleNodes = useMemo(() => flattenVisibleTree(tree.children, collapsedFolders), [tree, collapsedFolders]);
  const visibleIndexByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const [index, node] of visibleNodes.entries()) map.set(node.path, index);
    return map;
  }, [visibleNodes]);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [createAtRoot, setCreateAtRoot] = useState(false);

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus();
  }, [creatingNew]);

  useEffect(() => {
    if (!creatingNew || !createParentPath) return;
    if (folderPaths.has(createParentPath)) return;
    setCreateParentPath('');
  }, [createParentPath, creatingNew, folderPaths]);

  useEffect(() => {
    if (renamingTarget) renameInputRef.current?.focus();
  }, [renamingTarget]);

  useEffect(() => {
    if (visibleNodes.length === 0) {
      setFocusedPath(null);
      return;
    }
    setFocusedPath((prev) => {
      if (prev && visibleIndexByPath.has(prev)) return prev;
      if (activeFilePath && visibleIndexByPath.has(activeFilePath)) return activeFilePath;
      return visibleNodes[0]?.path ?? null;
    });
  }, [activeFilePath, visibleIndexByPath, visibleNodes]);

  useEffect(() => {
    setCollapsedFolders((prev) => {
      const next: Record<string, true> = {};
      let changed = false;
      for (const [path, collapsed] of Object.entries(prev)) {
        if (collapsed && folderPaths.has(path)) next[path] = true;
        else changed = true;
      }
      for (const path of Array.from(autoCollapsedDefaultsRef.current)) {
        if (!folderPaths.has(path)) autoCollapsedDefaultsRef.current.delete(path);
      }
      for (const path of defaultCollapsedPaths) {
        if (autoCollapsedDefaultsRef.current.has(path)) continue;
        autoCollapsedDefaultsRef.current.add(path);
        if (!next[path]) {
          next[path] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [defaultCollapsedPaths, folderPaths]);

  useEffect(() => {
    if (activeAncestors.length === 0) return;
    setCollapsedFolders((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const path of activeAncestors) {
        if (next[path]) {
          delete next[path];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeAncestors]);

  const handleCreateSubmit = async () => {
    if (createInFlightRef.current) return;
    const createName = createKind === 'directory' ? newFileName : normalizeCreateFileName(newFileName, fileFilter);
    const path = resolveCreatePath(createParentPath, createName);
    if (!path) return;

    createInFlightRef.current = true;
    setCreatingFile(true);
    try {
      if (createKind === 'directory') await onCreateDirectory(path);
      else await onCreateFile(path);
      setNewFileName('');
      setCreateParentPath('');
      setCreatingNew(false);
    } finally {
      createInFlightRef.current = false;
      setCreatingFile(false);
    }
  };

  const startCreate = (kind: CreateKind, parentPath = '') => {
    cancelCreateOnBlurRef.current = false;
    setCreateKind(kind);
    const resolvedParentPath = sanitizePathInput(parentPath);
    setCreateParentPath(resolvedParentPath);
    if (resolvedParentPath && collapsedFolders[resolvedParentPath]) {
      setCollapsedFolders((prev) => {
        if (!prev[resolvedParentPath]) return prev;
        const next = { ...prev };
        delete next[resolvedParentPath];
        return next;
      });
    }
    setCreatingNew(true);
    setNewFileName('');
  };

  const handleRenameSubmit = async () => {
    if (!renamingTarget || renameInFlightRef.current) return;
    cancelRenameOnBlurRef.current = false;
    renameInFlightRef.current = true;
    const target = renamingTarget;
    const oldPath = target.path;
    const newPath = resolveRenamePath(oldPath, renameValue);
    setRenamingTarget(null);
    setRenameValue('');
    try {
      if (newPath && newPath !== oldPath) {
        if (target.kind === 'file') {
          await onRenameFile(oldPath, newPath);
        } else {
          await onRenameFolder(oldPath, newPath);
        }
      }
    } finally {
      renameInFlightRef.current = false;
    }
  };

  const startRename = async (target: Exclude<RenameTarget, null>) => {
    if (target.kind === 'file' && onBeforeRenameFile) {
      const allowed = await onBeforeRenameFile(target.path);
      if (!allowed) return;
    }
    cancelRenameOnBlurRef.current = false;
    setRenamingTarget(target);
    setRenameValue(target.path);
  };

  const toggleFolder = (path: string) => {
    setCollapsedFolders((prev) => {
      if (prev[path]) {
        const next = { ...prev };
        delete next[path];
        return next;
      }
      return { ...prev, [path]: true };
    });
  };

  const focusTreeRow = (path: string) => {
    setCreateAtRoot(false);
    setFocusedPath(path);
    rowRefs.current[path]?.focus();
  };

  const focusNextVisibleOffset = (offset: number) => {
    if (!focusedPath || visibleNodes.length === 0) return;
    const index = visibleIndexByPath.get(focusedPath);
    if (index === undefined) return;
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= visibleNodes.length) return;
    const target = visibleNodes[targetIndex];
    if (!target) return;
    focusTreeRow(target.path);
  };

  const firstChildPath = (folderPath: string): string | null => {
    const folderIndex = visibleIndexByPath.get(folderPath);
    if (folderIndex === undefined) return null;
    const folderNode = visibleNodes[folderIndex];
    const childNode = visibleNodes[folderIndex + 1];
    if (!folderNode || !childNode) return null;
    if (childNode.parentPath !== folderNode.path) return null;
    return childNode.path;
  };

  const resolveCreateParentFromFocus = (): string => {
    if (createAtRoot) return '';
    if (!focusedPath) return '';
    const index = visibleIndexByPath.get(focusedPath);
    if (index === undefined) return '';
    const node = visibleNodes[index];
    if (!node) return '';
    return node.kind === 'folder' ? node.path : parentFolderPath(node.path);
  };

  const handleFilesKeyDown = (e: KeyboardEvent) => {
    const targetElement = e.target as HTMLElement | null;
    if (targetElement?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (!focusedPath || visibleNodes.length === 0) return;
    const currentIndex = visibleIndexByPath.get(focusedPath);
    if (currentIndex === undefined) return;
    const current = visibleNodes[currentIndex];
    if (!current) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusNextVisibleOffset(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusNextVisibleOffset(-1);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      const first = visibleNodes[0];
      if (first) focusTreeRow(first.path);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      const last = visibleNodes[visibleNodes.length - 1];
      if (last) focusTreeRow(last.path);
      return;
    }
    if (e.key === 'ArrowRight') {
      if (current.kind !== 'folder') return;
      e.preventDefault();
      if (current.collapsed) {
        toggleFolder(current.path);
        return;
      }
      const childPath = firstChildPath(current.path);
      if (childPath) focusTreeRow(childPath);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (current.kind === 'folder' && !current.collapsed && current.hasChildren) {
        toggleFolder(current.path);
        return;
      }
      if (current.parentPath) focusTreeRow(current.parentPath);
    }
  };

  const allFilesAreText = totalFileCount > 0 && textFileCount === totalFileCount;
  const filterLabel =
    fileFilter === 'text'
      ? allFilesAreText
        ? 'Text files'
        : `Text files (${textFileCount}/${totalFileCount})`
      : `All files (${totalFileCount})`;
  const filterControl = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" class="sidebar-filter-trigger" title={filterLabel} aria-label="Sidebar file filter">
          <ChevronDown size={12} class="sidebar-filter-trigger-icon" aria-hidden="true" />
          {filterLabel}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="sidebar-filter-menu" sideOffset={6} align="start">
          <DropdownMenu.RadioGroup
            value={fileFilter}
            onValueChange={(value: string) => onFileFilterChange(value as SidebarFileFilter)}
          >
            <DropdownMenu.RadioItem class="sidebar-filter-menu-item" value="text">
              Text files
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem class="sidebar-filter-menu-item" value="all">
              All files
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  const clearDragState = () => {
    setDraggingFilePath(null);
    setDropFolderPath(null);
  };

  const resolveDraggedPath = (event: DragEvent): string | null => {
    const dataPath = event.dataTransfer?.getData('text/plain') ?? '';
    const candidate = dataPath || draggingFilePath || '';
    if (!candidate) return null;
    return files.some((file) => file.path === candidate) ? candidate : null;
  };

  const handleDropToFolder = async (event: DragEvent, targetFolderPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedPath = resolveDraggedPath(event);
    clearDragState();
    if (!draggedPath) return;
    if (parentFolderPath(draggedPath) === targetFolderPath) return;
    await onMoveFile(draggedPath, targetFolderPath);
  };

  const handleSidebarBackgroundClick = (event: MouseEvent) => {
    if (event.target !== event.currentTarget) return;
    setCreateAtRoot(true);
    setFocusedPath(null);
  };

  const renderFolderRow = (folder: SidebarFolderNode, depth: number) => {
    const collapsed = Boolean(collapsedFolders[folder.path]);
    const isRenaming = renamingTarget?.kind === 'folder' && renamingTarget.path === folder.path;
    const FolderIcon = collapsed ? FolderClosed : FolderOpen;
    const isDropTarget = draggingFilePath !== null && dropFolderPath === folder.path;
    const folderRow = (
      <div
        class={`sidebar-file sidebar-folder${folder.hasActiveDescendant ? ' has-active-descendant' : ''}${isRenaming ? ' renaming' : ''}${folder.deemphasized ? ' sidebar-file-deemphasized' : ''}${isDropTarget ? ' drop-target' : ''}`}
        ref={(el) => {
          rowRefs.current[folder.path] = el;
        }}
        tabIndex={focusedPath === folder.path ? 0 : -1}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={!collapsed}
        aria-selected={folder.hasActiveDescendant || undefined}
        data-folder-path={folder.path}
        style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        onClick={() => toggleFolder(folder.path)}
        onFocus={() => {
          setCreateAtRoot(false);
          setFocusedPath(folder.path);
        }}
        onDragOver={(e) => {
          if (readOnly || !draggingFilePath) return;
          e.preventDefault();
          if (dropFolderPath !== folder.path) setDropFolderPath(folder.path);
        }}
        onDragLeave={(e) => {
          if (!draggingFilePath) return;
          const nextTarget = e.relatedTarget as Node | null;
          if (nextTarget && (e.currentTarget as HTMLElement).contains(nextTarget)) return;
          if (dropFolderPath === folder.path) setDropFolderPath(null);
        }}
        onDrop={(e) => {
          if (readOnly) return;
          void handleDropToFolder(e, folder.path);
        }}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleFolder(folder.path);
          } else if (!readOnly && e.key === 'F2') {
            e.preventDefault();
            void startRename({ kind: 'folder', path: folder.path });
          }
        }}
      >
        <IndentGuides depth={depth} />
        <span class={`sidebar-folder-caret${collapsed ? '' : ' open'}`} aria-hidden="true">
          <ChevronRight size={CHEVRON_SIZE} />
        </span>
        <FolderIcon size={ICON_SIZE} class="sidebar-node-icon" aria-hidden="true" />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            class="sidebar-rename-input"
            type="text"
            value={renameValue}
            onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRenameSubmit();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelRenameOnBlurRef.current = true;
                setRenamingTarget(null);
                setRenameValue('');
              }
            }}
            onBlur={() => {
              if (cancelRenameOnBlurRef.current) {
                cancelRenameOnBlurRef.current = false;
                return;
              }
              void handleRenameSubmit();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span class="sidebar-folder-name">{folder.name}</span>
        )}
      </div>
    );

    const showViewOnlyContext = readOnly && canViewOnGitHub;
    if (readOnly && !showViewOnlyContext) {
      return <div key={`folder:${folder.path}`}>{folderRow}</div>;
    }

    return (
      <ContextMenu.Root key={`folder:${folder.path}`}>
        <ContextMenu.Trigger asChild>{folderRow}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content class="sidebar-context-menu" sideOffset={6} align="start">
            {!readOnly && (
              <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => startCreate('file', folder.path)}>
                Add file
              </ContextMenu.Item>
            )}
            {!readOnly && (
              <ContextMenu.Item
                class="sidebar-context-menu-item"
                onSelect={() => startCreate('directory', folder.path)}
              >
                Add directory
              </ContextMenu.Item>
            )}
            {!readOnly && (
              <ContextMenu.Item
                class="sidebar-context-menu-item"
                onSelect={() => void startRename({ kind: 'folder', path: folder.path })}
              >
                Rename
              </ContextMenu.Item>
            )}
            {canViewOnGitHub && (
              <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => onViewFolderOnGitHub(folder.path)}>
                View on GitHub <ExternalLink size={14} className="sidebar-context-menu-item-icon" aria-hidden="true" />
              </ContextMenu.Item>
            )}
            {!readOnly && (
              <>
                <ContextMenu.Separator class="sidebar-context-menu-separator" />
                <ContextMenu.Item
                  class="sidebar-context-menu-item sidebar-context-menu-item-danger"
                  onSelect={() => onDeleteFolder(folder.path)}
                >
                  Delete
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  };

  const renderFileRow = (file: SidebarFileNode, depth: number) => {
    const isRenaming = renamingTarget?.kind === 'file' && renamingTarget.path === file.path;
    const FileIcon = getFileIcon(file.name, file.size);
    const rootNoFolderOffset = !hasFolders && depth === 0 ? -12 : 0;
    const fileRow = (
      <div
        class={`sidebar-file${file.active ? ' active' : ''}${isRenaming ? ' renaming' : ''}${file.deemphasized ? ' sidebar-file-deemphasized' : ''}${draggingFilePath === file.path ? ' dragging' : ''}`}
        ref={(el) => {
          rowRefs.current[file.path] = el;
        }}
        tabIndex={focusedPath === file.path ? 0 : -1}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={file.active}
        aria-current={file.active ? 'true' : undefined}
        draggable={!readOnly && file.editable && !isRenaming}
        style={{ paddingLeft: `${8 + depth * INDENT_PX + CHEVRON_SIZE + 6 + rootNoFolderOffset}px` }}
        onClick={() => !file.active && onSelectFile(file.path)}
        onFocus={() => {
          setCreateAtRoot(false);
          setFocusedPath(file.path);
        }}
        onDblClick={() => {
          if (!readOnly && file.editable) void startRename({ kind: 'file', path: file.path });
        }}
        onDragStart={(e) => {
          if (readOnly || !file.editable || isRenaming) {
            e.preventDefault();
            return;
          }
          e.dataTransfer?.setData('text/plain', file.path);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          setDraggingFilePath(file.path);
        }}
        onDragEnd={() => {
          clearDragState();
        }}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!file.active) onSelectFile(file.path);
          } else if (!readOnly && file.editable && e.key === 'F2') {
            e.preventDefault();
            void startRename({ kind: 'file', path: file.path });
          }
        }}
      >
        <IndentGuides depth={depth} />
        <FileIcon size={ICON_SIZE} class="sidebar-node-icon" aria-hidden="true" />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            class="sidebar-rename-input"
            type="text"
            value={renameValue}
            onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRenameSubmit();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelRenameOnBlurRef.current = true;
                setRenamingTarget(null);
                setRenameValue('');
              }
            }}
            onBlur={() => {
              if (cancelRenameOnBlurRef.current) {
                cancelRenameOnBlurRef.current = false;
                return;
              }
              void handleRenameSubmit();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span class="sidebar-file-name">{file.name}</span>
        )}
      </div>
    );

    const showFileModifyActions = !readOnly;
    const showEditAction = !readOnly && file.editable;
    const showViewOnlyContext = readOnly && canViewOnGitHub;
    if (!showFileModifyActions && !showViewOnlyContext) {
      return <div key={`file:${file.path}`}>{fileRow}</div>;
    }

    return (
      <ContextMenu.Root key={`file:${file.path}`}>
        <ContextMenu.Trigger asChild>{fileRow}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content class="sidebar-context-menu" sideOffset={6} align="start">
            {showEditAction && (
              <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => onEditFile(file.path)}>
                Edit
              </ContextMenu.Item>
            )}
            {showFileModifyActions && (
              <ContextMenu.Item
                class="sidebar-context-menu-item"
                onSelect={() => void startRename({ kind: 'file', path: file.path })}
              >
                Rename
              </ContextMenu.Item>
            )}
            {canViewOnGitHub && (
              <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => onViewOnGitHub(file.path)}>
                View on GitHub <ExternalLink size={14} className="sidebar-context-menu-item-icon" aria-hidden="true" />
              </ContextMenu.Item>
            )}
            {showFileModifyActions && (
              <>
                <ContextMenu.Separator class="sidebar-context-menu-separator" />
                <ContextMenu.Item
                  class="sidebar-context-menu-item sidebar-context-menu-item-danger"
                  onSelect={() => onDeleteFile(file.path)}
                >
                  Delete
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  };

  const renderNodes = (nodes: SidebarTreeNode[], depth: number): ComponentChildren =>
    nodes.map((node) => {
      if (node.kind === 'folder') {
        const collapsed = Boolean(collapsedFolders[node.path]);
        return (
          <div key={`tree:${node.path}`}>
            {renderFolderRow(node, depth)}
            {collapsed ? null : (
              <div class="sidebar-folder-children" role="group">
                <div class="sidebar-folder-children-inner">
                  {renderNodes(node.children, depth + 1)}
                  {creatingNew && createParentPath === node.path && renderCreateRow(depth + 1)}
                </div>
              </div>
            )}
          </div>
        );
      }
      return renderFileRow(node, depth);
    });

  const renderCreateRow = (depth: number) => {
    const rootNoFolderOffset = !hasFolders && depth === 0 ? -12 : 0;
    const createPrefix = createParentDisplayPrefix(createParentPath);
    return (
      <div
        class="sidebar-file renaming"
        style={{ paddingLeft: `${8 + depth * INDENT_PX + CHEVRON_SIZE + 6 + rootNoFolderOffset}px` }}
      >
        <IndentGuides depth={depth} />
        {createKind === 'directory' ? (
          <FolderClosed size={ICON_SIZE} class="sidebar-node-icon" aria-hidden="true" />
        ) : (
          <File size={ICON_SIZE} class="sidebar-node-icon" aria-hidden="true" />
        )}
        {createPrefix ? <span class="sidebar-create-prefix">{createPrefix}</span> : null}
        <input
          ref={newInputRef}
          class="sidebar-rename-input"
          type="text"
          placeholder={createKind === 'directory' ? 'new-folder' : 'notes.md'}
          value={newFileName}
          disabled={creatingFile}
          onInput={(e) => setNewFileName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleCreateSubmit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancelCreateOnBlurRef.current = true;
              setCreateParentPath('');
              setCreatingNew(false);
              setNewFileName('');
            }
          }}
          onBlur={() => {
            if (cancelCreateOnBlurRef.current) {
              cancelCreateOnBlurRef.current = false;
              return;
            }
            if (newFileName.trim()) void handleCreateSubmit();
            else {
              setCreateParentPath('');
              setCreatingNew(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  };

  if (disabled) {
    return (
      <aside class="sidebar">
        <div class="sidebar-header">{filterControl}</div>
        <div class="sidebar-files sidebar-files-disabled">
          <p class="sidebar-disabled-message">Empty workspace</p>
        </div>
      </aside>
    );
  }

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        {filterControl}
        {!readOnly && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" class="sidebar-add-btn" title="Add">
                <span class="sidebar-add-btn-icon">+</span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="sidebar-filter-menu" sideOffset={6} align="end">
                <DropdownMenu.Item
                  class="sidebar-filter-menu-item"
                  onSelect={() => startCreate('file', resolveCreateParentFromFocus())}
                >
                  Add file
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="sidebar-filter-menu-item"
                  onSelect={() => startCreate('directory', resolveCreateParentFromFocus())}
                >
                  Add directory
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
      <div
        class={`sidebar-files${files.length === 0 && !creatingNew ? ' sidebar-files-empty' : ''}${draggingFilePath && dropFolderPath === '' ? ' drop-target-root' : ''}`}
        role="tree"
        aria-label="Workspace files"
        onKeyDown={handleFilesKeyDown}
        onClick={handleSidebarBackgroundClick}
        onDragOver={(e) => {
          if (readOnly || !draggingFilePath) return;
          e.preventDefault();
          const target = e.target as HTMLElement | null;
          if (!target?.closest('[data-folder-path]')) setDropFolderPath('');
        }}
        onDrop={(e) => {
          if (readOnly || !draggingFilePath) return;
          const target = e.target as HTMLElement | null;
          if (target?.closest('[data-folder-path]')) return;
          void handleDropToFolder(e, '');
        }}
      >
        {renderNodes(tree.children, 0)}
        {files.length === 0 && !creatingNew && <p class="sidebar-empty-message">No files</p>}
        {!readOnly && creatingNew && createParentPath === '' && renderCreateRow(0)}
      </div>
    </aside>
  );
}
