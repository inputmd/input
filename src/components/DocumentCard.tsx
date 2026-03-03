import { Pencil, Trash2 } from 'lucide-react';
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
          <button type="button" class="doc-action-rename-btn" aria-label="Rename" title="Rename" onClick={onRename}>
            <span class="doc-action-label">Rename</span>
            <Pencil className="doc-action-icon" size={15} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          class="doc-delete-btn doc-action-delete-btn"
          aria-label="Delete"
          title="Delete"
          onClick={onDelete}
        >
          <span class="doc-action-label">Delete</span>
          <Trash2 className="doc-action-icon" size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
