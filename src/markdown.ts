import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

function sanitizeMarkdownHref(href: string): string | null {
  const normalized = href.trim();
  if (!normalized) return null;

  if (normalized.startsWith('#') || normalized.startsWith('/') || normalized.startsWith('?')) return normalized;

  const protocolMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (protocolMatch) {
    const protocol = protocolMatch[1].toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') return null;
  }

  return normalized;
}

export function parseMarkdownToHtml(text: string): string {
  const raw = marked.parse(text) as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target', 'rel'],
    transformTags: {
      a: (tagName, attrs) => {
        const href = sanitizeMarkdownHref((attrs.href || '').toString());
        const attribs = { ...attrs };
        if (href == null) {
          delete attribs.href;
          return { tagName, attribs };
        }
        return {
          tagName,
          attribs: { ...attribs, href, target: '_blank', rel: 'noopener noreferrer' },
        };
      },
    },
  });
}
