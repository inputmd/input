import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ContentAlert } from '../components/ContentAlert';
import { isExternalHttpHref } from '../util';

interface MarkdownLinkPreview {
  title: string;
  html: string;
}

interface ContentViewProps {
  html: string;
  markdown: boolean;
  imagePreview?: { src: string; alt: string } | null;
  claudeTranscript?: boolean;
  alertMessage?: string | null;
  alertDownloadHref?: string | null;
  alertDownloadName?: string | null;
  onInternalLinkNavigate?: (route: string) => void;
  onRequestMarkdownLinkPreview?: (route: string) => Promise<MarkdownLinkPreview | null>;
  onImageClick?: (src: string, alt: string) => void;
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

const CLAUDE_CODE_ASCII_BANNER = ` ▐▛███▜▌
▝▜█████▛▘
  ▘▘ ▝▝`;

function isMarkdownHref(href: string): boolean {
  return /\.md(?:own|wn)?(?:$|[?#])|\.markdown(?:$|[?#])/i.test(href);
}

function lastPathSegment(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  const parts = withoutQuery.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

export function ContentView({
  html,
  markdown,
  imagePreview,
  claudeTranscript,
  alertMessage,
  alertDownloadHref,
  alertDownloadName,
  onInternalLinkNavigate,
  onRequestMarkdownLinkPreview,
  onImageClick,
}: ContentViewProps) {
  const renderedMarkdownRef = useRef<HTMLDivElement | null>(null);
  const selectedClaudeMessageIndexRef = useRef<number>(-1);
  const hoverAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const hoverRequestIdRef = useRef(0);
  const hoverDelayTimerRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const pointerDraggedRef = useRef(false);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<LinkPreviewState>({
    visible: false,
    loading: false,
    top: 0,
    left: 0,
    title: '',
    html: '',
    url: null,
  });
  const [collapseAssistantMessages, setCollapseAssistantMessages] = useState(true);
  const isEmpty = html.trim().length === 0 && !imagePreview;

  useEffect(() => {
    if (!claudeTranscript) setCollapseAssistantMessages(true);
  }, [claudeTranscript]);

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

  const updateSelectedClaudeMessage = useCallback(
    (messages: HTMLElement[], nextIndex: number, scrollMode: 'nearest' | 'vertical' = 'nearest') => {
      if (messages.length === 0) {
        selectedClaudeMessageIndexRef.current = -1;
        return;
      }
      const boundedIndex = Math.max(0, Math.min(nextIndex, messages.length - 1));
      messages.forEach((message, idx) => {
        message.classList.toggle('claude-chat-message--active', idx === boundedIndex);
      });
      selectedClaudeMessageIndexRef.current = boundedIndex;

      const selectedMessage = messages[boundedIndex];
      if (!selectedMessage) return;
      if (scrollMode === 'vertical') {
        const viewportHeight = window.innerHeight;
        const messageHeight = selectedMessage.getBoundingClientRect().height;
        const canCenter = messageHeight <= viewportHeight * 0.75;
        if (canCenter) {
          selectedMessage.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
          return;
        }
        const toolbar = document.querySelector<HTMLElement>('.toolbar');
        const headerBottom = toolbar?.getBoundingClientRect().bottom ?? 0;
        const topGap = 8;
        const messageTopInViewport = selectedMessage.getBoundingClientRect().top;
        const targetTop = window.scrollY + messageTopInViewport - headerBottom - topGap;
        window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
        return;
      }
      selectedMessage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    [],
  );

  useEffect(() => {
    if (!claudeTranscript || !markdown) return;
    if (html.length === 0) return;
    const root = renderedMarkdownRef.current;
    if (!root) return;

    const assistantMessages = Array.from(root.querySelectorAll<HTMLElement>('.claude-chat-message--assistant'));
    assistantMessages.forEach((message) => {
      if (collapseAssistantMessages) {
        message.classList.add('claude-chat-message--collapsed');
      } else {
        message.classList.remove('claude-chat-message--collapsed');
      }
    });

    const getMessages = () => Array.from(root.querySelectorAll<HTMLElement>('.claude-chat-message'));
    selectedClaudeMessageIndexRef.current = -1;
    getMessages().forEach((message) => {
      message.classList.remove('claude-chat-message--active');
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          event.target.closest('input, textarea, select, [contenteditable="true"]') !== null)
      ) {
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;

      const messages = getMessages();
      if (messages.length === 0) return;
      const currentIndex = selectedClaudeMessageIndexRef.current;

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        updateSelectedClaudeMessage(messages, currentIndex >= 0 ? currentIndex - 1 : messages.length - 1, 'vertical');
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        updateSelectedClaudeMessage(messages, currentIndex >= 0 ? currentIndex + 1 : 0, 'vertical');
        return;
      }

      const direction = event.key === 'ArrowRight' ? 1 : -1;
      let nextIndex =
        currentIndex >= 0 ? currentIndex + direction : event.key === 'ArrowRight' ? 0 : messages.length - 1;
      while (nextIndex >= 0 && nextIndex < messages.length) {
        if (messages[nextIndex]?.classList.contains('claude-chat-message--user')) {
          event.preventDefault();
          updateSelectedClaudeMessage(messages, nextIndex, 'vertical');
          return;
        }
        nextIndex += direction;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [claudeTranscript, collapseAssistantMessages, html, markdown, updateSelectedClaudeMessage]);

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
    const dragged = pointerDraggedRef.current;
    pointerDraggedRef.current = false;
    pointerDownRef.current = false;
    pointerDownPositionRef.current = null;
    if (claudeTranscript) {
      const root = renderedMarkdownRef.current;
      const clickedMessage = target?.closest('.claude-chat-message');
      if (root && clickedMessage instanceof HTMLElement) {
        const clickedInteractiveElement = target?.closest('a, button, input, textarea, select, label, img');
        const selection = window.getSelection();
        let hasSelectionInsideMessage = false;
        if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
          const commonAncestor = selection.getRangeAt(0).commonAncestorContainer;
          const commonElement =
            commonAncestor.nodeType === Node.ELEMENT_NODE ? (commonAncestor as Element) : commonAncestor.parentElement;
          hasSelectionInsideMessage = !!commonElement && clickedMessage.contains(commonElement);
        }
        if (
          collapseAssistantMessages &&
          clickedMessage.classList.contains('claude-chat-message--assistant') &&
          !dragged &&
          !hasSelectionInsideMessage &&
          !clickedInteractiveElement
        ) {
          clickedMessage.classList.toggle('claude-chat-message--collapsed');
        }
        const messages = Array.from(root.querySelectorAll<HTMLElement>('.claude-chat-message'));
        const clickedIndex = messages.indexOf(clickedMessage);
        if (clickedIndex >= 0) updateSelectedClaudeMessage(messages, clickedIndex);
      }
    }

    const image = target?.closest('img');
    if (image && onImageClick) {
      const imageSrc = image.getAttribute('src')?.trim();
      if (!imageSrc) return;
      event.preventDefault();
      onImageClick(imageSrc, image.getAttribute('alt') ?? '');
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
    if (!href || href.startsWith('#') || href.startsWith('?')) return;
    if (isExternalHttpHref(href)) return;

    const resolved = new URL(href, window.location.href);
    if (resolved.origin !== window.location.origin) return;

    event.preventDefault();
    const route = resolved.pathname.replace(/^\//, '');
    onInternalLinkNavigate(route);
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
      class={`content-view ${imagePreview ? 'content-view--image' : markdown ? 'content-view--markdown' : 'content-view--plain'} ${claudeTranscript ? 'content-view--claude-chat' : ''}`}
    >
      {alertMessage ? (
        <ContentAlert className={claudeTranscript && markdown ? 'content-alert--claude' : undefined}>
          {claudeTranscript && markdown ? (
            <div class="content-alert-claude-banner-wrap">
              <pre class="content-alert-claude-banner" aria-hidden="true">
                {CLAUDE_CODE_ASCII_BANNER}
              </pre>
            </div>
          ) : null}
          <span class={`content-alert-caption ${claudeTranscript && markdown ? 'content-alert-caption--small' : ''}`}>
            {alertMessage}
          </span>
          {claudeTranscript && markdown ? (
            <label class="claude-chat-compact-toggle">
              <input
                type="checkbox"
                class="claude-chat-compact-toggle-checkbox"
                checked={collapseAssistantMessages}
                onChange={(event) => setCollapseAssistantMessages((event.currentTarget as HTMLInputElement).checked)}
              />
              <span>Compact</span>
            </label>
          ) : null}
          {alertDownloadHref ? (
            <a href={alertDownloadHref} download={alertDownloadName ?? undefined} class="content-alert-link">
              Download
            </a>
          ) : null}
        </ContentAlert>
      ) : null}
      {isEmpty ? (
        <p class="content-empty-placeholder">This file is empty.</p>
      ) : imagePreview ? (
        <div class="content-image-preview">
          <img
            class="content-image-preview-image"
            src={imagePreview.src}
            alt={imagePreview.alt}
            onClick={() => onImageClick?.(imagePreview.src, imagePreview.alt)}
          />
        </div>
      ) : markdown ? (
        <div
          ref={renderedMarkdownRef}
          class={`rendered-markdown ${claudeTranscript ? 'rendered-markdown--claude-chat' : ''}`}
          onClick={onRenderedMarkdownClick}
          onMouseDown={onRenderedMarkdownMouseDown}
          onMouseUp={onRenderedMarkdownMouseUp}
          onMouseMove={onRenderedMarkdownMouseMove}
          onMouseLeave={hidePreview}
          dangerouslySetInnerHTML={{ __html: html }}
        />
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
            <div class="markdown-link-preview-url">{preview.url}</div>
          ) : (
            <div class="markdown-link-preview-body" dangerouslySetInnerHTML={{ __html: preview.html }} />
          )}
        </div>
      ) : null}
    </div>
  );
}
