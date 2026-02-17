import { useState, useRef, useEffect } from 'preact/hooks';

export interface SidebarFile {
  name: string;
  active: boolean;
}

interface SidebarProps {
  files: SidebarFile[];
  onSelectFile: (filename: string) => void;
  onCreateFile: (filename: string) => void;
  onDeleteFile: (filename: string) => void;
  onRenameFile: (oldName: string, newName: string) => void;
}

function sanitizeFileName(name: string): string {
  const trimmed = name.trim().replace(/[/\\]/g, '').replace(/\.{2,}/g, '.');
  if (!trimmed) return '';
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : trimmed + '.md';
}

export function Sidebar({ files, onSelectFile, onCreateFile, onDeleteFile, onRenameFile }: SidebarProps) {
  const [creatingNew, setCreatingNew] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus();
  }, [creatingNew]);

  useEffect(() => {
    if (renamingFile) renameInputRef.current?.focus();
  }, [renamingFile]);

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
    setRenameValue(filename.replace(/\.md$/i, ''));
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
              <>
                <span class="sidebar-file-name">{f.name}</span>
                {files.length > 1 && (
                  <div class="sidebar-file-actions">
                    <button
                      type="button"
                      class="sidebar-delete-btn"
                      title={`Delete ${f.name}`}
                      onClick={e => { e.stopPropagation(); onDeleteFile(f.name); }}
                    >&times;</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
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
