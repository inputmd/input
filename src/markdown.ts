import DOMPurify from 'dompurify';
import matter from 'gray-matter';
import { marked } from 'marked';
import { isExternalHttpHref } from './util';

marked.setOptions({
  gfm: true,
});

const WEB_TLDS = new Set(['com', 'org', 'net', 'app', 'dev', 'xyz']);

function wikiSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[/\\]/g, '-').replace(/\s+/g, '-');
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
          type: 'wikilink',
          raw: match[0],
          href,
          wikiTargetPath: `${slug}.md`,
          text: label,
          tokens: this.lexer.inlineTokens(label),
        };
      },
      renderer(token) {
        const labelHtml = this.parser.parseInline(token.tokens ?? []);
        return `<a href="${escapeHtmlAttr(token.href)}" data-wikilink="true" data-wiki-target-path="${escapeHtmlAttr(token.wikiTargetPath)}">${labelHtml}</a>`;
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

function createQuestionLinkIndicator(className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
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

interface ParseMarkdownOptions {
  breaks?: boolean;
  resolveImageSrc?: (src: string) => string | null;
  resolveWikiLinkMeta?: (targetPath: string) => { exists: boolean; resolvedHref?: string | null } | null;
}

function extractMarkdownBody(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '');
  const candidate = normalized.replace(/^(?:[ \t]*\r?\n)+/, '');
  const fallbackStrip = (source: string): string => {
    const lines = source.split(/\r?\n/);
    if (lines.length < 3) return source;
    const opening = lines[0].trim();
    if (opening !== '---' && opening !== '+++') return source;
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === opening || line === '...') {
        return lines.slice(i + 1).join('\n');
      }
    }
    return source;
  };

  try {
    const parsed = matter(candidate);
    if (parsed.matter) return parsed.content;
    // Belt-and-suspenders fallback: still strip obvious fenced front matter if parser detection misses.
    return fallbackStrip(candidate);
  } catch {
    // Keep rendering content if gray-matter fails at runtime, without showing front matter to users.
    return fallbackStrip(candidate);
  }
}

function shouldSkipSmartPunctuation(node: Node | null): boolean {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement) {
      const tagName = current.tagName;
      if (tagName === 'CODE' || tagName === 'PRE' || tagName === 'KBD' || tagName === 'SAMP') {
        return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

function applySmartPunctuation(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && !shouldSkipSmartPunctuation(current.parentNode)) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  for (const node of textNodes) {
    // Only convert either " -- " or tight "word--word", leaving mixed spacing untouched.
    node.textContent = (node.textContent ?? '').replace(/(?<= )--(?= )|(?<=\S)--(?=\S)/g, '—');
  }
}

export function parseMarkdownToHtml(text: string, options?: ParseMarkdownOptions): string {
  const markdown = extractMarkdownBody(text);
  const raw = marked.parse(markdown, { gfm: true, breaks: options?.breaks ?? true }) as string;
  const sanitized = DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel', 'data-wikilink', 'data-wiki-target-path'] });
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
      anchor.insertAdjacentElement('afterend', createQuestionLinkIndicator('hash-link-indicator'));
    }

    const isWikiLink = anchor.getAttribute('data-wikilink') === 'true';
    if (isWikiLink && options?.resolveWikiLinkMeta) {
      const wikiTargetPath = (anchor.getAttribute('data-wiki-target-path') ?? '').trim();
      if (wikiTargetPath) {
        const wikiMeta = options.resolveWikiLinkMeta(wikiTargetPath);
        if (wikiMeta?.resolvedHref) {
          const resolvedWikiHref = sanitizeMarkdownHref(wikiMeta.resolvedHref);
          if (resolvedWikiHref != null) {
            anchor.setAttribute('href', resolvedWikiHref);
          }
        }
        if (wikiMeta && !wikiMeta.exists) {
          anchor.insertAdjacentElement('afterend', createQuestionLinkIndicator('missing-wikilink-indicator'));
        }
      }
    }

    if (isExternalHttpHref(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      return;
    }

    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
  });

  template.content.querySelectorAll('img').forEach((img: HTMLImageElement) => {
    const src = (img.getAttribute('src') ?? '').trim();
    if (!src) return;
    const resolvedSrc = options?.resolveImageSrc ? options.resolveImageSrc(src) : src;
    if (!resolvedSrc) {
      img.removeAttribute('src');
      return;
    }
    img.setAttribute('src', resolvedSrc);
  });

  applySmartPunctuation(template.content);

  return template.innerHTML;
}
