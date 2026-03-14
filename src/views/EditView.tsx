import type { EditorView } from '@codemirror/view';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MarkdownEditor } from '../components/MarkdownEditor';

interface EditViewProps {
  content: string;
  previewHtml: string;
  previewVisible: boolean;
  canRenderPreview: boolean;
  loading?: boolean;
  onTogglePreview: () => void;
  onContentChange: (content: string) => void;
  onPreviewImageClick?: (image: HTMLImageElement) => void;
  onEditorPaste?: (event: ClipboardEvent, view: EditorView) => void;
  saving: boolean;
  canSave: boolean;
  hasUserTypedUnsavedChanges?: boolean;
  onSave: () => void;
  locked?: boolean;
  imageUploadIssue?: {
    message: string;
    onRetry: () => void;
    onRemovePlaceholder: () => void;
  } | null;
}

export function EditView({
  content,
  previewHtml,
  previewVisible,
  canRenderPreview,
  loading = false,
  onTogglePreview,
  onContentChange,
  onPreviewImageClick,
  onEditorPaste,
  saving,
  canSave,
  hasUserTypedUnsavedChanges = false,
  onSave,
  locked = false,
  imageUploadIssue,
}: EditViewProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitPercent, setSplitPercent] = useState(52);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!loading && !locked && canSave && !saving) onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canSave, loading, saving, onSave, locked]);

  const onSplitPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!previewVisible || !canRenderPreview) return;
    const container = splitRef.current;
    if (!container) return;

    const startRect = container.getBoundingClientRect();
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const relativeX = moveEvent.clientX - startRect.left;
      const next = (relativeX / startRect.width) * 100;
      setSplitPercent(Math.max(25, Math.min(75, next)));
    };
    const cleanupPointerListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanupPointerListeners);
      window.removeEventListener('pointercancel', cleanupPointerListeners);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanupPointerListeners);
    window.addEventListener('pointercancel', cleanupPointerListeners);
    event.preventDefault();
  };

  const layoutStyle =
    previewVisible && canRenderPreview ? { gridTemplateColumns: `${splitPercent}% 0 minmax(0, 1fr)` } : undefined;

  const onPreviewClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const image = target?.closest('img');
    if (!image || !onPreviewImageClick) return;

    event.preventDefault();
    onPreviewImageClick(image);
  };

  return (
    <div class="edit-view" data-has-user-typed-unsaved-changes={hasUserTypedUnsavedChanges ? 'true' : 'false'}>
      {imageUploadIssue ? (
        <div class="editor-inline-alert" role="status" aria-live="polite">
          <span>{imageUploadIssue.message}</span>
          <div class="editor-inline-alert-actions">
            <button type="button" onClick={imageUploadIssue.onRetry}>
              Retry Upload
            </button>
            <button type="button" onClick={imageUploadIssue.onRemovePlaceholder}>
              Remove Placeholder
            </button>
          </div>
        </div>
      ) : null}
      <div class="editor-workspace" ref={splitRef} style={layoutStyle}>
        {locked ? (
          <div class="editor-inline-alert" role="status" aria-live="polite">
            <span>Reader AI is working. Editing is temporarily locked.</span>
          </div>
        ) : null}
        {loading ? (
          <div class="editor-loading-overlay" role="status" aria-live="polite">
            <span class="editor-loading-spinner" aria-hidden="true" />
            <span>Loading file into editor...</span>
          </div>
        ) : null}
        <MarkdownEditor
          class="doc-editor"
          content={content}
          onContentChange={onContentChange}
          onPaste={onEditorPaste}
          readOnly={locked || loading}
        />
        {previewVisible && canRenderPreview && (
          <>
            <div
              class="editor-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSplitPointerDown}
            />
            <div class="editor-preview-pane">
              <div
                class="rendered-markdown"
                onClick={onPreviewClick}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          </>
        )}
      </div>
      {previewVisible && !canRenderPreview && (
        <>
          <div class="mobile-preview-backdrop" onClick={onTogglePreview} />
          <div class="mobile-preview-pane">
            <div class="rendered-markdown" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </>
      )}
    </div>
  );
}
