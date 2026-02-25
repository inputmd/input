import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

interface EditViewProps {
  content: string;
  previewHtml: string;
  previewVisible: boolean;
  canRenderPreview: boolean;
  onTogglePreview: () => void;
  onContentChange: (content: string) => void;
  onPreviewImageClick?: (src: string, alt: string) => void;
  onEditorPaste?: (event: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => void;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
}

export function EditView({
  content,
  previewHtml,
  previewVisible,
  canRenderPreview,
  onTogglePreview,
  onContentChange,
  onPreviewImageClick,
  onEditorPaste,
  saving,
  canSave,
  onSave,
}: EditViewProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitPercent, setSplitPercent] = useState(52);

  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (canSave && !saving) onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canSave, saving, onSave]);

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
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    event.preventDefault();
  };

  const handleEditorKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    const isMod = e.metaKey || e.ctrlKey;
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = content;

    const wrapSelection = (marker: string) => {
      const selected = value.slice(start, end);
      const next = `${value.slice(0, start)}${marker}${selected}${marker}${value.slice(end)}`;
      onContentChange(next);
      requestAnimationFrame(() => {
        if (start === end) {
          const cursor = start + marker.length;
          ta.selectionStart = cursor;
          ta.selectionEnd = cursor;
          return;
        }
        ta.selectionStart = start + marker.length;
        ta.selectionEnd = end + marker.length;
      });
    };

    if (isMod && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      wrapSelection('**');
      return;
    }

    if (isMod && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      wrapSelection('*');
      return;
    }

    if (e.key !== 'Tab') return;
    e.preventDefault();

    if (!e.shiftKey) {
      // Tab: insert \t or indent selected lines
      if (start === end) {
        const next = `${value.slice(0, start)}\t${value.slice(end)}`;
        onContentChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
      } else {
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const block = value.slice(lineStart, end);
        const indented = block.replace(/^/gm, '\t');
        const next = value.slice(0, lineStart) + indented + value.slice(end);
        const addedChars = indented.length - block.length;
        onContentChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = start + 1;
          ta.selectionEnd = end + addedChars;
        });
      }
    } else {
      // Shift+Tab: un-indent selected lines
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const block = value.slice(lineStart, end);
      const dedented = block.replace(/^\t/gm, '');
      const removedChars = block.length - dedented.length;
      if (removedChars === 0) return;
      const next = value.slice(0, lineStart) + dedented + value.slice(end);
      const firstLineHadTab = block.startsWith('\t');
      onContentChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = firstLineHadTab ? start - 1 : start;
        ta.selectionEnd = end - removedChars;
      });
    }
  };

  const layoutStyle =
    previewVisible && canRenderPreview ? { gridTemplateColumns: `${splitPercent}% 8px minmax(0, 1fr)` } : undefined;

  const onPreviewClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const image = target?.closest('img');
    if (!image || !onPreviewImageClick) return;
    const imageSrc = image.getAttribute('src')?.trim();
    if (!imageSrc) return;

    event.preventDefault();
    onPreviewImageClick(imageSrc, image.getAttribute('alt') ?? '');
  };

  return (
    <div class="edit-view">
      <div class="editor-workspace" ref={splitRef} style={layoutStyle}>
        <textarea
          class="doc-editor"
          ref={editorRef}
          placeholder="Write your markdown here..."
          value={content}
          onInput={(e) => onContentChange((e.target as HTMLTextAreaElement).value)}
          onPaste={onEditorPaste}
          onKeyDown={handleEditorKeyDown}
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
            <div
              class="rendered-markdown"
              onClick={onPreviewClick}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        </>
      )}
    </div>
  );
}
