import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronRight, FileText, FolderClosed, FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { PersistedHomeEntry, PersistedHomeInspectionSnapshot } from '../persisted_home_state.ts';
import { parseSyncedJsonl } from '../synced_jsonl.ts';
import {
  buildDirectoryTree,
  DIRECTORY_TREE_CHEVRON_SIZE,
  DIRECTORY_TREE_INDENT_PX,
  DirectoryTree,
  type DirectoryTreeFileNode,
  type DirectoryTreeFolderNode,
  findFirstDirectoryTreeFile,
} from './DirectoryTree';
import { SyncedJsonlTreeView } from './SyncedJsonlTreeView';

interface TerminalPersistenceDialogProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  snapshot: PersistedHomeInspectionSnapshot | null;
  onClose: () => void;
}

type PersistenceScope = 'global' | 'workspace';
type SelectedPersistedEntry = { scope: PersistenceScope; path: string } | null;
type PersistencePreviewMode = 'parsed' | 'raw';

function persistedEntryDownloadName(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return 'download.txt';
  return trimmed.split('/').filter(Boolean).at(-1) ?? 'download.txt';
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

function folderAncestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  let current = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index]!;
    ancestors.push(current);
  }
  return ancestors;
}

function toggleCollapsedFolderState(current: Record<string, true>, path: string): Record<string, true> {
  if (current[path]) {
    const next = { ...current };
    delete next[path];
    return next;
  }
  return { ...current, [path]: true };
}

function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  const guides = [];
  for (let index = 0; index < depth; index += 1) {
    guides.push(
      <span
        key={index}
        class="sidebar-indent-guide"
        style={{ left: `${14.5 + index * DIRECTORY_TREE_INDENT_PX}px` }}
        aria-hidden="true"
      />,
    );
  }
  return <>{guides}</>;
}

interface TerminalPersistenceTreePaneProps {
  title: string;
  scope: PersistenceScope;
  tree: DirectoryTreeFolderNode<PersistedHomeEntry>;
  selectedEntry: SelectedPersistedEntry;
  collapsedFolders: Record<string, true>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (selection: Exclude<SelectedPersistedEntry, null>) => void;
}

