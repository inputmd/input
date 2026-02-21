import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

function wikiSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[/\\]/g, '-')
    .replace(/\s+/g, '-');
}

function isExternalHttpHref(href: string): boolean {
  const protocolMatch = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!protocolMatch) return false;
  const protocol = protocolMatch[1].toLowerCase();
  return protocol === 'http' || protocol === 'https';
}

marked.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start(src: string) {
        return src.indexOf('[[');
      },
      tokenizer(src: string) {
        const match = /^\[\[([^[\]\|]+)(?:\|([^[\]\|]+))?\]\]/.exec(src);
        if (!match) return undefined;
        const target = match[1].trim();
        if (!target) return undefined;
        const label = (match[2] ?? target).trim();
        const slug = wikiSlug(target);
        const href = `${encodeURIComponent(slug)}.md`;
        return {
          type: 'link',
          raw: match[0],
          href,
          text: label,
          tokens: this.lexer.inlineTokens(label),
        };
      },
    },
  ],
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
        if (!isExternalHttpHref(href)) {
          delete attribs.target;
          delete attribs.rel;
          return { tagName, attribs: { ...attribs, href } };
        }
        return {
          tagName,
          attribs: { ...attribs, href, target: '_blank', rel: 'noopener noreferrer' },
        };
      },
    },
  });
}
