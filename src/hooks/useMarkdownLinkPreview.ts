import type { RefObject } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  footnoteTargetIdFromAnchor,
  INITIAL_LINK_PREVIEW_STATE,
  isMarkdownHref,
  isMissingWikiLink,
  type LinkPreviewState,
  lastPathSegment,
  type MarkdownLinkPreview,
  resolveInternalRoute,
} from '../markdown_link_preview';

export interface PreviewPositionForAnchor {
  top: number;
  left: number;
}

export interface UseMarkdownLinkPreviewOptions {
  renderedMarkdownRef: RefObject<HTMLDivElement | null>;
  onRequestMarkdownLinkPreview?: (route: string) => Promise<MarkdownLinkPreview | null>;
  getPreviewPosition: (anchor: HTMLAnchorElement) => PreviewPositionForAnchor;
  enabled?: boolean;
}

export interface UseMarkdownLinkPreviewResult {
  preview: LinkPreviewState;
  hidePreview: () => void;
  clearHoverDelay: () => void;
  showPreviewForAnchor: (anchor: HTMLAnchorElement) => void;
  showCitationPreviewForAnchor: (anchor: HTMLAnchorElement) => void;
  onRenderedMarkdownMouseMove: (event: MouseEvent) => void;
  onRenderedMarkdownMouseDown: (event: MouseEvent) => void;
  onRenderedMarkdownMouseUp: () => void;
  pointerDraggedRef: RefObject<boolean>;
}

export function useMarkdownLinkPreview({
  renderedMarkdownRef,
  onRequestMarkdownLinkPreview,
  getPreviewPosition,
  enabled = true,
}: UseMarkdownLinkPreviewOptions): UseMarkdownLinkPreviewResult {
  const hoverAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const hoverRequestIdRef = useRef(0);
  const hoverDelayTimerRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const pointerDraggedRef = useRef(false);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<LinkPreviewState>(INITIAL_LINK_PREVIEW_STATE);

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

  useEffect(() => {
    if (!preview.visible) return;

    const dismiss = () => hidePreview();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [hidePreview, preview.visible]);

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

      const position = getPreviewPosition(anchor);
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: true,
        top: position.top,
        left: position.left,
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
    [getPreviewPosition, hidePreview, onRequestMarkdownLinkPreview],
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

      const position = getPreviewPosition(anchor);
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: false,
        top: position.top,
        left: position.left,
        title: `Citation ${anchor.textContent?.trim() || ''}`.trim(),
        html: htmlContent,
        url: null,
      });
    },
    [getPreviewPosition, hidePreview, renderedMarkdownRef],
  );

  const onRenderedMarkdownMouseMove = useCallback(
    (event: MouseEvent) => {
      if (pointerDownRef.current && pointerDownPositionRef.current) {
        const dx = Math.abs(event.clientX - pointerDownPositionRef.current.x);
        const dy = Math.abs(event.clientY - pointerDownPositionRef.current.y);
        if (dx > 4 || dy > 4) pointerDraggedRef.current = true;
      }
      if (!enabled) return;
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
        hidePreview();
      }, 120);
    },
    [
      clearHoverDelay,
      enabled,
      hidePreview,
      onRequestMarkdownLinkPreview,
      preview.visible,
      showCitationPreviewForAnchor,
      showPreviewForAnchor,
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

  return {
    preview,
    hidePreview,
    clearHoverDelay,
    showPreviewForAnchor,
    showCitationPreviewForAnchor,
    onRenderedMarkdownMouseMove,
    onRenderedMarkdownMouseDown,
    onRenderedMarkdownMouseUp,
    pointerDraggedRef,
  };
}