function TerminalPersistenceTreePane({
  title,
  scope,
  tree,
  selectedEntry,
  collapsedFolders,
  onToggleFolder,
  onSelectFile,
}: TerminalPersistenceTreePaneProps) {
  const selectedPath = selectedEntry?.scope === scope ? selectedEntry.path : null;
  const selectedAncestors = useMemo(() => new Set(selectedPath ? folderAncestors(selectedPath) : []), [selectedPath]);
  const hasFolders = tree.children.some((child) => child.kind === 'folder');

  const renderFolderRow = (folder: DirectoryTreeFolderNode<PersistedHomeEntry>, depth: number, collapsed: boolean) => {
    const hasSelectedDescendant = selectedAncestors.has(folder.path);
    const FolderIcon = collapsed ? FolderClosed : FolderOpen;
    return (
      <div
        class={`sidebar-file sidebar-folder${hasSelectedDescendant ? ' has-active-descendant' : ''}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={!collapsed}
        style={{ paddingLeft: `${8 + depth * DIRECTORY_TREE_INDENT_PX}px` }}
        onClick={() => onToggleFolder(folder.path)}
      >
        <IndentGuides depth={depth} />
        <span class={`sidebar-folder-caret${collapsed ? '' : ' open'}`} aria-hidden="true">
          <ChevronRight size={DIRECTORY_TREE_CHEVRON_SIZE} />
        </span>
        <FolderIcon size={15} class="sidebar-node-icon" aria-hidden="true" />
        <span class="sidebar-folder-name">{folder.name}</span>
      </div>
    );
  };

  const renderFileRow = (file: DirectoryTreeFileNode<PersistedHomeEntry>, depth: number) => {
    const rootNoFolderOffset = hasFolders || depth > 0 ? 0 : -12;
    const selected = selectedPath === file.path;
    return (
      <div
        class={`sidebar-file${selected ? ' active' : ''}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        aria-current={selected ? 'true' : undefined}
        style={{
          paddingLeft: `${8 + depth * DIRECTORY_TREE_INDENT_PX + DIRECTORY_TREE_CHEVRON_SIZE + 6 + rootNoFolderOffset}px`,
        }}
        onClick={() => onSelectFile({ scope, path: file.path })}
      >
        <IndentGuides depth={depth} />
        <FileText size={15} class="sidebar-node-icon" aria-hidden="true" />
        <span class="sidebar-file-name">{file.name}</span>
      </div>
    );
  };

  return (
    <section class="terminal-persistence-dialog__tree-section">
      <div class="terminal-persistence-dialog__pane-header">{title}</div>
      <div class="sidebar-files terminal-persistence-dialog__tree-pane" role="tree" aria-label={title}>
        <DirectoryTree
          nodes={tree.children}
          isFolderCollapsed={(folder) => Boolean(collapsedFolders[folder.path])}
          renderFolder={renderFolderRow}
          renderFile={renderFileRow}
          renderFolderChildren={(_folder, _depth, children) => (
            <div class="sidebar-folder-children" role="group">
              <div class="sidebar-folder-children-inner">{children}</div>
            </div>
          )}
        />
        {tree.children.length === 0 ? <div class="terminal-persistence-dialog__empty">No persisted files</div> : null}
      </div>
    </section>
  );
}

export function TerminalPersistenceDialog({ open, loading, error, snapshot, onClose }: TerminalPersistenceDialogProps) {
  const globalEntries = snapshot?.globalEntries ?? [];
  const workspaceEntries = snapshot?.workspaceEntries ?? [];
  const globalTree = useMemo(() => buildDirectoryTree(globalEntries), [globalEntries]);
  const workspaceTree = useMemo(() => buildDirectoryTree(workspaceEntries), [workspaceEntries]);
  const selectedEntryContent = useMemo(() => {
    return new Map<string, PersistedHomeEntry>([
      ...globalEntries.map((entry) => [`global:${entry.path}`, entry] as [string, PersistedHomeEntry]),
      ...workspaceEntries.map((entry) => [`workspace:${entry.path}`, entry] as [string, PersistedHomeEntry]),
    ]);
  }, [globalEntries, workspaceEntries]);
  const [globalCollapsedFolders, setGlobalCollapsedFolders] = useState<Record<string, true>>({});
  const [workspaceCollapsedFolders, setWorkspaceCollapsedFolders] = useState<Record<string, true>>({});
  const [selectedEntry, setSelectedEntry] = useState<SelectedPersistedEntry>(null);
  const [previewMode, setPreviewMode] = useState<PersistencePreviewMode>('raw');
  const defaultSelectedEntry = useMemo<SelectedPersistedEntry>(() => {
    const firstGlobalFile = findFirstDirectoryTreeFile(globalTree.children);
    if (firstGlobalFile) return { scope: 'global', path: firstGlobalFile.path };
    const firstWorkspaceFile = findFirstDirectoryTreeFile(workspaceTree.children);
    if (firstWorkspaceFile) return { scope: 'workspace', path: firstWorkspaceFile.path };
    return null;
  }, [globalTree, workspaceTree]);

  useEffect(() => {
    if (open) return;
    setGlobalCollapsedFolders((current) => (Object.keys(current).length > 0 ? {} : current));
    setWorkspaceCollapsedFolders((current) => (Object.keys(current).length > 0 ? {} : current));
    setSelectedEntry(null);
    setPreviewMode('raw');
  }, [open]);

  const effectiveSelectedEntry =
    selectedEntry && selectedEntryContent.has(`${selectedEntry.scope}:${selectedEntry.path}`)
      ? selectedEntry
      : open
        ? defaultSelectedEntry
        : null;

  useEffect(() => {
    if (!effectiveSelectedEntry) return;
    const ancestors = folderAncestors(effectiveSelectedEntry.path);
    const setter = effectiveSelectedEntry.scope === 'global' ? setGlobalCollapsedFolders : setWorkspaceCollapsedFolders;
    setter((current) => {
      const next = { ...current };
      let changed = false;
      for (const ancestor of ancestors) {
        if (!next[ancestor]) continue;
        delete next[ancestor];
        changed = true;
      }
      return changed ? next : current;
    });
  }, [effectiveSelectedEntry]);

  const previewEntry = effectiveSelectedEntry
    ? (selectedEntryContent.get(`${effectiveSelectedEntry.scope}:${effectiveSelectedEntry.path}`) ?? null)
    : null;
  const parsedPreview = useMemo(
    () => (previewEntry ? parseSyncedJsonl(previewEntry.content, previewEntry.path) : null),
    [previewEntry],
  );

  useEffect(() => {
    if (!previewEntry) {
      setPreviewMode('raw');
      return;
    }
    setPreviewMode(parsedPreview ? 'parsed' : 'raw');
  }, [previewEntry, parsedPreview]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen: boolean) => (!nextOpen ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay class="dialog-overlay" />
        <DialogPrimitive.Content class="dialog-content dialog-content--diff terminal-persistence-dialog">
          <DialogPrimitive.Title class="dialog-title terminal-persistence-dialog__title">
            View synced data
          </DialogPrimitive.Title>
          <div class="terminal-persistence-dialog__body">
            {loading ? <div class="terminal-persistence-dialog__state">Loading persisted files...</div> : null}
            {!loading && error ? (
              <div class="terminal-persistence-dialog__state terminal-persistence-dialog__state--error">{error}</div>
            ) : null}
            {!loading && !error ? (
              <div class="terminal-persistence-dialog__layout">
                <section class="terminal-persistence-dialog__sidebar-pane">
                  <TerminalPersistenceTreePane
                    title="Persisted across workspaces"
                    scope="global"
                    tree={globalTree}
                    selectedEntry={effectiveSelectedEntry}
                    collapsedFolders={globalCollapsedFolders}
                    onToggleFolder={(path) =>
                      setGlobalCollapsedFolders((current) => toggleCollapsedFolderState(current, path))
                    }
                    onSelectFile={setSelectedEntry}
                  />
                  <TerminalPersistenceTreePane
                    title="Persisted in this workspace"
                    scope="workspace"
                    tree={workspaceTree}
                    selectedEntry={effectiveSelectedEntry}
                    collapsedFolders={workspaceCollapsedFolders}
                    onToggleFolder={(path) =>
                      setWorkspaceCollapsedFolders((current) => toggleCollapsedFolderState(current, path))
                    }
                    onSelectFile={setSelectedEntry}
                  />
                </section>
                <section class="terminal-persistence-dialog__preview-pane">
                  <div class="terminal-persistence-dialog__pane-header terminal-persistence-dialog__pane-header--mono">
                    <span class="terminal-persistence-dialog__pane-header-text">
                      {previewEntry?.path ?? 'Select a file'}
                    </span>
                    {previewEntry ? (
                      <button
                        type="button"
                        class="terminal-persistence-dialog__download-link"
                        onClick={() => {
                          triggerBrowserDownload(
                            new Blob([previewEntry.content], { type: 'text/plain;charset=utf-8' }),
                            persistedEntryDownloadName(previewEntry.path),
                          );
                        }}
                      >
                        Download
                      </button>
                    ) : null}
                  </div>
                  <div class="terminal-persistence-dialog__preview-body">
                    {previewEntry ? (
                      <>
                        <div class="terminal-persistence-dialog__preview-toolbar">
                          <div
                            class="terminal-persistence-dialog__preview-toggle"
                            role="tablist"
                            aria-label="Preview mode"
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected={previewMode === 'parsed'}
                              class={`terminal-persistence-dialog__preview-toggle-button${previewMode === 'parsed' ? ' is-active' : ''}`}
                              disabled={!parsedPreview}
                              onClick={() => {
                                setPreviewMode('parsed');
                              }}
                            >
                              Parsed JSONL
                            </button>
                            <button
                              type="button"
                              role="tab"
                              aria-selected={previewMode === 'raw'}
                              class={`terminal-persistence-dialog__preview-toggle-button${previewMode === 'raw' ? ' is-active' : ''}`}
                              onClick={() => {
                                setPreviewMode('raw');
                              }}
                            >
                              Raw text
                            </button>
                          </div>
                        </div>
                        {previewMode === 'parsed' && parsedPreview ? (
                          <SyncedJsonlTreeView parsed={parsedPreview} />
                        ) : (
                          <pre class="terminal-persistence-dialog__preview-content">{previewEntry.content}</pre>
                        )}
                      </>
                    ) : (
                      <div class="terminal-persistence-dialog__empty">Select a file to view its contents</div>
                    )}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
          <div class="dialog-actions terminal-persistence-dialog__actions">
            <DialogPrimitive.Close asChild>
              <button type="button">Close</button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
