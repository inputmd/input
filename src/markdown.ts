import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { isExternalHttpHref } from './util';

marked.setOptions({
  gfm: true,
  breaks: true,
});

const WEB_TLDS = new Set(['com', 'org', 'net', 'app', 'dev', 'xyz']);

function wikiSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[/\\]/g, '-').replace(/\s+/g, '-');
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
        const match = /^\[\[([^[\]|]+)(?:\|([^[\]|]+))?\]\]/.exec(src);
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

  if (
    normalized.startsWith('#') ||
    normalized.startsWith('/') ||
    normalized.startsWith('?') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../')
  ) {
    return normalized;
  }

  // Treat markdown-looking paths as internal files, e.g. "foo.md" or "notes/foo.markdown".
  if (/(^|\/)[^/?#]+\.(?:md|markdown)(?:$|[?#])/i.test(normalized)) {
    return normalized;
  }

  // Treat "single-label + extension" as file-like (e.g. "foo.txt", "foo.zip"),
  // except for common web TLDs where users typically intend a domain.
  const singleLabelWithExtension = /^([a-zA-Z0-9-]+)\.([a-zA-Z0-9-]+)(?:[/?#]|$)/.exec(normalized);
  if (singleLabelWithExtension) {
    const extension = singleLabelWithExtension[2].toLowerCase();
    const webTlds = WEB_TLDS;
    if (!webTlds.has(extension)) return normalized;
  }

  // Matches "<scheme>:" where scheme starts with a letter and may include RFC3986
  // scheme characters after that (letters, digits, plus, dot, hyphen).
  const protocolMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (protocolMatch) {
    const protocol = protocolMatch[1].toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') return null;
    return normalized;
  }

  // Matches local development hosts without a scheme:
  // "localhost[:port][/...]" or IPv4 "127.0.0.1[:port][/...]".
  if (/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(normalized)) {
    return `http://${normalized}`;
  }

  // Matches public-style hostnames without a scheme:
  // "example.com", "docs.example.com", with optional ":port" and path.
  if (/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/|$)/.test(normalized)) {
    return `https://${normalized}`;
  }

  return normalized;
}

function createHashLinkIndicator(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'hash-link-indicator';
  span.setAttribute('aria-hidden', 'true');

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  const circle = document.createElementNS(svgNs, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');

  const pathTop = document.createElementNS(svgNs, 'path');
  pathTop.setAttribute('d', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3');

  const pathBottom = document.createElementNS(svgNs, 'path');
  pathBottom.setAttribute('d', 'M12 17h.01');

  svg.append(circle, pathTop, pathBottom);
  span.append(svg);
  return span;
}

export function parseMarkdownToHtml(text: string): string {
  const raw = marked.parse(text) as string;
  const sanitized = DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
  const template = document.createElement('template');
  template.innerHTML = sanitized;

  template.content.querySelectorAll('a').forEach((anchor: HTMLAnchorElement) => {
    const href = sanitizeMarkdownHref(anchor.getAttribute('href') ?? '');
    if (href == null) {
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      return;
    }

    anchor.setAttribute('href', href);
    if (href.startsWith('#')) {
      anchor.insertAdjacentElement('afterend', createHashLinkIndicator());
    }
    if (isExternalHttpHref(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      return;
    }

    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
  });

  return template.innerHTML;
}
