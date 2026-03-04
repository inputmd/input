import { useCallback, useEffect, useRef } from 'preact/hooks';
import { ContentAlert } from '../components/ContentAlert';
import { isExternalHttpHref } from '../util';

interface ContentViewProps {
  html: string;
  markdown: boolean;
  imagePreview?: { src: string; alt: string } | null;
  claudeTranscript?: boolean;
  alertMessage?: string | null;
  alertDownloadHref?: string | null;
  alertDownloadName?: string | null;
  onInternalLinkNavigate?: (route: string) => void;
  onImageClick?: (src: string, alt: string) => void;
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
  onImageClick,
}: ContentViewProps) {
  const renderedMarkdownRef = useRef<HTMLDivElement | null>(null);
  const selectedClaudeMessageIndexRef = useRef<number>(-1);
  const isEmpty = html.trim().length === 0 && !imagePreview;

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

    const getMessages = () => Array.from(root.querySelectorAll<HTMLElement>('.claude-chat-message'));
    updateSelectedClaudeMessage(getMessages(), 0);

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
      const currentIndex = selectedClaudeMessageIndexRef.current >= 0 ? selectedClaudeMessageIndexRef.current : 0;

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        updateSelectedClaudeMessage(messages, currentIndex - 1, 'vertical');
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        updateSelectedClaudeMessage(messages, currentIndex + 1, 'vertical');
        return;
      }

      const direction = event.key === 'ArrowRight' ? 1 : -1;
      let nextIndex = currentIndex + direction;
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
  }, [claudeTranscript, html, markdown, updateSelectedClaudeMessage]);

  const onRenderedMarkdownClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (claudeTranscript) {
      const root = renderedMarkdownRef.current;
      const clickedMessage = target?.closest('.claude-chat-message');
      if (root && clickedMessage instanceof HTMLElement) {
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

  return (
    <div
      class={`content-view ${imagePreview ? 'content-view--image' : markdown ? 'content-view--markdown' : 'content-view--plain'} ${claudeTranscript ? 'content-view--claude-chat' : ''}`}
    >
      {alertMessage ? (
        <ContentAlert>
          <span>{alertMessage}</span>
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
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre class="rendered-content" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
