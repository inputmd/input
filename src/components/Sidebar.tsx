import * as ContextMenu from '@radix-ui/react-context-menu';
import { useEffect, useRef, useState } from 'preact/hooks';

export interface SidebarFile {
  name: string;
  active: boolean;
}

interface SidebarProps {
  files: SidebarFile[];
  onSelectFile: (filename: string) => void;
  onEditFile: (filename: string) => void;
  onViewOnGitHub: () => void;
  canViewOnGitHub: boolean;
  onCreateFile: (filename: string) => void | Promise<void>;
  onDeleteFile: (filename: string) => void;
  onRenameFile: (oldName: string, newName: string) => void;
}

function sanitizeFileName(name: string): string {
  const trimmed = name
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '.');
  if (!trimmed) return '';
  return trimmed;
}

export function Sidebar({
  files,
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

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus();
  }, [creatingNew]);

  useEffect(() => {
    if (renamingFile) renameInputRef.current?.focus();
  }, [renamingFile]);

  const handleCreateSubmit = async () => {
    if (createInFlightRef.current) return;
    const filename = sanitizeFileName(newFileName);
    if (!filename) return;

    createInFlightRef.current = true;
    setCreatingFile(true);
    try {
      await onCreateFile(filename);
      setNewFileName('');
      setCreatingNew(false);
    } finally {
      createInFlightRef.current = false;
      setCreatingFile(false);
    }
  };

  const handleRenameSubmit = () => {
    if (!renamingFile) return;
    const newName = sanitizeFileName(renameValue);
    if (newName && newName !== renamingFile) {
      onRenameFile(renamingFile, newName);
    }
    setRenamingFile(null);
    setRenameValue('');
  };

  const startRename = (filename: string) => {
    setRenamingFile(filename);
    setRenameValue(filename);
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <h3>Files</h3>
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
      </div>
      <div class="sidebar-files">
        {files.map((f) => {
          const fileRow = (
            <div
              class={`sidebar-file${f.active ? ' active' : ''}${renamingFile === f.name ? ' renaming' : ''}`}
              tabIndex={0}
              role="button"
              aria-current={f.active ? 'true' : undefined}
              onClick={() => !f.active && onSelectFile(f.name)}
              onDblClick={() => startRename(f.name)}
              onKeyDown={(e) => {
                if (renamingFile === f.name) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!f.active) onSelectFile(f.name);
                } else if (e.key === 'F2') {
                  e.preventDefault();
                  startRename(f.name);
                }
              }}
            >
              {renamingFile === f.name ? (
                <input
                  ref={renameInputRef}
                  class="sidebar-rename-input"
                  type="text"
                  value={renameValue}
                  onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameSubmit();
                    if (e.key === 'Escape') {
                      setRenamingFile(null);
                      setRenameValue('');
                    }
                  }}
                  onBlur={handleRenameSubmit}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span class="sidebar-file-name">{f.name}</span>
              )}
            </div>
          );

          if (renamingFile === f.name) {
            return <div key={f.name}>{fileRow}</div>;
          }

          return (
            <ContextMenu.Root key={f.name}>
              <ContextMenu.Trigger asChild>{fileRow}</ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content class="sidebar-context-menu" sideOffset={6} align="start">
                  <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => onEditFile(f.name)}>
                    Edit
                  </ContextMenu.Item>
                  <ContextMenu.Item class="sidebar-context-menu-item" onSelect={() => startRename(f.name)}>
                    Rename
                  </ContextMenu.Item>
                  {canViewOnGitHub && (
                    <ContextMenu.Item class="sidebar-context-menu-item" onSelect={onViewOnGitHub}>
                      View on GitHub
                    </ContextMenu.Item>
                  )}
                  <ContextMenu.Item
                    class="sidebar-context-menu-item sidebar-context-menu-item-danger"
                    onSelect={() => onDeleteFile(f.name)}
                  >
                    Delete
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
        {creatingNew && (
          <div class="sidebar-file renaming">
            <input
              ref={newInputRef}
              class="sidebar-rename-input"
              type="text"
              placeholder="file.md"
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
