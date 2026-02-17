interface DocumentCardProps {
  title: string;
  meta: string;
  onOpen: () => void;
  onDelete: () => void;
}

export function DocumentCard({ title, meta, onOpen, onDelete }: DocumentCardProps) {
  return (
    <div class="document-card">
      <div class="doc-info">
        <span class="doc-title">{title}</span>
        <span class="doc-meta">{meta}</span>
      </div>
      <div class="doc-actions">
        <button type="button" onClick={onOpen}>Open</button>
        <button type="button" class="doc-delete-btn" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}
