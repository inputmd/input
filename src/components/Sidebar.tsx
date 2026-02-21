import { useState, useRef, useEffect } from 'preact/hooks';

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
  onCreateFile: (filename: string) => void;
  onDeleteFile: (filename: string) => void;
  onRenameFile: (oldName: string, newName: string) => void;
}

function sanitizeFileName(name: string): string {
  const trimmed = name.trim().replace(/[/\\]/g, '').replace(/\.{2,}/g, '.');
  if (!trimmed) return '';
  return trimmed;
}

export function Sidebar({
  files, onSelectFile, onEditFile, onViewOnGitHub, canViewOnGitHub, onCreateFile, onDeleteFile, onRenameFile,
}: SidebarProps) {
  const [creatingNew, setCreatingNew] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [contextFile, setContextFile] = useState<string | null>(null);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus();
  }, [creatingNew]);

  useEffect(() => {
    if (renamingFile) renameInputRef.current?.focus();
  }, [renamingFile]);

  useEffect(() => {
    if (!contextFile) return;
    const closeMenu = () => {
      setContextFile(null);
      setContextPos(null);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (contextMenuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextFile]);

  const handleCreateSubmit = () => {
    const filename = sanitizeFileName(newFileName);
    if (filename) {
      onCreateFile(filename);
      setNewFileName('');
      setCreatingNew(false);
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
          onClick={() => { setCreatingNew(true); setNewFileName(''); }}
        >+</button>
      </div>
      <div class="sidebar-files">
        {files.map(f => (
          <div
            key={f.name}
            class={`sidebar-file${f.active ? ' active' : ''}`}
            onClick={() => !f.active && onSelectFile(f.name)}
            onDblClick={() => startRename(f.name)}
            onContextMenu={e => {
              if (renamingFile) return;
              e.preventDefault();
              setContextFile(f.name);
              setContextPos({ x: e.clientX, y: e.clientY });
            }}
          >
            {renamingFile === f.name ? (
              <input
                ref={renameInputRef}
                class="sidebar-rename-input"
                type="text"
                value={renameValue}
                onInput={e => setRenameValue((e.target as HTMLInputElement).value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleRenameSubmit();
                  if (e.key === 'Escape') { setRenamingFile(null); setRenameValue(''); }
                }}
                onBlur={handleRenameSubmit}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span class="sidebar-file-name">{f.name}</span>
            )}
          </div>
        ))}
      </div>
      {contextFile && contextPos && (
        <div
          ref={contextMenuRef}
          class="sidebar-context-menu"
          style={{ left: `${contextPos.x}px`, top: `${contextPos.y}px` }}
          role="menu"
        >
          <button
            type="button"
            class="sidebar-context-menu-item"
            onClick={() => {
              onEditFile(contextFile);
              setContextFile(null);
              setContextPos(null);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            class="sidebar-context-menu-item"
            onClick={() => {
              startRename(contextFile);
              setContextFile(null);
              setContextPos(null);
            }}
          >
            Rename
          </button>
          {canViewOnGitHub && (
            <button
              type="button"
              class="sidebar-context-menu-item"
              onClick={() => {
                onViewOnGitHub();
                setContextFile(null);
                setContextPos(null);
              }}
            >
              View on GitHub
            </button>
          )}
          <button
            type="button"
            class="sidebar-context-menu-item sidebar-context-menu-item-danger"
            onClick={() => {
              onDeleteFile(contextFile);
              setContextFile(null);
              setContextPos(null);
            }}
          >
            Delete
          </button>
        </div>
      )}
      {creatingNew && (
        <div class="sidebar-new">
          <input
            ref={newInputRef}
            class="sidebar-new-input"
            type="text"
            placeholder="filename"
            value={newFileName}
            onInput={e => setNewFileName((e.target as HTMLInputElement).value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreateSubmit();
              if (e.key === 'Escape') { setCreatingNew(false); setNewFileName(''); }
            }}
            onBlur={() => { if (newFileName.trim()) handleCreateSubmit(); else setCreatingNew(false); }}
          />
        </div>
      )}
    </aside>
  );
}
