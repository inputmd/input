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
  const isEmpty = html.trim().length === 0 && !imagePreview;

  const onRenderedMarkdownClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
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
