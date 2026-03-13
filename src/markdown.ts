import DOMPurify from 'dompurify';
import matter from 'gray-matter';
import { marked } from 'marked';
import { parseImageDimensionTitle } from './image_markdown';
import { encodePathForHref, isExternalHttpHref } from './util';

marked.setOptions({
  gfm: true,
});

const WEB_TLDS = new Set(['com', 'org', 'net', 'app', 'dev', 'xyz']);

function wikiSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[/\\]/g, '-').replace(/\s+/g, '-');
}

function slugifyHeadingId(raw: string): string {
  const text = raw
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const cleaned = text
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'section';
}

function assignHeadingIds(fragment: DocumentFragment): void {
  const seen = new Map<string, number>();
  fragment.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const existingId = (heading.getAttribute('id') ?? '').trim();
    if (existingId) {
      seen.set(existingId, (seen.get(existingId) ?? 0) + 1);
      return;
    }

    const base = slugifyHeadingId(heading.textContent ?? '');
    const nextCount = (seen.get(base) ?? 0) + 1;
    seen.set(base, nextCount);
    const id = nextCount === 1 ? base : `${base}-${nextCount}`;
    heading.setAttribute('id', id);
  });
}

function normalizeWikiTargetPath(raw: string): string {
  const trimmed = raw.trim();
  const hasExplicitPathSeparators = /[/\\]/.test(trimmed);
  const basePath = hasExplicitPathSeparators ? trimmed.replace(/\\/g, '/') : wikiSlug(trimmed);
  if (/\.(?:md|markdown)$/i.test(basePath)) return basePath;
  return `${basePath}.md`;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

marked.use({
  tokenizer: {
    // Disable setext headings (`text` followed by `---`/`===`) so lone dashes stay literal content.
    lheading() {
      return undefined;
    },
  },
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
        const wikiTargetPath = normalizeWikiTargetPath(target);
        const href = encodePathForHref(wikiTargetPath);
        return {
          type: 'wikilink',
          raw: match[0],
          href,
          wikiTargetPath,
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

function createExternalLinkIndicator(className: string): HTMLSpanElement {
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

  const path1 = document.createElementNS(svgNs, 'path');
  path1.setAttribute('d', 'M21 3h-6');

  const path2 = document.createElementNS(svgNs, 'path');
  path2.setAttribute('d', 'M21 3v6');

  const path3 = document.createElementNS(svgNs, 'path');
  path3.setAttribute('d', 'm21 3-7 7');

  const path4 = document.createElementNS(svgNs, 'path');
  path4.setAttribute('d', 'M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4');

  svg.append(path1, path2, path3, path4);
  span.append(svg);
  return span;
}

interface ParseMarkdownOptions {
  breaks?: boolean;
  resolveImageSrc?: (src: string) => string | null;
  resolveWikiLinkMeta?: (targetPath: string) => { exists: boolean; resolvedHref?: string | null } | null;
  claudeTranscript?: boolean;
}

interface ExtractedFootnotes {
  markdown: string;
  definitions: Map<string, string>;
}

interface FootnoteReferences {
  order: string[];
  referenceIds: Map<string, string[]>;
}

function extractFootnotes(markdown: string): ExtractedFootnotes {
  const lines = markdown.split(/\r?\n/);
  const definitions = new Map<string, string>();
  const body: string[] = [];

  let inFence = false;
  let fenceMarker = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const markerChar = marker[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = markerChar;
      } else if (markerChar === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      body.push(line);
      continue;
    }

    if (inFence) {
      body.push(line);
      continue;
    }

    const definitionMatch = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(line);
    if (!definitionMatch) {
      body.push(line);
      continue;
    }

    const id = definitionMatch[1];
    const contentLines = [definitionMatch[2]];

    let lookahead = index + 1;
    while (lookahead < lines.length) {
      const continuation = lines[lookahead];
      if (/^\s*$/.test(continuation)) {
        contentLines.push('');
        lookahead += 1;
        continue;
      }
      if (/^(?: {2,}|\t)/.test(continuation)) {
        contentLines.push(continuation.replace(/^(?: {1,4}|\t)/, ''));
        lookahead += 1;
        continue;
      }
      break;
    }

    definitions.set(id, contentLines.join('\n').trim());
    index = lookahead - 1;
  }

  return { markdown: body.join('\n'), definitions };
}

function footnoteId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'note';
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

function shouldSkipFootnoteReplacement(node: Node | null): boolean {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement) {
      const tagName = current.tagName;
      if (tagName === 'CODE' || tagName === 'PRE' || tagName === 'KBD' || tagName === 'SAMP' || tagName === 'A') {
        return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

function applyFootnoteReferences(root: ParentNode, definitions: Map<string, string>): FootnoteReferences {
  const order: string[] = [];
  const orderById = new Map<string, number>();
  const referenceIds = new Map<string, string[]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];

  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && !shouldSkipFootnoteReplacement(current.parentNode)) {
      nodes.push(current);
    }
    current = walker.nextNode();
  }

  for (const node of nodes) {
    const text = node.textContent ?? '';
    if (!text.includes('[^')) continue;

    const regex = /\[\^([^\]\s]+)\]/g;
    let match: RegExpExecArray | null;
    let cursor = 0;
    const fragment = document.createDocumentFragment();
    let changed = false;

    while ((match = regex.exec(text))) {
      const rawId = match[1];
      if (!definitions.has(rawId)) continue;
      changed = true;

      const leading = text.slice(cursor, match.index);
      if (leading) fragment.appendChild(document.createTextNode(leading));

      let index = orderById.get(rawId);
      if (index == null) {
        order.push(rawId);
        index = order.length;
        orderById.set(rawId, index);
      }
      const refs = referenceIds.get(rawId) ?? [];
      const domId = footnoteId(rawId);
      const refId = `fnref-${index}-${refs.length + 1}-${domId}`;
      refs.push(refId);
      referenceIds.set(rawId, refs);

      const sup = document.createElement('sup');
      sup.className = 'footnote-ref';
      sup.id = refId;
      const anchor = document.createElement('a');
      anchor.setAttribute('href', `#fn-${domId}`);
      anchor.textContent = `${index}`;
      sup.appendChild(anchor);
      fragment.appendChild(sup);

      cursor = match.index + match[0].length;
    }

    if (!changed) continue;
    const trailing = text.slice(cursor);
    if (trailing) fragment.appendChild(document.createTextNode(trailing));
    node.replaceWith(fragment);
  }

  return { order, referenceIds };
}

function appendFootnotesSection(
  root: DocumentFragment,
  references: FootnoteReferences,
  definitions: Map<string, string>,
): void {
  if (references.order.length === 0) return;

  const section = document.createElement('section');
  section.className = 'footnotes';
  section.setAttribute('aria-label', 'Footnotes');

  const list = document.createElement('ol');
  section.appendChild(list);

  for (const id of references.order) {
    const domId = footnoteId(id);
    const li = document.createElement('li');
    li.id = `fn-${domId}`;

    const definitionMarkdown = definitions.get(id) ?? '';
    const rendered = marked.parse(definitionMarkdown, { gfm: true, breaks: false }) as string;
    const sanitized = DOMPurify.sanitize(rendered, {
      ADD_ATTR: ['target', 'rel', 'data-wikilink', 'data-wiki-target-path'],
    });
    const wrapper = document.createElement('div');
    wrapper.innerHTML = sanitized;
    li.append(...Array.from(wrapper.childNodes));

    const refs = references.referenceIds.get(id) ?? [];
    if (refs.length > 0) {
      const backrefs = document.createElement('span');
      backrefs.className = 'footnote-backrefs';
      for (const refId of refs) {
        const link = document.createElement('a');
        link.className = 'footnote-backref';
        link.setAttribute('href', `#${refId}`);
        link.setAttribute('aria-label', 'Back to reference');
        link.textContent = '↩';
        backrefs.appendChild(link);
      }
      if (li.lastElementChild?.tagName === 'P') {
        li.lastElementChild.append(' ', backrefs);
      } else {
        li.append(' ', backrefs);
      }
    }

    list.appendChild(li);
  }

  root.appendChild(section);
}

function createLucideIcon(
  paths: Array<{ tag: 'path' | 'circle' | 'rect'; attrs: Record<string, string> }>,
): SVGElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const node of paths) {
    const el = document.createElementNS(svgNs, node.tag);
    for (const [key, value] of Object.entries(node.attrs)) {
      el.setAttribute(key, value);
    }
    svg.appendChild(el);
  }
  return svg;
}

