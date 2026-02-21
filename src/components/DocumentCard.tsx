import type { ComponentChildren } from 'preact';

interface DocumentCardProps {
  title: string;
  meta: ComponentChildren;
  onOpen: () => void;
  onRename?: () => void;
  onDelete: () => void;
  pending?: boolean;
}

export function DocumentCard({ title, meta, onOpen, onRename, onDelete, pending = false }: DocumentCardProps) {
  return (
    <div class={`document-card${pending ? ' document-card-pending' : ''}`}>
      <div class="doc-info">
        <span class="doc-title">{title}</span>
        <span class="doc-meta">{meta}</span>
      </div>
      <div class="doc-actions">
        <button type="button" onClick={onOpen}>
          Open
        </button>
        {onRename && (
          <button type="button" onClick={onRename}>
            Rename
          </button>
        )}
        <button type="button" class="doc-delete-btn" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
