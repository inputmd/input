import type { JSX } from 'preact';
import { Eye } from 'lucide-react';
import { useEffect, useRef, useState } from 'preact/hooks';

const EDITOR_PREVIEW_VISIBLE_KEY = 'editor_preview_visible';

interface EditViewProps {
  content: string;
  previewHtml: string;
  previewEnabled: boolean;
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
  previewHtml,
  previewEnabled,
  onContentChange,
  showCancel,
  showSave,
  saving,
  canSave,
  onSave,
  onCancel,
}: EditViewProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [previewVisible, setPreviewVisible] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(EDITOR_PREVIEW_VISIBLE_KEY);
      return stored === 'true';
    } catch {
      return false;
    }
  });
  const [splitPercent, setSplitPercent] = useState(52);

  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(EDITOR_PREVIEW_VISIBLE_KEY, previewVisible ? 'true' : 'false');
    } catch {
      // Ignore storage failures (private mode, quota, etc.)
    }
  }, [previewVisible]);

  const onSplitPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!previewVisible || !previewEnabled) return;
    const container = splitRef.current;
    if (!container) return;

    const startRect = container.getBoundingClientRect();
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const relativeX = moveEvent.clientX - startRect.left;
      const next = (relativeX / startRect.width) * 100;
      setSplitPercent(Math.max(25, Math.min(75, next)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    event.preventDefault();
  };

  const layoutStyle = previewVisible && previewEnabled
    ? { gridTemplateColumns: `${splitPercent}% 8px minmax(0, 1fr)` }
    : undefined;

  return (
    <div class="edit-view">
      <div class="editor-top-actions">
        {previewEnabled && (
          <button
            type="button"
            class={`preview-toggle-btn${previewVisible ? '' : ' preview-toggle-btn-off'}`}
            title={previewVisible ? 'Hide preview' : 'Show preview'}
            aria-label={previewVisible ? 'Hide preview' : 'Show preview'}
            onClick={() => setPreviewVisible(v => !v)}
          >
            <Eye size={16} />
          </button>
        )}
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
      <div class="editor-workspace" ref={splitRef} style={layoutStyle}>
        <textarea
          class="doc-editor"
          ref={editorRef}
          placeholder="Write your markdown here..."
          value={content}
          onInput={e => onContentChange((e.target as HTMLTextAreaElement).value)}
        />
        {previewVisible && previewEnabled && (
          <>
            <div
              class="editor-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSplitPointerDown}
            />
            <div class="editor-preview-pane">
              <div class="rendered-markdown" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