function createTranscriptSpeakerIcon(role: 'user' | 'assistant'): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'claude-chat-message-icon';

  const svg =
    role === 'user'
      ? createLucideIcon([
          { tag: 'path', attrs: { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' } },
          { tag: 'circle', attrs: { cx: '12', cy: '7', r: '4' } },
        ])
      : createLucideIcon([
          { tag: 'path', attrs: { d: 'M12 8V4H8' } },
          { tag: 'rect', attrs: { x: '4', y: '8', width: '16', height: '12', rx: '2' } },
          { tag: 'path', attrs: { d: 'M2 14h2' } },
          { tag: 'path', attrs: { d: 'M20 14h2' } },
          { tag: 'path', attrs: { d: 'M9 13v2' } },
          { tag: 'path', attrs: { d: 'M15 13v2' } },
        ]);

  icon.appendChild(svg);
  return icon;
}

function normalizeTranscriptRole(text: string): 'user' | 'assistant' {
  return /^user$/i.test(text.trim()) ? 'user' : 'assistant';
}

function decorateClaudeTranscript(root: DocumentFragment): void {
  const nodes = Array.from(root.childNodes);
  if (nodes.length === 0) return;

  const container = document.createElement('div');
  container.className = 'claude-chat-transcript';
  let hasMessages = false;

  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node instanceof HTMLElement && node.tagName === 'H2') {
      hasMessages = true;
      const label = node.textContent?.trim() || 'Assistant';
      const role = normalizeTranscriptRole(label);
      const message = document.createElement('section');
      message.className = `claude-chat-message claude-chat-message--${role}`;

      const header = document.createElement('header');
      header.className = 'claude-chat-message-header';
      const title = document.createElement('span');
      title.className = 'claude-chat-message-role';
      title.textContent = label;
      header.append(createTranscriptSpeakerIcon(role), title);

      const body = document.createElement('div');
      body.className = 'claude-chat-message-body';
      index += 1;
      while (index < nodes.length) {
        const next = nodes[index];
        if (next instanceof HTMLElement && next.tagName === 'H2') break;
        body.appendChild(next);
        index += 1;
      }
      message.append(header, body);
      container.appendChild(message);
      continue;
    }
    container.appendChild(node);
    index += 1;
  }

  if (!hasMessages) return;
  root.replaceChildren(container);
}

