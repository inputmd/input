import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
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
  MoreVertical,
  Plus,
} from 'lucide-react';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils';
import type { RepoWorkspaceChangedFileDetail } from '../repo_workspace/commit';
import { loadSidebarCollapsedFoldersState, persistSidebarCollapsedFolders } from '../sidebar_state';

export interface SidebarFile {
  path: string;
  active: boolean;
  editable: boolean;
  deemphasized: boolean;
  changeState?: 'new' | 'modified';
  virtual?: boolean;
  size?: number;
}

export type SidebarFileFilter = 'markdown' | 'text' | 'all';

export interface SidebarProps {
  workspaceKey: string;
  files: SidebarFile[];
  stagedChangeCount?: number;
  stagedChangeFiles?: RepoWorkspaceChangedFileDetail[] | null;
  onSaveStagedChanges?: () => void | Promise<void>;
  onDiscardStagedChanges?: () => void | Promise<void>;
  hasOpenFile?: boolean;
  markdownFileCount: number;
  textFileCount: number;
  totalFileCount: number;
  fileFilter: SidebarFileFilter;
  onFileFilterChange: (value: SidebarFileFilter) => void;
  disabled?: boolean;
  readOnly?: boolean;
  showDailyNoteAction?: boolean;
  onSelectFile: (path: string) => void;
  onClearSelection?: () => void;
  onViewOnGitHub: (path: string) => void;
  onViewFolderOnGitHub: (path: string) => void;
  canViewOnGitHub: boolean;
  onOpenDailyNote: () => void | Promise<void>;
  onCreateFile: (path: string) => void | Promise<void>;
  onConfirmImplicitMarkdownExtension?: (fileName: string) => boolean | Promise<boolean>;
  onCreateScratchFile: (parentPath: string) => void | Promise<void>;
  onCreateDirectory: (path: string) => void | Promise<void>;
  onDeleteFile: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  onBeforeRenameFile?: (path: string) => boolean | Promise<boolean>;
  onRenameFile: (oldPath: string, newPath: string) => void | Promise<void>;
  onRenameFolder: (oldPath: string, newPath: string) => void | Promise<void>;
  onMoveFile: (filePath: string, targetFolderPath: string) => void | Promise<void>;
  onMoveFolder: (folderPath: string, targetFolderPath: string) => void | Promise<void>;
  onUploadFile?: (file: globalThis.File, targetFolderPath: string) => void | Promise<void>;
}

interface SidebarFileNode {
  kind: 'file';
  path: string;
  name: string;
  active: boolean;
  editable: boolean;
  deemphasized: boolean;
  changeState?: 'new' | 'modified';
  virtual: boolean;
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
type DraggedSidebarItem = { kind: 'file' | 'folder'; path: string } | null;
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
      changeState: file.changeState,
      virtual: file.virtual === true,
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

function fileNameFromPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
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
  if (fileFilter === 'all') return sanitized;
  return hasSidebarTextExtension(sanitized) ? sanitized : `${sanitized}.md`;
}

function hasExplicitFileExtension(name: string): boolean {
  return /\.[^./\s]+$/.test(name);
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
      <span key={i} class="sidebar-indent-guide" style={{ left: `${14.5 + i * INDENT_PX}px` }} aria-hidden="true" />,
    );
  }
  return <>{guides}</>;
}

