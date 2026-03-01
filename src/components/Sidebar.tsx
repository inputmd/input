import * as ContextMenu from '@radix-ui/react-context-menu';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'preact/hooks';

export interface SidebarFile {
  path: string;
  active: boolean;
}

interface SidebarProps {
  files: SidebarFile[];
  disabled?: boolean;
  readOnly?: boolean;
  onSelectFile: (path: string) => void;
  onEditFile: (path: string) => void;
  onViewOnGitHub: (path: string) => void;
  canViewOnGitHub: boolean;
  onCreateFile: (path: string) => void | Promise<void>;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, newPath: string) => void | Promise<void>;
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

export function Sidebar({
  files,
  disabled = false,
  readOnly = false,
  onSelectFile,
  onEditFile,
  onViewOnGitHub,
  canViewOnGitHub,
  onCreateFile,
  onDeleteFile,
  onRenameFile,
}: SidebarProps) {
  const [creatingNew, setCreatingNew] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInFlightRef = useRef(false);
  const renameInFlightRef = useRef(false);

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus();
  }, [creatingNew]);

  useEffect(() => {
    if (renamingFile) renameInputRef.current?.focus();
  }, [renamingFile]);

  const handleCreateSubmit = async () => {
    if (createInFlightRef.current) return;
    const path = sanitizePathInput(newFileName);
    if (!path) return;

    createInFlightRef.current = true;
    setCreatingFile(true);
    try {
      await onCreateFile(path);
      setNewFileName('');
      setCreatingNew(false);
    } finally {
      createInFlightRef.current = false;
      setCreatingFile(false);
    }
  };

  const handleRenameSubmit = async () => {
    if (!renamingFile || renameInFlightRef.current) return;
    renameInFlightRef.current = true;
    const oldPath = renamingFile;
    const newPath = sanitizePathInput(renameValue);
    setRenamingFile(null);
    setRenameValue('');
    try {
      if (newPath && newPath !== oldPath) {
        await onRenameFile(oldPath, newPath);
      }
    } finally {
      renameInFlightRef.current = false;
    }
  };

  const startRename = (path: string) => {
    setRenamingFile(path);
    setRenameValue(path);
  };

  if (disabled) {
    return (
      <aside class="sidebar">
        <div class="sidebar-header">
          <h3>Files</h3>
        </div>
        <div class="sidebar-files sidebar-files-disabled">
          <p class="sidebar-disabled-message">Empty workspace</p>
        </div>
      </aside>
    );
  }

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <h3>Files</h3>
        {!readOnly && (
          <button
            type="button"
            class="sidebar-add-btn"
            title="New file"
            onClick={() => {
              setCreatingNew(true);
              setNewFileName('');
            }}
          >
            +
          </button>
        )}
      </div>
      <div class="sidebar-files">
        {files.map((f) => {
          const fileRow = (
            <div
              class={`sidebar-file${f.active ? ' active' : ''}${renamingFile === f.path ? ' renaming' : ''}`}
              tabIndex={0}
              role="button"
              aria-current={f.active ? 'true' : undefined}
              onClick={() => !f.active && onSelectFile(f.path)}
              onDblClick={() => {
                if (!readOnly) startRename(f.path);
              }}
              onKeyDown={(e) => {
                if (renamingFile === f.path) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!f.active) onSelectFile(f.path);
                } else if (!readOnly && e.key === 'F2') {
                  e.preventDefault();
                  startRename(f.path);
                }
              }}
            >
              {renamingFile === f.path ? (
                <input
                  ref={renameInputRef}
                  class="sidebar-rename-input"
                  type="text"
                  value={renameValue}
                  onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRenameSubmit();
                    if (e.key === 'Escape') {
                      setRenamingFile(null);
                      setRenameValue('');
                    }
                  }}
                  onBlur={() => void handleRenameSubmit()}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span class="sidebar-file-name">{f.path}</span>
              )}
            </div>
          );

          if (renamingFile === f.path) {
            return <div key={f.path}>{fileRow}</div>;
          }

          if (readOnly) {
            return <div key={f.path}>{fileRow}</div>;
          }

          return (
            <ContextMenu.Root key={f.path}>
              <ContextMenu.Trigger asChild>{fileRow}</ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content class="sidebar-context-menu" sideOffset={6} align="start">
                  <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => onEditFile(f.path)}>
                    Edit
                  </ContextMenu.Item>
                  <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => startRename(f.path)}>
                    Rename
                  </ContextMenu.Item>
                  {canViewOnGitHub && (
                    <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => onViewOnGitHub(f.path)}>
                      View on GitHub
                      <ExternalLink size={14} className="sidebar-context-menu-item-icon" aria-hidden="true" />
                    </ContextMenu.Item>
                  )}
                  <ContextMenu.Separator class="sidebar-context-menu-separator" />
                  <ContextMenu.Item
                    class="sidebar-context-menu-item sidebar-context-menu-item-danger"
                    onSelect={() => onDeleteFile(f.path)}
                  >
                    Delete
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
        {!readOnly && creatingNew && (
          <div class="sidebar-file renaming">
            <input
              ref={newInputRef}
              class="sidebar-rename-input"
              type="text"
              placeholder="notes/file.md"
              value={newFileName}
              disabled={creatingFile}
              onInput={(e) => setNewFileName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleCreateSubmit();
                }
                if (e.key === 'Escape') {
                  setCreatingNew(false);
                  setNewFileName('');
                }
              }}
              onBlur={() => {
                if (newFileName.trim()) void handleCreateSubmit();
                else setCreatingNew(false);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
