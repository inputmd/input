import { ExternalLink } from 'lucide-react';
import type { LinkPreviewState } from '../markdown_link_preview';

interface MarkdownLinkPreviewPopoverProps {
  preview: LinkPreviewState;
  contained?: boolean;
}

export function MarkdownLinkPreviewPopover({ preview, contained = false }: MarkdownLinkPreviewPopoverProps) {
  if (!preview.visible) return null;

  return (
    <div
      class={`markdown-link-preview-popover${preview.url ? ' markdown-link-preview-popover--url' : ''}${contained ? ' markdown-link-preview-popover--contained' : ''}`}
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
  );
}