export function Sidebar({
  workspaceKey,
  files,
  stagedChangeCount = 0,
  stagedChangeFiles = null,
  onSaveStagedChanges,
  onDiscardStagedChanges,
  hasOpenFile = false,
  markdownFileCount,
  textFileCount,
  totalFileCount,
  fileFilter,
  onFileFilterChange,
  disabled = false,
  readOnly = false,
  showDailyNoteAction = false,
  onSelectFile,
  onClearSelection,
  onViewOnGitHub,
  onViewFolderOnGitHub,
  canViewOnGitHub,
  onOpenDailyNote,
  onCreateFile,
  onConfirmImplicitMarkdownExtension,
  onCreateScratchFile,
  onCreateDirectory,
  onDeleteFile,
  onDeleteFolder,
  onBeforeRenameFile,
  onRenameFile,
  onRenameFolder,
  onMoveFile,
  onMoveFolder,
  onUploadFile,
}: SidebarProps) {
  const [creatingNew, setCreatingNew] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind>('file');
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [createParentPath, setCreateParentPath] = useState('');
  const [renamingTarget, setRenamingTarget] = useState<RenameTarget>(null);
  const [renamingInFlightTarget, setRenamingInFlightTarget] = useState<RenameTarget>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggingItem, setDraggingItem] = useState<DraggedSidebarItem>(null);
  const [draggingExternalFile, setDraggingExternalFile] = useState(false);
  const [dropFolderPath, setDropFolderPath] = useState<string | null>(null);
  const [movingTarget, setMovingTarget] = useState<RenameTarget>(null);
  const [stagedChangesTooltipOpen, setStagedChangesTooltipOpen] = useState(false);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const newInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInFlightRef = useRef(false);
  const renameInFlightRef = useRef(false);
  const cancelCreateOnBlurRef = useRef(false);
  const cancelRenameOnBlurRef = useRef(false);
  const stagedChangesTooltipCloseTimeoutRef = useRef<number | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);
  const folderPaths = useMemo(() => {
    const paths = new Set<string>();
    collectFolderPaths(tree, paths);
    return paths;
  }, [tree]);
  const defaultCollapsedPaths = useMemo(() => defaultCollapsedFolderPaths(folderPaths), [folderPaths]);
  const activeFilePath = useMemo(() => files.find((file) => file.active)?.path ?? null, [files]);
  const stagedChangesText =
    stagedChangeCount > 0 ? `${stagedChangeCount} file${stagedChangeCount === 1 ? '' : 's'} changed` : null;
  const activeAncestors = useMemo(() => (activeFilePath ? folderAncestors(activeFilePath) : []), [activeFilePath]);
  const initialCollapsedFoldersState = useMemo(
    () => loadSidebarCollapsedFoldersState(workspaceKey, defaultCollapsedPaths, activeAncestors),
    [activeAncestors, defaultCollapsedPaths, workspaceKey],
  );
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, true>>(() => {
    return initialCollapsedFoldersState.collapsedFolders;
  });
  const autoCollapsedDefaultsRef = useRef<Set<string>>(new Set(defaultCollapsedPaths));
  const workspaceKeyRef = useRef(workspaceKey);
  const skipNextActiveAncestorsExpandRef = useRef(initialCollapsedFoldersState.loadedFromPersistence);
  const skipNextCollapsedFoldersPersistRef = useRef(false);
  const hasFolders = folderPaths.size > 0;
  const visibleNodes = useMemo(() => flattenVisibleTree(tree.children, collapsedFolders), [tree, collapsedFolders]);
  const visibleIndexByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const [index, node] of visibleNodes.entries()) map.set(node.path, index);
    return map;
  }, [visibleNodes]);

  useEffect(() => {
    return () => {
      if (stagedChangesTooltipCloseTimeoutRef.current !== null) {
        window.clearTimeout(stagedChangesTooltipCloseTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if ((stagedChangeFiles?.length ?? 0) > 0) return;
    if (stagedChangesTooltipCloseTimeoutRef.current !== null) {
      window.clearTimeout(stagedChangesTooltipCloseTimeoutRef.current);
      stagedChangesTooltipCloseTimeoutRef.current = null;
    }
    setStagedChangesTooltipOpen(false);
  }, [stagedChangeFiles]);

  const openStagedChangesTooltip = (): void => {
    if (stagedChangesTooltipCloseTimeoutRef.current !== null) {
      window.clearTimeout(stagedChangesTooltipCloseTimeoutRef.current);
      stagedChangesTooltipCloseTimeoutRef.current = null;
    }
    setStagedChangesTooltipOpen(true);
  };

  const closeStagedChangesTooltipSoon = (): void => {
    if (stagedChangesTooltipCloseTimeoutRef.current !== null) {
      window.clearTimeout(stagedChangesTooltipCloseTimeoutRef.current);
    }
    stagedChangesTooltipCloseTimeoutRef.current = window.setTimeout(() => {
      stagedChangesTooltipCloseTimeoutRef.current = null;
      setStagedChangesTooltipOpen(false);
    }, 120);
  };
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [createContextPath, setCreateContextPath] = useState<string | null>(null);
  const [createAtRoot, setCreateAtRoot] = useState(false);
  const hasHydratedFolderPathsRef = useRef(folderPaths.size > 0);
  const emptyFilterSuggestion = useMemo(() => {
    if (files.length !== 0 || creatingNew) return null;
    if (fileFilter === 'markdown' && textFileCount > 0) {
      return {
        buttonLabel: 'Show text files',
        nextFilter: 'text' as SidebarFileFilter,
      };
    }
    if (fileFilter === 'text' && totalFileCount > 0) {
      return {
        buttonLabel: 'Show all files',
        nextFilter: 'all' as SidebarFileFilter,
      };
    }
    return null;
  }, [creatingNew, fileFilter, files.length, textFileCount, totalFileCount]);

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus();
  }, [creatingNew]);

  useEffect(() => {
    if (!creatingNew || !createParentPath) return;
    if (folderPaths.has(createParentPath)) return;
    setCreateParentPath('');
  }, [createParentPath, creatingNew, folderPaths]);

  useEffect(() => {
    if (!renamingTarget) return;
    setRenameValue(fileNameFromPath(renamingTarget.path));
    const animationFrame = requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    return () => cancelAnimationFrame(animationFrame);
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
    if (workspaceKeyRef.current === workspaceKey) return;
    workspaceKeyRef.current = workspaceKey;

    const nextState = loadSidebarCollapsedFoldersState(workspaceKey, defaultCollapsedPaths, activeAncestors);
    skipNextActiveAncestorsExpandRef.current = nextState.loadedFromPersistence;
    skipNextCollapsedFoldersPersistRef.current = true;
    autoCollapsedDefaultsRef.current = new Set(defaultCollapsedPaths);
    hasHydratedFolderPathsRef.current = folderPaths.size > 0;
    setCollapsedFolders(nextState.collapsedFolders);
  }, [activeAncestors, defaultCollapsedPaths, folderPaths, workspaceKey]);

  useEffect(() => {
    if (folderPaths.size > 0) hasHydratedFolderPathsRef.current = true;
    if (folderPaths.size === 0 && !hasHydratedFolderPathsRef.current) return;
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
    if (skipNextActiveAncestorsExpandRef.current) {
      skipNextActiveAncestorsExpandRef.current = false;
      return;
    }
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

  useEffect(() => {
    if (folderPaths.size === 0 && !hasHydratedFolderPathsRef.current) return;
    if (skipNextCollapsedFoldersPersistRef.current) {
      skipNextCollapsedFoldersPersistRef.current = false;
      return;
    }
    persistSidebarCollapsedFolders(workspaceKey, collapsedFolders);
  }, [collapsedFolders, folderPaths, workspaceKey]);

  const handleCreateSubmit = async () => {
    if (createInFlightRef.current) return;
    const sanitizedCreateName = sanitizeCreateNameInput(newFileName);
    let createName = createKind === 'directory' ? newFileName : normalizeCreateFileName(newFileName, fileFilter);
    if (
      createKind === 'file' &&
      fileFilter !== 'all' &&
      sanitizedCreateName &&
      !hasExplicitFileExtension(sanitizedCreateName)
    ) {
      const shouldAddMarkdownExtension = onConfirmImplicitMarkdownExtension
        ? await onConfirmImplicitMarkdownExtension(sanitizedCreateName)
        : true;
      if (!shouldAddMarkdownExtension) return;
      createName = `${sanitizedCreateName}.md`;
    }
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

  const startCreateScratchFile = (parentPath = '') => {
    void onCreateScratchFile(sanitizePathInput(parentPath));
  };

  const handleRenameSubmit = async () => {
    if (!renamingTarget || renameInFlightRef.current) return;
    cancelRenameOnBlurRef.current = false;
    const target = renamingTarget;
    const oldPath = target.path;
    const newPath = resolveRenamePath(oldPath, renameValue);
    setRenamingTarget(null);
    setRenameValue('');
    if (!newPath || newPath === oldPath) return;

    renameInFlightRef.current = true;
    setRenamingInFlightTarget(target);
    try {
      if (target.kind === 'file') {
        await onRenameFile(oldPath, newPath);
      } else {
        await onRenameFolder(oldPath, newPath);
      }
    } finally {
      renameInFlightRef.current = false;
      setRenamingInFlightTarget((current) =>
        current?.path === target.path && current.kind === target.kind ? null : current,
      );
    }
  };

  const startRename = async (target: Exclude<RenameTarget, null>) => {
    if (target.kind === 'file' && onBeforeRenameFile) {
      const allowed = await onBeforeRenameFile(target.path);
      if (!allowed) return;
    }
    cancelRenameOnBlurRef.current = false;
    setRenamingTarget(target);
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

  const expandAllFolders = () => {
    setCollapsedFolders({});
  };

  const collapseAllFolders = () => {
    setCollapsedFolders(() => {
      const next: Record<string, true> = {};
      for (const path of folderPaths) next[path] = true;
      return next;
    });
  };

  const focusTreeRow = (path: string) => {
    setCreateAtRoot(false);
    setFocusedPath(path);
    setCreateContextPath(path);
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
    if (activeFilePath && visibleIndexByPath.has(activeFilePath)) {
      const activeNode = visibleNodes[visibleIndexByPath.get(activeFilePath) ?? -1];
      if (!activeNode) return '';
      return activeNode.kind === 'folder' ? activeNode.path : parentFolderPath(activeNode.path);
    }
    if (!createContextPath) return '';
    const index = visibleIndexByPath.get(createContextPath);
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

  const filterLabel = fileFilter === 'markdown' ? 'Markdown' : fileFilter === 'text' ? 'Text files' : 'All files';
  const filterControl = (
    <DropdownMenu.Root onOpenChange={blurOnClose}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          class="sidebar-filter-trigger"
          title={filterLabel}
          aria-label="Sidebar file filter"
          style={{ position: 'relative', left: '-2px' }}
        >
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
            <DropdownMenu.RadioItem class="sidebar-filter-menu-item" value="markdown">
              <span>Markdown</span>
              <span class="sidebar-filter-menu-item-count">{markdownFileCount}</span>
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem class="sidebar-filter-menu-item" value="text">
              <span>Text files</span>
              <span class="sidebar-filter-menu-item-count">{textFileCount}</span>
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem class="sidebar-filter-menu-item" value="all">
              <span>All files</span>
              <span class="sidebar-filter-menu-item-count">{totalFileCount}</span>
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  const clearDragState = () => {
    setDraggingItem(null);
    setDraggingExternalFile(false);
    setDropFolderPath(null);
  };

  const isExternalFileDrag = (event: DragEvent): boolean => {
    if (!onUploadFile) return false;
    const types = Array.from(event.dataTransfer?.types ?? []);
    return types.includes('Files');
  };

  const resolveDraggedItem = (event: DragEvent): DraggedSidebarItem => {
    const dataKind = event.dataTransfer?.getData('application/x-input-sidebar-node-kind') ?? '';
    const dataPath = event.dataTransfer?.getData('text/plain') ?? '';
    const candidate = dataPath || draggingItem?.path || '';
    const kind = dataKind === 'file' || dataKind === 'folder' ? dataKind : draggingItem?.kind;
    if (!candidate || !kind) return null;
    if (kind === 'file') {
      return files.some((file) => file.path === candidate) ? { kind, path: candidate } : null;
    }
    return folderPaths.has(candidate) ? { kind, path: candidate } : null;
  };

  const handleExternalFileDrop = async (event: DragEvent, targetFolderPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer?.files?.[0] ?? null;
    clearDragState();
    if (!file || !onUploadFile) return;
    await onUploadFile(file, targetFolderPath);
  };

  const handleDropToFolder = async (event: DragEvent, targetFolderPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedItem = resolveDraggedItem(event);
    clearDragState();
    if (!draggedItem) return;
    if (parentFolderPath(draggedItem.path) === targetFolderPath) return;
    if (draggedItem.kind === 'folder') {
      if (targetFolderPath === draggedItem.path || targetFolderPath.startsWith(`${draggedItem.path}/`)) return;
    }
    setMovingTarget(draggedItem);
    try {
      if (draggedItem.kind === 'file') {
        await onMoveFile(draggedItem.path, targetFolderPath);
      } else {
        await onMoveFolder(draggedItem.path, targetFolderPath);
      }
    } finally {
      setMovingTarget((current) =>
        current?.kind === draggedItem.kind && current.path === draggedItem.path ? null : current,
      );
    }
  };

  const handleSidebarBackgroundClick = (event: MouseEvent) => {
    if (event.target !== event.currentTarget) return;
    if (hasOpenFile) {
      setCreateAtRoot(false);
      const nextFocusedPath = activeFilePath ?? focusedPath ?? null;
      if (nextFocusedPath) {
        setFocusedPath(nextFocusedPath);
        setCreateContextPath(nextFocusedPath);
        rowRefs.current[nextFocusedPath]?.focus();
      }
      return;
    }
    setCreateAtRoot(true);
    setFocusedPath(null);
    setCreateContextPath(null);
    onClearSelection?.();
  };

  const renderFolderRow = (folder: SidebarFolderNode, depth: number) => {
    const collapsed = Boolean(collapsedFolders[folder.path]);
    const isRenaming = renamingTarget?.kind === 'folder' && renamingTarget.path === folder.path;
    const isRenamePending = renamingInFlightTarget?.kind === 'folder' && renamingInFlightTarget.path === folder.path;
    const isMoving = movingTarget?.kind === 'folder' && movingTarget.path === folder.path;
    const FolderIcon = collapsed ? FolderClosed : FolderOpen;
    const isDragging = draggingItem?.kind === 'folder' && draggingItem.path === folder.path;
    const isDropTarget = (draggingItem !== null || draggingExternalFile) && dropFolderPath === folder.path;
    const folderRow = (
      <div
        class={`sidebar-file sidebar-folder${folder.hasActiveDescendant ? ' has-active-descendant' : ''}${isRenaming ? ' renaming' : ''}${isMoving ? ' moving' : ''}${folder.deemphasized ? ' sidebar-file-deemphasized' : ''}${isDropTarget ? ' drop-target' : ''}${isDragging ? ' dragging' : ''}`}
        ref={(el) => {
          rowRefs.current[folder.path] = el;
        }}
        tabIndex={focusedPath === folder.path ? 0 : -1}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={!collapsed}
        aria-selected={folder.hasActiveDescendant || undefined}
        draggable={!readOnly && !isRenaming && !isRenamePending && !isMoving}
        data-folder-path={folder.path}
        style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
        onClick={() => toggleFolder(folder.path)}
        onFocus={() => {
          setCreateAtRoot(false);
          setFocusedPath(folder.path);
          setCreateContextPath(folder.path);
        }}
        onDragOver={(e) => {
          if (readOnly) return;
          if (draggingItem) {
            if (
              draggingItem.kind === 'folder' &&
              (folder.path === draggingItem.path || folder.path.startsWith(`${draggingItem.path}/`))
            )
              return;
            e.preventDefault();
            if (dropFolderPath !== folder.path) setDropFolderPath(folder.path);
            return;
          }
          if (!isExternalFileDrag(e)) return;
          e.preventDefault();
          if (!draggingExternalFile) setDraggingExternalFile(true);
          if (dropFolderPath !== folder.path) setDropFolderPath(folder.path);
        }}
        onDragLeave={(e) => {
          if (!draggingItem && !draggingExternalFile) return;
          const nextTarget = e.relatedTarget as Node | null;
          if (nextTarget && (e.currentTarget as HTMLElement).contains(nextTarget)) return;
          if (dropFolderPath === folder.path) setDropFolderPath(null);
        }}
        onDragStart={(e) => {
          if (readOnly || isRenaming || isRenamePending || isMoving) {
            e.preventDefault();
            return;
          }
          e.dataTransfer?.setData('text/plain', folder.path);
          e.dataTransfer?.setData('application/x-input-sidebar-node-kind', 'folder');
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          setDraggingItem({ kind: 'folder', path: folder.path });
        }}
        onDragEnd={() => {
          clearDragState();
        }}
        onDrop={(e) => {
          if (readOnly) return;
          if (isExternalFileDrag(e)) {
            void handleExternalFileDrop(e, folder.path);
            return;
          }
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
        {isRenamePending || isMoving ? (
          <span class="sidebar-rename-spinner" aria-hidden="true" />
        ) : (
          <FolderIcon size={ICON_SIZE} class="sidebar-node-icon" aria-hidden="true" />
        )}
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
          <ContextMenu.Content class="sidebar-context-menu" sideOffset={6} align="start" collisionPadding={8}>
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
    const isRenamePending = renamingInFlightTarget?.kind === 'file' && renamingInFlightTarget.path === file.path;
    const isMoving = movingTarget?.kind === 'file' && movingTarget.path === file.path;
    const FileIcon = getFileIcon(file.name, file.size);
    const rootNoFolderOffset = !hasFolders && depth === 0 ? -12 : 0;
    const fileRow = (
      <div
        class={`sidebar-file${file.active ? ' active' : ''}${isRenaming ? ' renaming' : ''}${isMoving ? ' moving' : ''}${file.deemphasized ? ' sidebar-file-deemphasized' : ''}${file.virtual ? ' sidebar-file-virtual sidebar-file-deemphasized' : ''}${file.changeState ? ` sidebar-file-${file.changeState}` : ''}${draggingItem?.kind === 'file' && draggingItem.path === file.path ? ' dragging' : ''}`}
        ref={(el) => {
          rowRefs.current[file.path] = el;
        }}
        tabIndex={focusedPath === file.path ? 0 : -1}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={file.active}
        aria-current={file.active ? 'true' : undefined}
        draggable={!readOnly && file.editable && !isRenaming && !isRenamePending && !isMoving}
        style={{ paddingLeft: `${8 + depth * INDENT_PX + CHEVRON_SIZE + 6 + rootNoFolderOffset}px` }}
        onClick={() => {
          if (!file.active && !file.virtual) onSelectFile(file.path);
        }}
        onFocus={() => {
          setCreateAtRoot(false);
          setFocusedPath(file.path);
          setCreateContextPath(file.path);
        }}
        onDblClick={() => {
          if (!readOnly && file.editable && !file.virtual) void startRename({ kind: 'file', path: file.path });
        }}
        onDragStart={(e) => {
          if (readOnly || !file.editable || isRenaming) {
            e.preventDefault();
            return;
          }
          e.dataTransfer?.setData('text/plain', file.path);
          e.dataTransfer?.setData('application/x-input-sidebar-node-kind', 'file');
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          setDraggingItem({ kind: 'file', path: file.path });
        }}
        onDragEnd={() => {
          clearDragState();
        }}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!file.active && !file.virtual) onSelectFile(file.path);
          } else if (!readOnly && file.editable && !file.virtual && e.key === 'F2') {
            e.preventDefault();
            void startRename({ kind: 'file', path: file.path });
          }
        }}
      >
        <IndentGuides depth={depth} />
        {isRenamePending || isMoving ? (
          <span class="sidebar-rename-spinner" aria-hidden="true" />
        ) : (
          <FileIcon size={ICON_SIZE} class="sidebar-node-icon" aria-hidden="true" />
        )}
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

    const showFileModifyActions = !readOnly && !file.virtual;
    const showViewOnlyContext = readOnly && canViewOnGitHub;
    if (!showFileModifyActions && !showViewOnlyContext) {
      return <div key={`file:${file.path}`}>{fileRow}</div>;
    }

    return (
      <ContextMenu.Root key={`file:${file.path}`}>
        <ContextMenu.Trigger asChild>{fileRow}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content class="sidebar-context-menu" sideOffset={6} align="start" collisionPadding={8}>
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
          <div class="sidebar-add-group">
            <button
              type="button"
              class="sidebar-add-btn sidebar-add-btn-primary"
              title="Add file"
              onClick={() => startCreateScratchFile(resolveCreateParentFromFocus())}
            >
              <Plus size={14} className="sidebar-add-btn-icon" aria-hidden="true" />
            </button>
            <DropdownMenu.Root onOpenChange={blurOnClose}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  class="sidebar-add-btn sidebar-add-btn-menu"
                  title="Add options"
                  aria-label="Add options"
                >
                  <MoreVertical size={14} className="sidebar-add-btn-menu-icon" />
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
                  {showDailyNoteAction ? (
                    <>
                      <DropdownMenu.Separator class="sidebar-context-menu-separator" />
                      <DropdownMenu.Item class="sidebar-filter-menu-item" onSelect={() => void onOpenDailyNote()}>
                        Open daily note
                      </DropdownMenu.Item>
                    </>
                  ) : null}
                  <DropdownMenu.Separator class="sidebar-context-menu-separator" />
                  <DropdownMenu.Item
                    class="sidebar-filter-menu-item"
                    disabled={!hasFolders}
                    onSelect={() => {
                      if (!hasFolders) return;
                      expandAllFolders();
                    }}
                  >
                    Expand all
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="sidebar-filter-menu-item"
                    disabled={!hasFolders}
                    onSelect={() => {
                      if (!hasFolders) return;
                      collapseAllFolders();
                    }}
                  >
                    Collapse all
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        )}
      </div>
      <div
        class={`sidebar-files${files.length === 0 && !creatingNew ? ' sidebar-files-empty' : ''}${(draggingItem || draggingExternalFile) && dropFolderPath === '' ? ' drop-target-root' : ''}${draggingExternalFile ? ' sidebar-files-uploading' : ''}`}
        role="tree"
        aria-label="Workspace files"
        onKeyDown={handleFilesKeyDown}
        onClick={handleSidebarBackgroundClick}
        onDragOver={(e) => {
          if (readOnly) return;
          if (draggingItem) {
            e.preventDefault();
            const target = e.target as HTMLElement | null;
            if (!target?.closest('[data-folder-path]')) setDropFolderPath('');
            return;
          }
          if (!isExternalFileDrag(e)) return;
          e.preventDefault();
          if (!draggingExternalFile) setDraggingExternalFile(true);
          const target = e.target as HTMLElement | null;
          if (!target?.closest('[data-folder-path]')) setDropFolderPath('');
        }}
        onDragLeave={(e) => {
          if (!draggingExternalFile) return;
          const nextTarget = e.relatedTarget as Node | null;
          if (nextTarget && (e.currentTarget as HTMLElement).contains(nextTarget)) return;
          clearDragState();
        }}
        onDrop={(e) => {
          if (readOnly) return;
          if (isExternalFileDrag(e)) {
            void handleExternalFileDrop(e, '');
            return;
          }
          if (!draggingItem) return;
          const target = e.target as HTMLElement | null;
          if (target?.closest('[data-folder-path]')) return;
          void handleDropToFolder(e, '');
        }}
      >
        {renderNodes(tree.children, 0)}
        {files.length === 0 && !creatingNew ? (
          <div class="sidebar-empty-state">
            <p class="sidebar-empty-message">No files</p>
            {emptyFilterSuggestion ? (
              <button
                type="button"
                class="sidebar-empty-action"
                onClick={(event) => {
                  event.stopPropagation();
                  onFileFilterChange(emptyFilterSuggestion.nextFilter);
                }}
              >
                {emptyFilterSuggestion.buttonLabel}
              </button>
            ) : null}
          </div>
        ) : null}
        {!readOnly && creatingNew && createParentPath === '' && renderCreateRow(0)}
        {draggingExternalFile && <div class="sidebar-upload-drop-overlay">Drop to upload</div>}
      </div>
      {stagedChangesText || showDailyNoteAction ? (
        <div class={`sidebar-footer${stagedChangesText ? ' sidebar-footer-staged' : ''}`}>
          {stagedChangesText ? (
            (stagedChangeFiles?.length ?? 0) > 0 ? (
              <Tooltip.Provider delayDuration={150}>
                <Tooltip.Root open={stagedChangesTooltipOpen} onOpenChange={setStagedChangesTooltipOpen}>
                  <div class="sidebar-staged-changes" aria-label="Changed files" role="status" aria-live="polite">
                    <Tooltip.Trigger asChild>
                      <span
                        class="sidebar-staged-changes-text"
                        onMouseEnter={openStagedChangesTooltip}
                        onMouseLeave={closeStagedChangesTooltipSoon}
                      >
                        {stagedChangesText}
                      </span>
                    </Tooltip.Trigger>
                  </div>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      class="toolbar-save-status-tooltip"
                      side="top"
                      align="center"
                      sideOffset={8}
                      onMouseEnter={openStagedChangesTooltip}
                      onMouseLeave={closeStagedChangesTooltipSoon}
                    >
                      <div class="toolbar-save-status-tooltip-list" role="list" aria-label="Changed files">
                        {stagedChangeFiles!.map((file, index) => (
                          <div key={`${index}:${file.label}`} class="toolbar-save-status-tooltip-item" role="listitem">
                            <span class="toolbar-save-status-tooltip-path">{file.label}</span>
                            {file.binary ? (
                              <span class="toolbar-save-status-tooltip-binary">binary</span>
                            ) : (
                              <span class="toolbar-save-status-tooltip-stats">
                                <span class="toolbar-save-status-tooltip-added">+{file.added}</span>
                                <span class="toolbar-save-status-tooltip-removed">-{file.removed}</span>
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      <Tooltip.Arrow class="toolbar-save-status-tooltip-arrow" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            ) : (
              <div class="sidebar-staged-changes" aria-label="Changed files" role="status" aria-live="polite">
                <span class="sidebar-staged-changes-text">{stagedChangesText}</span>
              </div>
            )
          ) : null}
          {stagedChangesText && (onSaveStagedChanges || onDiscardStagedChanges) ? (
            <div class="sidebar-footer-actions">
              {onSaveStagedChanges ? (
                <button
                  type="button"
                  class="sidebar-footer-action-btn"
                  aria-label={`Commit ${stagedChangesText}`}
                  onClick={() => void onSaveStagedChanges()}
                >
                  Save Changes
                </button>
              ) : null}
              {onDiscardStagedChanges ? (
                <button
                  type="button"
                  class="sidebar-footer-action-btn"
                  aria-label={`Discard ${stagedChangesText}`}
                  onClick={() => void onDiscardStagedChanges()}
                >
                  Discard
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