export function parseMarkdownToHtml(text: string, options?: ParseMarkdownOptions): string {
  const markdown = extractMarkdownBody(text);
  const extractedFootnotes = extractFootnotes(markdown);
  const raw = marked.parse(extractedFootnotes.markdown, { gfm: true, breaks: options?.breaks ?? true }) as string;
  const sanitized = DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel', 'data-wikilink', 'data-wiki-target-path'] });
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  assignHeadingIds(template.content);
  const footnoteReferences = applyFootnoteReferences(template.content, extractedFootnotes.definitions);
  appendFootnotesSection(template.content, footnoteReferences, extractedFootnotes.definitions);

  template.content.querySelectorAll('a').forEach((anchor: HTMLAnchorElement) => {
    const href = sanitizeMarkdownHref(anchor.getAttribute('href') ?? '');
    if (href == null) {
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      return;
    }

    anchor.setAttribute('href', href);

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
          anchor.classList.add('missing-wikilink');
        } else {
          anchor.classList.remove('missing-wikilink');
        }
      }
    }

    if (isExternalHttpHref(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      anchor.insertAdjacentElement('afterend', createExternalLinkIndicator('external-link-indicator'));
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

    const dimensions = parseImageDimensionTitle(img.getAttribute('title'));
    if (!dimensions) return;

    img.setAttribute('width', String(dimensions.width));
    img.setAttribute('height', String(dimensions.height));
    img.removeAttribute('title');
  });

  applySmartPunctuation(template.content);
  if (options?.claudeTranscript) {
    decorateClaudeTranscript(template.content);
  }

  return template.innerHTML;
}
