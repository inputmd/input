import type { EditorView } from '@codemirror/view';
import { ExternalLink } from 'lucide-react';
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { InlinePromptRequest } from '../components/codemirror_inline_prompt';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { TextEditor } from '../components/TextEditor';
import { isExternalHttpHref, MARKDOWN_EXT_RE } from '../util';

interface MarkdownLinkPreview {
  title: string;
  html: string;
}

interface LinkPreviewState {
  visible: boolean;
  loading: boolean;
  top: number;
  left: number;
  title: string;
  html: string;
  url: string | null;
}

function isMarkdownHref(href: string): boolean {
  const withoutSuffix = href.split(/[?#]/, 1)[0] ?? '';
  return MARKDOWN_EXT_RE.test(withoutSuffix);
}

function lastPathSegment(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  const parts = withoutQuery.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function footnoteTargetIdFromAnchor(anchor: HTMLAnchorElement): string | null {
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href.startsWith('#fn-')) return null;
  return href.slice(1);
}

function isMissingWikiLink(anchor: HTMLAnchorElement): boolean {
  return anchor.classList.contains('missing-wikilink');
}

interface EditViewProps {
  fileName?: string | null;
  markdown?: boolean;
  content: string;
  contentOrigin?: 'local' | 'external';
  contentRevision?: number;
  contentSelection?: { anchor: number; head: number } | null;
  previewHtml: string;
  previewCustomCss?: string | null;
  previewCustomCssScope?: string | null;
  previewVisible: boolean;
  canRenderPreview: boolean;
  scrollStorageKey?: string | null;
  loading?: boolean;
  onTogglePreview: () => void;
  onContentChange: (update: { content: string; origin: 'local'; revision: number }) => void;
  onInlinePromptSubmit?: (request: InlinePromptRequest) => void;
  onCancelInlinePrompt?: () => void;
  inlinePromptActive?: boolean;
  onInternalLinkNavigate?: (route: string) => void;
  onRequestMarkdownLinkPreview?: (route: string) => Promise<MarkdownLinkPreview | null>;
  onPreviewImageClick?: (image: HTMLImageElement) => void;
  onEditorPaste?: (event: ClipboardEvent, view: EditorView) => void;
  saving: boolean;
  canSave: boolean;
  hasUserTypedUnsavedChanges?: boolean;
  onSave: () => void;
  locked?: boolean;
  lockLabel?: string;
  imageUploadIssue?: {
    message: string;
    onRetry: () => void;
    onRemovePlaceholder: () => void;
  } | null;
}

export function EditView({
  fileName = null,
  markdown = true,
  content,
  contentOrigin = 'external',
  contentRevision = 0,
  contentSelection = null,
  previewHtml,
  previewCustomCss = null,
  previewCustomCssScope = null,
  previewVisible,
  canRenderPreview,
  scrollStorageKey = null,
  loading = false,
  onTogglePreview,
  onContentChange,
  onInlinePromptSubmit,
  onCancelInlinePrompt,
  inlinePromptActive = false,
  onInternalLinkNavigate,
  onRequestMarkdownLinkPreview,
  onPreviewImageClick,
  onEditorPaste,
  saving,
  canSave,
  hasUserTypedUnsavedChanges = false,
  onSave,
  locked = false,
  lockLabel = 'Reader AI',
  imageUploadIssue,
}: EditViewProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const renderedMarkdownRef = useRef<HTMLDivElement | null>(null);
  const hoverAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const hoverRequestIdRef = useRef(0);
  const hoverDelayTimerRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const pointerDraggedRef = useRef(false);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [splitPercent, setSplitPercent] = useState(52);
  const [preview, setPreview] = useState<LinkPreviewState>({
    visible: false,
    loading: false,
    top: 0,
    left: 0,
    title: '',
    html: '',
    url: null,
  });

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

  const clearHoverDelay = useCallback(() => {
    if (hoverDelayTimerRef.current == null) return;
    window.clearTimeout(hoverDelayTimerRef.current);
    hoverDelayTimerRef.current = null;
  }, []);

  const hidePreview = useCallback(() => {
    clearHoverDelay();
    hoverAnchorRef.current = null;
    hoverRequestIdRef.current += 1;
    setPreview((prev) => (prev.visible || prev.loading ? { ...prev, visible: false, loading: false } : prev));
  }, [clearHoverDelay]);

  useEffect(() => {
    return () => {
      clearHoverDelay();
    };
  }, [clearHoverDelay]);

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
    markdown && previewVisible && canRenderPreview
      ? { gridTemplateColumns: `${splitPercent}% 0 minmax(0, 1fr)` }
      : undefined;

  const resolveInternalRoute = useCallback((anchor: HTMLAnchorElement): string | null => {
    if (anchor.hasAttribute('download')) return null;
    const href = (anchor.getAttribute('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('?')) return null;
    if (isExternalHttpHref(href)) return null;
    const resolved = new URL(href, window.location.href);
    if (resolved.origin !== window.location.origin) return null;
    return resolved.pathname.replace(/^\//, '');
  }, []);

  const showPreviewForAnchor = useCallback(
    (anchor: HTMLAnchorElement) => {
      if (!onRequestMarkdownLinkPreview) return;
      if (isMissingWikiLink(anchor)) {
        hidePreview();
        return;
      }
      const route = resolveInternalRoute(anchor);
      if (!route || !isMarkdownHref(route)) {
        hidePreview();
        return;
      }

      const rect = anchor.getBoundingClientRect();
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: true,
        top: Math.round(rect.bottom + 8),
        left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
        title: lastPathSegment(route),
        html: '',
        url: null,
      });

      void onRequestMarkdownLinkPreview(route)
        .then((result) => {
          if (hoverRequestIdRef.current !== requestId) return;
          if (!result) {
            hidePreview();
            return;
          }
          setPreview((prev) => ({
            ...prev,
            visible: true,
            loading: false,
            title: result.title || prev.title,
            html: result.html,
            url: null,
          }));
        })
        .catch(() => {
          if (hoverRequestIdRef.current !== requestId) return;
          hidePreview();
        });
    },
    [hidePreview, onRequestMarkdownLinkPreview, resolveInternalRoute],
  );

  const showUrlOnlyPreviewForAnchor = useCallback(
    (anchor: HTMLAnchorElement) => {
      const href = (anchor.getAttribute('href') || '').trim();
      if (!href || href.startsWith('#') || href.startsWith('?')) {
        hidePreview();
        return;
      }

      const rect = anchor.getBoundingClientRect();
      const resolvedHref = anchor.href || href;
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: false,
        top: Math.round(rect.bottom + 8),
        left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
        title: 'Link',
        html: '',
        url: resolvedHref,
      });
    },
    [hidePreview],
  );

  const showCitationPreviewForAnchor = useCallback(
    (anchor: HTMLAnchorElement) => {
      const targetId = footnoteTargetIdFromAnchor(anchor);
      if (!targetId) {
        hidePreview();
        return;
      }

      const root = renderedMarkdownRef.current;
      if (!root) {
        hidePreview();
        return;
      }

      const target = root.querySelector<HTMLElement>(`#${CSS.escape(targetId)}`);
      if (!target) {
        hidePreview();
        return;
      }

      const clone = target.cloneNode(true);
      if (!(clone instanceof HTMLElement)) {
        hidePreview();
        return;
      }

      clone.querySelectorAll('.footnote-backrefs').forEach((backrefs) => {
        backrefs.remove();
      });
      const htmlContent = clone.innerHTML.trim();
      if (!htmlContent) {
        hidePreview();
        return;
      }

      const rect = anchor.getBoundingClientRect();
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: false,
        top: Math.round(rect.bottom + 8),
        left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
        title: `Citation ${anchor.textContent?.trim() || ''}`.trim(),
        html: htmlContent,
        url: null,
      });
    },
    [hidePreview],
  );

  const onRenderedMarkdownMouseMove = useCallback(
    (event: MouseEvent) => {
      if (pointerDownRef.current && pointerDownPositionRef.current) {
        const dx = Math.abs(event.clientX - pointerDownPositionRef.current.x);
        const dy = Math.abs(event.clientY - pointerDownPositionRef.current.y);
        if (dx > 4 || dy > 4) pointerDraggedRef.current = true;
      }
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a') as HTMLAnchorElement | null;
      if (!anchor) {
        if (hoverAnchorRef.current) hidePreview();
        return;
      }

      if (anchor === hoverAnchorRef.current && preview.visible) return;
      clearHoverDelay();
      hoverDelayTimerRef.current = window.setTimeout(() => {
        if (isMissingWikiLink(anchor)) {
          hidePreview();
          return;
        }
        if (footnoteTargetIdFromAnchor(anchor)) {
          showCitationPreviewForAnchor(anchor);
          return;
        }
        const route = resolveInternalRoute(anchor);
        if (route && isMarkdownHref(route) && onRequestMarkdownLinkPreview) {
          showPreviewForAnchor(anchor);
          return;
        }
        showUrlOnlyPreviewForAnchor(anchor);
      }, 120);
    },
    [
      clearHoverDelay,
      hidePreview,
      onRequestMarkdownLinkPreview,
      preview.visible,
      resolveInternalRoute,
      showCitationPreviewForAnchor,
      showPreviewForAnchor,
      showUrlOnlyPreviewForAnchor,
    ],
  );

  const onRenderedMarkdownMouseDown = useCallback((event: MouseEvent) => {
    if (event.button !== 0) return;
    pointerDownRef.current = true;
    pointerDraggedRef.current = false;
    pointerDownPositionRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const onRenderedMarkdownMouseUp = useCallback(() => {
    pointerDownRef.current = false;
    pointerDownPositionRef.current = null;
  }, []);

  const onPreviewClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a') as HTMLAnchorElement | null;
    if (anchor && !pointerDraggedRef.current) {
      const route = resolveInternalRoute(anchor);
      if (route && onInternalLinkNavigate) {
        event.preventDefault();
        onInternalLinkNavigate(route);
        return;
      }
    }

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
          <div class="editor-lock-indicator" role="status" aria-live="polite">
            <span class="editor-loading-spinner" aria-hidden="true" />
            <span>{lockLabel}</span>
          </div>
        ) : null}
        {loading ? (
          <div class="editor-loading-overlay" role="status" aria-live="polite" aria-label="Loading file into editor">
            <span class="editor-loading-spinner" aria-hidden="true" />
          </div>
        ) : null}
        {markdown ? (
          <MarkdownEditor
            class="doc-editor"
            content={content}
            contentOrigin={contentOrigin}
            contentRevision={contentRevision}
            contentSelection={contentSelection}
            scrollStorageKey={scrollStorageKey}
            onContentChange={onContentChange}
            onInlinePromptSubmit={onInlinePromptSubmit}
            onCancelInlinePrompt={onCancelInlinePrompt}
            inlinePromptActive={inlinePromptActive}
            onPaste={onEditorPaste}
            readOnly={locked || loading}
          />
        ) : (
          <TextEditor
            class="doc-editor"
            fileName={fileName}
            content={content}
            contentOrigin={contentOrigin}
            contentRevision={contentRevision}
            contentSelection={contentSelection}
            scrollStorageKey={scrollStorageKey}
            onContentChange={onContentChange}
            readOnly={locked || loading}
          />
        )}
        {markdown && previewVisible && canRenderPreview && (
          <>
            <div
              class="editor-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSplitPointerDown}
            />
            <div class="editor-preview-pane">
              {previewCustomCss ? <style>{previewCustomCss}</style> : null}
              <div
                ref={renderedMarkdownRef}
                class="rendered-markdown"
                data-markdown-custom-css={previewCustomCssScope ?? undefined}
                onClick={onPreviewClick}
                onMouseDown={onRenderedMarkdownMouseDown}
                onMouseUp={onRenderedMarkdownMouseUp}
                onMouseMove={onRenderedMarkdownMouseMove}
                onMouseLeave={hidePreview}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          </>
        )}
      </div>
      {markdown && previewVisible && !canRenderPreview && (
        <>
          <div class="mobile-preview-backdrop" onClick={onTogglePreview} />
          <div class="mobile-preview-pane">
            {previewCustomCss ? <style>{previewCustomCss}</style> : null}
            <div
              ref={renderedMarkdownRef}
              class="rendered-markdown"
              data-markdown-custom-css={previewCustomCssScope ?? undefined}
              onClick={onPreviewClick}
              onMouseDown={onRenderedMarkdownMouseDown}
              onMouseUp={onRenderedMarkdownMouseUp}
              onMouseMove={onRenderedMarkdownMouseMove}
              onMouseLeave={hidePreview}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        </>
      )}
      {preview.visible ? (
        <div
          class={`markdown-link-preview-popover${preview.url ? ' markdown-link-preview-popover--url' : ''}`}
          style={{
            top: `${preview.top}px`,
            left: `${preview.left}px`,
          }}
          aria-live="polite"
        >
          {preview.url ? null : <div class="markdown-link-preview-title">{preview.title}</div>}
          {preview.loading ? (
            <div class="markdown-link-preview-status">Loading preview...</div>
          ) : preview.url ? (
            <div class="markdown-link-preview-url">
              <span class="markdown-link-preview-url-text">{preview.url}</span>
              <ExternalLink aria-hidden="true" size={12} strokeWidth={2} />
            </div>
          ) : (
            <div class="markdown-link-preview-body" dangerouslySetInnerHTML={{ __html: preview.html }} />
          )}
        </div>
      ) : null}
    </div>
  );
}
