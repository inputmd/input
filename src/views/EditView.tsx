import { useEffect, useRef } from 'preact/hooks';

interface EditViewProps {
  content: string;
  onContentChange: (content: string) => void;
  showCancel: boolean;
  showSave: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export function EditView({
  content,
  onContentChange,
  showCancel,
  showSave,
  saving,
  canSave,
  onSave,
  onCancel,
}: EditViewProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  return (
    <div class="edit-view">
      <div class="editor-top-actions">
        {showCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        {showSave && (
          <button type="button" onClick={onSave} disabled={saving || !canSave}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>
      <textarea
        class="doc-editor"
        ref={editorRef}
        placeholder="Write your markdown here..."
        value={content}
        onInput={e => onContentChange((e.target as HTMLTextAreaElement).value)}
      />
    </div>
  );
}
