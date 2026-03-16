import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ContentAlert } from '../components/ContentAlert';
import { TextCodeView } from '../components/TextCodeView';
import { getStoredScrollPosition, setStoredScrollPosition } from '../scroll_positions';
import { isExternalHttpHref, MARKDOWN_EXT_RE } from '../util';

interface MarkdownLinkPreview {
  title: string;
  html: string;
}

interface ContentViewProps {
  html: string;
  markdown: boolean;
  scrollStorageKey?: string | null;
  plainText?: string | null;
  plainTextFileName?: string | null;
  loading?: boolean;
  imagePreview?: { src: string; alt: string } | null;
  alertMessage?: string | null;
  alertDownloadHref?: string | null;
  alertDownloadName?: string | null;
  /** When true, hash links scroll within the component instead of the window. */
  containScroll?: boolean;
  onInternalLinkNavigate?: (route: string) => void;
  onRequestMarkdownLinkPreview?: (route: string) => Promise<MarkdownLinkPreview | null>;
  onImageClick?: (image: HTMLImageElement) => void;
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

function decodeHashTargetId(hash: string): string | null {
  const trimmed = hash.trim();
  if (!trimmed || !trimmed.startsWith('#')) return null;
  const raw = trimmed.slice(1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function safeCssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

export function ContentView({
  html,
  markdown,
  scrollStorageKey = null,
  plainText = null,
  plainTextFileName = null,
  loading = false,
  imagePreview,
  alertMessage,
  alertDownloadHref,
  alertDownloadName,
  containScroll = false,
  onInternalLinkNavigate,
  onRequestMarkdownLinkPreview,
  onImageClick,
}: ContentViewProps) {
  const renderedMarkdownRef = useRef<HTMLDivElement | null>(null);
  const imagePreviewRef = useRef<HTMLImageElement | null>(null);
  const hoverAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const hoverRequestIdRef = useRef(0);
  const hoverDelayTimerRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const pointerDraggedRef = useRef(false);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const currentScrollStorageKeyRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<LinkPreviewState>({
    visible: false,
    loading: false,
    top: 0,
    left: 0,
    title: '',
    html: '',
    url: null,
  });
  const [imagePreviewLoading, setImagePreviewLoading] = useState(true);
  const isEmpty = html.trim().length === 0 && (plainText === null || plainText.length === 0) && !imagePreview;

  const scrollToHash = useCallback((hash: string, behavior: ScrollBehavior = 'auto') => {
    const targetId = decodeHashTargetId(hash);
    if (!targetId) return false;
    const root = renderedMarkdownRef.current;
    const selector = `#${safeCssEscape(targetId)}`;
    const target = (root ? root.querySelector(selector) : null) ?? document.getElementById(targetId);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'start', behavior });
    return true;
  }, []);

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
    const syncScrollPosition = () => {
      const key = currentScrollStorageKeyRef.current;
      if (!key) return;
      setStoredScrollPosition(key, window.scrollY);
    };

    window.addEventListener('scroll', syncScrollPosition, { passive: true });
    return () => {
      syncScrollPosition();
      window.removeEventListener('scroll', syncScrollPosition);
    };
  }, []);

  useEffect(() => {
    const previousKey = currentScrollStorageKeyRef.current;
    if (previousKey === scrollStorageKey) return;

    if (previousKey) {
      setStoredScrollPosition(previousKey, window.scrollY);
    }

    currentScrollStorageKeyRef.current = scrollStorageKey;
    const nextScrollTop = scrollStorageKey ? (getStoredScrollPosition(scrollStorageKey) ?? 0) : 0;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
    });
  }, [scrollStorageKey]);

  useEffect(() => {
    if (loading) return;
    if (!scrollStorageKey) return;
    const nextScrollTop = getStoredScrollPosition(scrollStorageKey) ?? 0;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
    });
  }, [loading, scrollStorageKey]);

  useEffect(() => {
    if (!markdown || loading) return;
    if (!html) return;
    const hash = window.location.hash;
    if (!hash) return;
    window.requestAnimationFrame(() => scrollToHash(hash, 'auto'));
  }, [html, loading, markdown, scrollToHash]);

  useEffect(() => {
    if (!markdown) return;
    const onHashChange = () => scrollToHash(window.location.hash, 'auto');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [markdown, scrollToHash]);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !html || !root) return;

    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
    if (images.length === 0) return;

    const clearLoading = (image: HTMLImageElement) => image.setAttribute('data-image-loading', 'false');
    const setLoading = (image: HTMLImageElement) => image.setAttribute('data-image-loading', 'true');
    const cleanups = images.map((image) => {
      if (image.complete) {
        clearLoading(image);
        return () => {};
      }

      setLoading(image);
      const onDone = () => clearLoading(image);
      image.addEventListener('load', onDone);
      image.addEventListener('error', onDone);
      return () => {
        image.removeEventListener('load', onDone);
        image.removeEventListener('error', onDone);
      };
    });

    return () => {
      cleanups.forEach((cleanup) => {
        cleanup();
      });
    };
  }, [html, markdown]);

  useEffect(() => {
    const image = imagePreviewRef.current;
    setImagePreviewLoading(!(imagePreview && image && image.complete));
  }, [imagePreview]);

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

  const onRenderedMarkdownClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    pointerDraggedRef.current = false;
    pointerDownRef.current = false;
    pointerDownPositionRef.current = null;

    const image = target?.closest('img');
    if (image && onImageClick) {
      event.preventDefault();
      onImageClick(image);
      return;
    }

    if (!onInternalLinkNavigate) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = target?.closest('a');
    if (!anchor) return;
    hidePreview();
    if (anchor.hasAttribute('download')) return;

    const href = (anchor.getAttribute('href') || '').trim();
    if (!href || href.startsWith('?')) return;
    if (href.startsWith('#')) {
      if (containScroll) {
        event.preventDefault();
        scrollToHash(href, 'smooth');
      }
      return;
    }
    if (isExternalHttpHref(href)) return;

    const resolved = new URL(href, window.location.href);
    if (resolved.origin !== window.location.origin) return;

    if (resolved.pathname === window.location.pathname && resolved.search === window.location.search && resolved.hash) {
      if (resolved.hash === window.location.hash) {
        event.preventDefault();
        scrollToHash(resolved.hash, 'smooth');
      }
      return;
    }

    event.preventDefault();
    const route = resolved.pathname.replace(/^\//, '');
    onInternalLinkNavigate(route);
    if (resolved.hash) {
      window.history.replaceState(window.history.state, '', `${resolved.pathname}${resolved.search}${resolved.hash}`);
    }
  };

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
      if (!markdown) return;
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
      markdown,
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

  return (
    <div
      class={`content-view ${imagePreview ? 'content-view--image' : markdown ? 'content-view--markdown' : 'content-view--plain'}`}
    >
      {alertMessage ? (
        <ContentAlert>
          <span class="content-alert-caption">
            {alertMessage}
          </span>
          {alertDownloadHref ? (
            <a href={alertDownloadHref} download={alertDownloadName ?? undefined} class="content-alert-link">
              Download
            </a>
          ) : null}
        </ContentAlert>
      ) : null}
      {loading ? (
        <div class="content-loading-shell" role="status" aria-label="Loading content">
          <span class="content-spinner" aria-hidden="true" />
        </div>
      ) : isEmpty ? (
        <p class="content-empty-placeholder">This file is empty.</p>
      ) : imagePreview ? (
        <div class="content-image-preview">
          <img
            ref={imagePreviewRef}
            class="content-image-preview-image"
            src={imagePreview.src}
            alt={imagePreview.alt}
            data-image-loading={imagePreviewLoading ? 'true' : 'false'}
            onLoad={() => setImagePreviewLoading(false)}
            onError={() => setImagePreviewLoading(false)}
            onClick={(event) => onImageClick?.(event.currentTarget)}
          />
        </div>
      ) : markdown ? (
        <div
          ref={renderedMarkdownRef}
          class="rendered-markdown"
          onClick={onRenderedMarkdownClick}
          onMouseDown={onRenderedMarkdownMouseDown}
          onMouseUp={onRenderedMarkdownMouseUp}
          onMouseMove={onRenderedMarkdownMouseMove}
          onMouseLeave={hidePreview}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : plainText !== null ? (
        <TextCodeView content={plainText} fileName={plainTextFileName} scrollStorageKey={scrollStorageKey} />
      ) : (
        <pre class="rendered-content" dangerouslySetInnerHTML={{ __html: html }} />
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
