import DOMPurify from 'dompurify';
import { nameToEmoji } from 'gemoji';
import type { RendererThis, Token, TokenizerThis, Tokens } from 'marked';
import { marked } from 'marked';
import { parseImageDimensionTitle } from './image_markdown.ts';
import { matchPromptListLine } from './prompt_list_syntax.ts';
import { encodePathForHref, isExternalHttpHref } from './util.ts';

marked.setOptions({
  gfm: true,
});

const domPurify = DOMPurify as unknown as {
  sanitize?: (dirty: string, config?: object) => string;
  (window: Window): { sanitize: (dirty: string, config?: object) => string };
};

const WEB_TLDS = new Set(['com', 'org', 'net', 'app', 'dev', 'xyz']);

interface PromptListToken extends Tokens.Generic {
  type: 'promptList';
  items: Array<{
    kind: 'question' | 'answer';
    className: 'prompt-question' | 'prompt-answer';
    renderAsBlock: boolean;
    tokens: Token[];
  }>;
}

function isPromptListContinuationLine(text: string, indent: string): boolean {
  return text.startsWith(`${indent}  `) || text.startsWith(`${indent}\t`);
}

function stripPromptListContinuationIndent(text: string, indent: string): string {
  if (text.startsWith(`${indent}  `)) return text.slice(`${indent}  `.length);
  if (text.startsWith(`${indent}\t`)) return text.slice(`${indent}\t`.length);
  return text;
}

function isPromptListBlockConstruct(text: string): boolean {
  return /^(?:[-+*][ \t]|\d+\.[ \t]|>[ \t]?|#{1,6}[ \t]|```|~~~)/u.test(text);
}

function stripPromptListResumedContinuationIndent(text: string, indent: string): string {
  const threeSpaceIndent = `${indent}   `;
  const fourSpaceIndent = `${indent}    `;
  if (text.startsWith(threeSpaceIndent) && !text.startsWith(fourSpaceIndent)) {
    const candidate = text.slice(threeSpaceIndent.length);
    if (!isPromptListBlockConstruct(candidate)) return candidate;
  }
  return stripPromptListContinuationIndent(text, indent);
}

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

function parseEmojiShortcode(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!/^[a-z0-9_+-]+$/.test(normalized)) return null;
  return nameToEmoji[normalized] ?? null;
}

function parseGitHubHandle(raw: string): string | null {
  const trimmed = raw.trim();
  const normalized = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized) && !/^[A-Za-z0-9]$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function deriveSuperscriptLinkLabel(text: string, href: string): string {
  if (text !== 'src') return text;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return text;
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (
      hostname !== 'twitter.com' &&
      hostname !== 'www.twitter.com' &&
      hostname !== 'x.com' &&
      hostname !== 'www.x.com'
    ) {
      return hostname.replace(/^www\./, '');
    }
  }

  if (
    hostname !== 'twitter.com' &&
    hostname !== 'www.twitter.com' &&
    hostname !== 'x.com' &&
    hostname !== 'www.x.com'
  ) {
    return text;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment || firstSegment.toLowerCase() === 'i') return text;

  return firstSegment;
}

marked.use({
  tokenizer: {
    // Disable setext headings (`text` followed by `---`/`===`) so lone dashes stay literal content.
    lheading() {
      return undefined;
    },
    // Keep indented code blocks disabled. Renderer-side indentation preservation
    // relies on leading spaces staying plain text instead of being promoted to
    // `<pre><code>`, so do not re-enable this without replacing that behavior.
    code() {
      return undefined;
    },
  },
  extensions: [
    {
      name: 'promptList',
      level: 'block',
      start(src: string) {
        const match = /(?:^|\n)(?: {0,3})-(?:\*|⏺)[ \t]+/u.exec(src);
        return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined;
      },
      tokenizer(this: TokenizerThis, src: string) {
        const sourceLines = src.split('\n');
        let lineIndex = 0;
        const items: PromptListToken['items'] = [];
        const rawLines: string[] = [];

        while (lineIndex < sourceLines.length) {
          const rawLine = sourceLines[lineIndex];
          const line = rawLine.replace(/\r$/, '');
          const match = matchPromptListLine(line);
          if (!match) break;

          const contentLines = [match.content];
          rawLines.push(rawLine);

          let nextIndex = lineIndex + 1;
          while (nextIndex < sourceLines.length) {
            const continuationRawLine = sourceLines[nextIndex];
            const continuationLine = continuationRawLine.replace(/\r$/, '');
            if (matchPromptListLine(continuationLine)) break;

            if (/^\s*$/.test(continuationLine)) {
              const blankLines: string[] = [];
              let scanIndex = nextIndex;
              while (scanIndex < sourceLines.length) {
                const scanLine = sourceLines[scanIndex].replace(/\r$/, '');
                if (!/^\s*$/.test(scanLine)) break;
                blankLines.push('');
                scanIndex += 1;
              }

              if (scanIndex >= sourceLines.length) break;

              const resumedLine = sourceLines[scanIndex].replace(/\r$/, '');
              if (matchPromptListLine(resumedLine)) break;
              if (!isPromptListContinuationLine(resumedLine, match.indent)) break;

              contentLines.push(...blankLines);
              contentLines.push(stripPromptListResumedContinuationIndent(resumedLine, match.indent));
              rawLines.push(...sourceLines.slice(nextIndex, scanIndex + 1));
              nextIndex = scanIndex + 1;
              continue;
            }

            if (!isPromptListContinuationLine(continuationLine, match.indent)) break;

            contentLines.push(stripPromptListContinuationIndent(continuationLine, match.indent));
            rawLines.push(continuationRawLine);
            nextIndex += 1;
          }

          const content = contentLines.join('\n').trimEnd();
          const renderAsBlock = content.includes('\n') || /^\s*$/.test(content);
          const tokens = renderAsBlock ? this.lexer.blockTokens(content) : this.lexer.inlineTokens(content);

          items.push({
            kind: match.kind,
            className: match.kind === 'question' ? 'prompt-question' : 'prompt-answer',
            renderAsBlock,
            tokens,
          });

          lineIndex = nextIndex;
        }

        if (items.length === 0) return undefined;

        return {
          type: 'promptList',
          raw: rawLines.join('\n'),
          items,
        };
      },
      renderer(this: RendererThis<string, string>, token: Tokens.Generic) {
        const promptListToken = token as PromptListToken;

        const itemsHtml = promptListToken.items
          .map((item) => {
            const isSingleParagraphBlock =
              item.renderAsBlock &&
              item.tokens.length === 1 &&
              item.tokens[0]?.type === 'paragraph' &&
              'tokens' in item.tokens[0];
            const contentHtml = !item.renderAsBlock
              ? this.parser.parseInline(item.tokens ?? [])
              : isSingleParagraphBlock
                ? this.parser.parseInline((item.tokens[0] as Tokens.Paragraph).tokens ?? [])
                : this.parser.parse(item.tokens ?? []);
            return `<li class="${item.className}">${contentHtml}</li>`;
          })
          .join('');
        return `<ul class="prompt-list">${itemsHtml}</ul>`;
      },
    },
    {
      name: 'emojiShortcode',
      level: 'inline',
      start(src: string) {
        return src.indexOf(':');
      },
      tokenizer(src: string) {
        const match = /^:([a-zA-Z0-9_+-]+):/.exec(src);
        if (!match) return undefined;
        const emoji = parseEmojiShortcode(match[1]);
        if (!emoji) return undefined;
        return {
          type: 'emojiShortcode',
          raw: match[0],
          emoji,
          shortcode: match[1],
        };
      },
      renderer(token) {
        return `<span class="emoji-shortcode" role="img" aria-label="${escapeHtmlAttr(token.shortcode)} emoji">${token.emoji}</span>`;
      },
    },
    {
      name: 'superscript',
      level: 'inline',
      start(src: string) {
        return src.indexOf('^');
      },
      tokenizer(src: string) {
        const match = /^\^([^^\s](?:.*?[^^\s])?)\^/.exec(src);
        if (!match) return undefined;
        const text = match[1];
        if (!text.trim()) return undefined;
        return {
          type: 'superscript',
          raw: match[0],
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      },
      renderer(token) {
        return `<sup>${this.parser.parseInline(token.tokens ?? [])}</sup>`;
      },
    },
    {
      name: 'githubAvatar',
      level: 'inline',
      start(src: string) {
        return src.indexOf('{github:');
      },
      tokenizer(src: string) {
        const match = /^\{github:([^}\n]+)\}/.exec(src);
        if (!match) return undefined;
        const username = parseGitHubHandle(match[1]);
        if (!username) return undefined;
        return {
          type: 'githubAvatar',
          raw: match[0],
          username,
          href: `https://github.com/${username}`,
          src: `https://github.com/${username}.png?size=32`,
        };
      },
      renderer(token) {
        const username = escapeHtmlAttr(token.username);
        return `<a class="github-inline-avatar" href="${escapeHtmlAttr(token.href)}" aria-label="@${username} on GitHub"><img src="${escapeHtmlAttr(token.src)}" alt="@${username}" loading="lazy" decoding="async"></a>`;
      },
    },
    {
      name: 'superscriptLink',
      level: 'inline',
      start(src: string) {
        return src.indexOf('[^');
      },
      tokenizer(src: string) {
        const match = /^\[\^([^\]\n]+)\]\(([^)\s]+)\)/.exec(src);
        if (!match) return undefined;
        const text = match[1].trim();
        const href = match[2].trim();
        if (!text || !href) return undefined;
        return {
          type: 'superscriptLink',
          raw: match[0],
          href,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      },
      renderer(token) {
        const label = deriveSuperscriptLinkLabel(token.text, token.href);
        const labelHtml = label === token.text ? this.parser.parseInline(token.tokens ?? []) : escapeHtmlAttr(label);
        return `<sup class="superscript-link"><a href="${escapeHtmlAttr(token.href)}">${labelHtml}</a></sup>`;
      },
    },
    {
      name: 'bracketedText',
      level: 'inline',
      start(src: string) {
        return src.indexOf('[');
      },
      tokenizer(src: string) {
        const match = /^\[([^[\]\n]+)\](?!\(|\[|:)/.exec(src);
        if (!match) return undefined;
        const text = match[1].trim();
        if (!text || text.startsWith('^')) return undefined;
        return {
          type: 'bracketedText',
          raw: match[0],
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      },
      renderer(token) {
        return `<span class="bracketed-text">${this.parser.parseInline(token.tokens ?? [])}</span>`;
      },
    },
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

interface ParseMarkdownOptions {
  breaks?: boolean;
  resolveImageSrc?: (src: string) => string | null;
  resolveWikiLinkMeta?: (targetPath: string) => { exists: boolean; resolvedHref?: string | null } | null;
}

export interface ParsedMarkdownDocument {
  html: string;
  customCss: string | null;
  customCssScope: string | null;
  frontMatterError: string | null;
  cssWarning: string | null;
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

function countIndent(raw: string): number {
  let indent = 0;
  for (const char of raw) {
    if (char === ' ') {
      indent += 1;
      continue;
    }
    if (char === '\t') {
      indent += 2;
      continue;
    }
    break;
  }
  return indent;
}

function parseMarkdownFrontMatterBlock(source: string): { body: string; content: string; error: string | null } | null {
  const lines = source.split(/\r?\n/);
  if (lines.length < 3) return null;
  if (lines[0].trim() !== '---') return null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line !== '---' && line !== '...') continue;
    return {
      body: lines.slice(1, index).join('\n'),
      content: lines.slice(index + 1).join('\n'),
      error: null,
    };
  }

  return {
    body: '',
    content: source,
    error: 'Could not parse front matter',
  };
}

interface MarkdownFontConfig {
  load: string[];
  body: string | null;
  headings: string | null;
}

function splitCommaSeparatedValues(value: string): string[] {
  return value
    .split(',')
    .map((part) => stripMatchingQuotes(part.trim()))
    .filter(Boolean);
}

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1).trim();
    }
  }
  return value.trim();
}

function parseFontFamilyScalar(value: string): string | null {
  const normalized = stripMatchingQuotes(value.trim());
  if (!normalized) return null;
  if (/[<>\\]/.test(normalized)) return null;
  return normalized;
}

function parseFontFamilyList(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const listSource = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
  if (!listSource) return [];

  const families = splitCommaSeparatedValues(listSource);
  return families.length > 0 && families.every(Boolean) ? families : null;
}

function uniqueFontFamilies(families: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const family of families) {
    const normalized = family.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function parseIndentedList(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { values: string[]; nextIndex: number; error: string | null } {
  const values: string[] = [];
  let childIndent: number | null = null;
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    const current = lines[index];
    if (!current.trim()) continue;

    const indent = countIndent(current);
    if (indent <= parentIndent) break;
    if (childIndent == null) childIndent = indent;
    if (indent !== childIndent) {
      return { values: [], nextIndex: index, error: 'Could not parse front matter' };
    }

    const trimmed = current.trim();
    if (!trimmed.startsWith('-')) {
      return { values: [], nextIndex: index, error: 'Could not parse front matter' };
    }
    const value = parseFontFamilyScalar(trimmed.slice(1).trim());
    if (!value) {
      return { values: [], nextIndex: index, error: 'Could not parse front matter' };
    }
    values.push(value);
  }

  if (values.length === 0) {
    return { values: [], nextIndex: index, error: 'Could not parse front matter' };
  }

  return { values, nextIndex: index, error: null };
}

function parseNestedFontConfig(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { config: MarkdownFontConfig; nextIndex: number; error: string | null } {
  const config: MarkdownFontConfig = {
    load: [],
    body: null,
    headings: null,
  };
  let childIndent: number | null = null;
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    const current = lines[index];
    if (!current.trim()) continue;

    const indent = countIndent(current);
    if (indent <= parentIndent) break;
    if (childIndent == null) childIndent = indent;
    if (indent !== childIndent) {
      return { config, nextIndex: index, error: 'Could not parse front matter' };
    }

    const match = /^([ \t]*)(load|body|headings)\s*:\s*(.*)$/.exec(current);
    if (!match) {
      return { config, nextIndex: index, error: 'Could not parse front matter' };
    }
    if (countIndent(match[1]) !== childIndent) {
      return { config, nextIndex: index, error: 'Could not parse front matter' };
    }

    const key = match[2];
    const value = match[3].trim();
    if (key === 'load') {
      if (config.load.length > 0) {
        return { config, nextIndex: index, error: 'Could not parse front matter' };
      }
      if (value) {
        const families = parseFontFamilyList(value);
        if (!families) {
          return { config, nextIndex: index, error: 'Could not parse front matter' };
        }
        config.load = families;
        continue;
      }

      const list = parseIndentedList(lines, index + 1, childIndent);
      if (list.error) return { config, nextIndex: list.nextIndex, error: list.error };
      config.load = list.values;
      index = list.nextIndex - 1;
      continue;
    }

    const family = parseFontFamilyScalar(value);
    if (!family) {
      return { config, nextIndex: index, error: 'Could not parse front matter' };
    }

    if (key === 'body') {
      if (config.body !== null) {
        return { config, nextIndex: index, error: 'Could not parse front matter' };
      }
      config.body = family;
      continue;
    }

    if (config.headings !== null) {
      return { config, nextIndex: index, error: 'Could not parse front matter' };
    }
    config.headings = family;
  }

  return { config, nextIndex: index, error: null };
}

function parseFontsValue(
  lines: string[],
  startIndex: number,
  value: string,
): { config: MarkdownFontConfig; nextIndex: number; error: string | null } {
  if (value) {
    const families = parseFontFamilyList(value);
    if (!families) {
      return {
        config: { load: [], body: null, headings: null },
        nextIndex: startIndex + 1,
        error: 'Could not parse front matter',
      };
    }
    return {
      config: { load: families, body: null, headings: null },
      nextIndex: startIndex + 1,
      error: null,
    };
  }

  const nextLine = lines[startIndex + 1];
  if (!nextLine || !nextLine.trim()) {
    return {
      config: { load: [], body: null, headings: null },
      nextIndex: startIndex + 1,
      error: 'Could not parse front matter',
    };
  }

  const nextTrimmed = nextLine.trim();
  if (nextTrimmed.startsWith('-')) {
    const list = parseIndentedList(lines, startIndex + 1, 0);
    if (list.error) {
      return {
        config: { load: [], body: null, headings: null },
        nextIndex: list.nextIndex,
        error: list.error,
      };
    }
    return {
      config: { load: list.values, body: null, headings: null },
      nextIndex: list.nextIndex,
      error: null,
    };
  }

  return parseNestedFontConfig(lines, startIndex + 1, 0);
}

function buildGoogleFontsImportUrl(families: string[]): string {
  const query = families.map((family) => `family=${encodeURIComponent(family).replace(/%20/g, '+')}`).join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

function formatFontFamilyCssValue(family: string): string {
  return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", var(--font-sans), sans-serif`;
}

function buildMarkdownFontCss(config: MarkdownFontConfig | null): string | null {
  if (!config) return null;

  const load = uniqueFontFamilies(
    config.load.concat(config.body ? [config.body] : [], config.headings ? [config.headings] : []),
  );
  if (load.length === 0) return null;

  const css: string[] = [`@import url("${buildGoogleFontsImportUrl(load)}");`];
  if (config.body) {
    css.push(
      `p, ul, ol, blockquote, table, li, td, th, div, section, span { font-family: ${formatFontFamilyCssValue(config.body)}; }`,
    );
  }
  if (config.headings) {
    css.push(`h1, h2, h3, h4, h5, h6 { font-family: ${formatFontFamilyCssValue(config.headings)}; }`);
  }

  return css.join('\n');
}

function extractCustomCssFromFrontMatterBody(body: string): { css: string | null; error: string | null } {
  const lines = body.split(/\r?\n/);
  let css: string | null = null;
  let fonts: MarkdownFontConfig | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    const match = /^([ \t]*)(css|fonts)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      return { css: null, error: 'Could not parse front matter' };
    }
    if (match[1].trim()) {
      return { css: null, error: 'Could not parse front matter' };
    }

    const key = match[2];
    const value = match[3].trim();
    if (key === 'css') {
      if (css !== null) {
        return { css: null, error: 'Could not parse front matter' };
      }

      const baseIndent = countIndent(match[1]);
      if (!value) {
        css = '';
        continue;
      }
      if (value !== '|' && value !== '|-' && value !== '|+') {
        css = value;
        continue;
      }

      const cssLines: string[] = [];
      let lookahead = index + 1;
      for (; lookahead < lines.length; lookahead += 1) {
        const current = lines[lookahead];
        if (!current.trim()) {
          cssLines.push('');
          continue;
        }

        const indent = countIndent(current);
        if (indent <= baseIndent) break;

        const sliceIndex = Math.min(current.length, baseIndent + 2);
        cssLines.push(current.slice(sliceIndex));
      }

      css = cssLines.join('\n');
      index = lookahead - 1;
      continue;
    }

    if (fonts !== null) {
      return { css: null, error: 'Could not parse front matter' };
    }

    const parsedFonts = parseFontsValue(lines, index, value);
    if (parsedFonts.error) {
      return { css: null, error: parsedFonts.error };
    }
    fonts = parsedFonts.config;
    index = parsedFonts.nextIndex - 1;
  }

  const generatedFontCss = buildMarkdownFontCss(fonts);
  const combinedCss = [generatedFontCss, css]
    .filter((part): part is string => part != null && part.trim().length > 0)
    .join('\n');
  return { css: combinedCss || null, error: null };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const ALLOWED_MARKDOWN_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'span',
  'strong',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

const ALLOWED_MARKDOWN_PSEUDOS = new Set(['first-child', 'focus', 'focus-visible', 'hover', 'last-child', 'visited']);

const ALLOWED_CSS_PROPERTIES = new Set([
  'background',
  'background-color',
  'border',
  'border-bottom',
  'border-color',
  'border-left',
  'border-radius',
  'border-right',
  'border-style',
  'border-top',
  'border-width',
  'color',
  'column-count',
  'column-gap',
  'display',
  'font-family',
  'font-size',
  'font-style',
  'font-stretch',
  'font-variant',
  'font-weight',
  'height',
  'hyphens',
  'letter-spacing',
  'line-height',
  'list-style',
  'list-style-position',
  'list-style-type',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-width',
  'opacity',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'position',
  'text-align',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-indent',
  'text-transform',
  'vertical-align',
  'white-space',
  'width',
  'word-break',
]);

function isAllowedGoogleFontsImport(statement: string): boolean {
  const match =
    /^@import\s+(?:url\(\s*(['"]?)(https:\/\/fonts\.googleapis\.com\/[^'")\s]+)\1\s*\)|(['"])(https:\/\/fonts\.googleapis\.com\/[^'"\s]+)\3)(?:\s+[a-z0-9\s(),.-]+)?\s*;$/i.exec(
      statement.trim(),
    );
  if (!match) return false;
  const href = match[2] ?? match[4] ?? '';
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname === 'fonts.googleapis.com';
  } catch {
    return false;
  }
}

function readLeadingImportStatement(source: string): { statement: string; rest: string } | null {
  let index = 0;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (!source.slice(index).toLowerCase().startsWith('@import')) return null;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let parenDepth = 0;

  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    const previous = cursor > 0 ? source[cursor - 1] : '';

    if (char === "'" && !inDoubleQuote && previous !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote && previous !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (char === ';' && parenDepth === 0) {
      return {
        statement: source.slice(index, cursor + 1).trim(),
        rest: source.slice(cursor + 1),
      };
    }
  }

  return null;
}

function isSafeCssValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (/[<>\\]/.test(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (
    lower.includes('@import') ||
    lower.includes('expression(') ||
    lower.includes('javascript:') ||
    lower.includes('vbscript:') ||
    lower.includes('behavior:') ||
    lower.includes('-moz-binding') ||
    lower.includes('url(')
  ) {
    return false;
  }
  return /^[a-z0-9\s#(),.%+/'"_-]+$/i.test(normalized);
}

function isAllowedSimpleSelector(selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  if (/[#[*]/.test(trimmed)) return false;
  if (trimmed.includes('::')) return false;
  if (/[<>]/.test(trimmed)) return false;

  const segments = trimmed.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  if (segments.length === 0) return false;

  for (const segment of segments) {
    const tokens = segment.match(/(?:^[a-z][a-z0-9-]*)|\.[a-z][a-z0-9-]*|:[a-z-]+/gi);
    if (!tokens) return false;
    if (tokens.join('') !== segment) return false;

    for (const token of tokens) {
      if (token.startsWith('.')) {
        continue;
      }
      if (token.startsWith(':')) {
        if (!ALLOWED_MARKDOWN_PSEUDOS.has(token.slice(1).toLowerCase())) return false;
        continue;
      }
      if (!ALLOWED_MARKDOWN_TAGS.has(token.toLowerCase())) return false;
    }
  }

  return true;
}

interface ThemeQualifiedSelector {
  theme: 'light' | 'dark' | null;
  selector: string;
}

function parseThemeQualifiedSelector(selector: string): ThemeQualifiedSelector | null {
  const trimmed = selector.trim();
  if (!trimmed) return null;

  const themeMatch = /^:(light|dark)(?:\s+(.+))?$/.exec(trimmed);
  if (!themeMatch) {
    return isAllowedSimpleSelector(trimmed) ? { theme: null, selector: trimmed } : null;
  }

  const themedSelector = themeMatch[2]?.trim() ?? '';
  if (!themedSelector || !isAllowedSimpleSelector(themedSelector)) return null;
  return {
    theme: themeMatch[1] as 'light' | 'dark',
    selector: themedSelector,
  };
}

function sanitizeMarkdownCustomCss(
  rawCss: string,
): { css: string; scope: string | null; hadRejectedRules: boolean } | null {
  const withoutBom = rawCss.replace(/^\uFEFF/, '');
  const noComments = withoutBom.replace(/\/\*[\s\S]*?\*\//g, '');
  const source = noComments.trim();
  if (!source) return null;
  if (source.includes('@media') || source.includes('@supports') || source.includes('@layer')) return null;

  const imports: string[] = [];
  let remaining = source;
  while (true) {
    const match = readLeadingImportStatement(remaining);
    if (!match) break;
    const statement = match.statement;
    if (!isAllowedGoogleFontsImport(statement)) return null;
    imports.push(statement);
    remaining = match.rest;
  }

  if (remaining.includes('@')) return null;

  const rules: Array<{ selectors: ThemeQualifiedSelector[]; declarations: string }> = [];
  let hadRejectedRules = false;
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(remaining))) {
    if (remaining.slice(cursor, match.index).trim()) return null;
    cursor = match.index + match[0].length;

    const selectors = match[1]
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean);
    if (selectors.length === 0) {
      hadRejectedRules = true;
      continue;
    }
    const parsedSelectors = selectors.map(parseThemeQualifiedSelector);
    if (parsedSelectors.some((selector) => selector === null)) {
      hadRejectedRules = true;
      continue;
    }
    const safeSelectors = parsedSelectors.filter((selector): selector is ThemeQualifiedSelector => selector !== null);
    if (safeSelectors.length === 0) {
      hadRejectedRules = true;
      continue;
    }

    const declarations = match[2]
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean);
    if (declarations.length === 0) {
      hadRejectedRules = true;
      continue;
    }

    const sanitizedDeclarations: string[] = [];
    let invalidDeclaration = false;
    for (const declaration of declarations) {
      const separatorIndex = declaration.indexOf(':');
      if (separatorIndex <= 0) {
        invalidDeclaration = true;
        break;
      }
      const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
      const value = declaration.slice(separatorIndex + 1).trim();
      if (!ALLOWED_CSS_PROPERTIES.has(property)) {
        invalidDeclaration = true;
        break;
      }
      if (!isSafeCssValue(value)) {
        invalidDeclaration = true;
        break;
      }
      sanitizedDeclarations.push(`${property}: ${value}`);
    }
    if (invalidDeclaration || sanitizedDeclarations.length === 0) {
      hadRejectedRules = true;
      continue;
    }

    rules.push({
      selectors: safeSelectors,
      declarations: sanitizedDeclarations.join('; '),
    });
  }

  if (remaining.slice(cursor).trim()) return null;
  if (rules.length === 0) {
    return imports.length > 0 ? { css: imports.join('\n'), scope: null, hadRejectedRules } : null;
  }

  const scope = hashString(
    `${imports.join('\n')}\n${rules
      .map(
        (rule) =>
          `${rule.selectors
            .map((selector) => `${selector.theme ? `:${selector.theme} ` : ''}${selector.selector}`)
            .join(', ')} { ${rule.declarations}; }`,
      )
      .join('\n')}`,
  );
  const scopeSelector = `.rendered-markdown[data-markdown-custom-css="${scope}"]`;
  const scopedRules = rules
    .map((rule) => {
      const selectors = rule.selectors
        .map((selector) =>
          selector.theme
            ? `[data-theme="${selector.theme}"] ${scopeSelector} ${selector.selector}`
            : `${scopeSelector} ${selector.selector}`,
        )
        .join(', ');
      return `${selectors} { ${rule.declarations}; }`;
    })
    .filter((rule): rule is string => Boolean(rule));

  return { css: [...imports, ...scopedRules].join('\n'), scope, hadRejectedRules };
}

function extractMarkdownDocument(text: string): {
  markdown: string;
  customCss: string | null;
  customCssScope: string | null;
  frontMatterError: string | null;
  cssWarning: string | null;
} {
  const normalized = text.replace(/^\uFEFF/, '');
  const candidate = normalized.replace(/^(?:[ \t]*\r?\n)+/, '');
  const frontMatter = parseMarkdownFrontMatterBlock(candidate);
  if (!frontMatter) {
    return { markdown: candidate, customCss: null, customCssScope: null, frontMatterError: null, cssWarning: null };
  }
  if (frontMatter.error) {
    console.error('[markdown-frontmatter] Could not parse front matter', {
      error: frontMatter.error,
    });
    return {
      markdown: candidate,
      customCss: null,
      customCssScope: null,
      frontMatterError: frontMatter.error,
      cssWarning: null,
    };
  }

  const parsedFrontMatter = extractCustomCssFromFrontMatterBody(frontMatter.body);
  if (parsedFrontMatter.error) {
    console.error('[markdown-frontmatter] Could not parse front matter', {
      error: parsedFrontMatter.error,
    });
    return {
      markdown: candidate,
      customCss: null,
      customCssScope: null,
      frontMatterError: parsedFrontMatter.error,
      cssWarning: null,
    };
  }

  const sanitizedCss = parsedFrontMatter.css ? sanitizeMarkdownCustomCss(parsedFrontMatter.css) : null;
  return {
    markdown: frontMatter.content,
    customCss: sanitizedCss?.css ?? null,
    customCssScope: sanitizedCss?.scope ?? null,
    frontMatterError: null,
    cssWarning: sanitizedCss?.hadRejectedRules ? 'Some custom CSS rules were ignored' : null,
  };
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

function isLeadingIndentPreservedBlock(node: Element): boolean {
  const tagName = node.tagName;
  return tagName === 'P' || tagName === 'LI' || tagName === 'BLOCKQUOTE';
}

function isWhitespacePreservingElement(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.tagName === 'PRE' || node.tagName === 'CODE' || node.tagName === 'KBD' || node.tagName === 'SAMP')
  );
}

function leadingIndentInfo(text: string): { raw: string; columns: number } | null {
  const match = /^[ \t]+/.exec(text);
  if (!match) return null;

  let columns = 0;
  for (const char of match[0]) {
    columns += char === '\t' ? 2 : 1;
  }

  return { raw: match[0], columns };
}

function createLeadingIndentSpan(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'leading-indent';
  span.textContent = text;
  return span;
}

function applyBlockLeadingIndent(element: Element): void {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);

  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) {
      const text = current.textContent ?? '';
      if (!text) {
        current = walker.nextNode();
        continue;
      }

      const indent = leadingIndentInfo(text);
      if (!indent) return;

      current.textContent = text.slice(indent.raw.length);
      element.classList.add('leading-indent-block');
      if (element instanceof HTMLElement) {
        element.style.setProperty('--leading-indent-columns', String(indent.columns));
      }
      return;
    }

    if (current instanceof HTMLElement) {
      if (current.tagName === 'BR' || isWhitespacePreservingElement(current)) return;
    }

    current = walker.nextNode();
  }
}

function preserveLeadingIndentationInNode(node: Node, atLineStart: { value: boolean }): void {
  if (node instanceof Text) {
    const text = node.textContent ?? '';
    if (!text) return;

    const fragment = document.createDocumentFragment();
    let index = 0;

    while (index < text.length) {
      if (atLineStart.value) {
        const indentMatch = /^[ \t]+/.exec(text.slice(index));
        if (indentMatch) {
          fragment.appendChild(createLeadingIndentSpan(indentMatch[0]));
          index += indentMatch[0].length;
          atLineStart.value = false;
          continue;
        }
        if (text[index] !== '\n' && text[index] !== '\r') {
          atLineStart.value = false;
        }
      }

      const newlineIndex = text.slice(index).search(/[\r\n]/);
      if (newlineIndex === -1) {
        fragment.appendChild(document.createTextNode(text.slice(index)));
        atLineStart.value = false;
        break;
      }

      const end = index + newlineIndex;
      if (end > index) {
        fragment.appendChild(document.createTextNode(text.slice(index, end)));
      }

      if (text[end] === '\r' && text[end + 1] === '\n') {
        fragment.appendChild(document.createTextNode('\r\n'));
        index = end + 2;
      } else {
        fragment.appendChild(document.createTextNode(text[end]));
        index = end + 1;
      }
      atLineStart.value = true;
    }

    node.replaceWith(fragment);
    return;
  }

  if (!(node instanceof HTMLElement) || isWhitespacePreservingElement(node)) {
    atLineStart.value = false;
    return;
  }

  if (node.tagName === 'BR') {
    atLineStart.value = true;
    return;
  }

  const children = Array.from(node.childNodes);
  for (const child of children) {
    preserveLeadingIndentationInNode(child, atLineStart);
  }
}

function preserveLeadingIndentation(root: ParentNode): void {
  root.querySelectorAll('p, li, blockquote').forEach((element) => {
    if (!isLeadingIndentPreservedBlock(element)) return;
    if (element.parentElement?.closest('p, li, blockquote')) return;
    applyBlockLeadingIndent(element);
    preserveLeadingIndentationInNode(element, { value: false });
  });
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
    const sanitized = sanitizeHtml(rendered, {
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

function sanitizeHtml(dirty: string, config?: object): string {
  if (typeof domPurify.sanitize === 'function') {
    return domPurify.sanitize(dirty, config);
  }
  if (typeof window !== 'undefined') {
    return domPurify(window).sanitize(dirty, config);
  }
  return dirty;
}

export function parseMarkdownDocument(text: string, options?: ParseMarkdownOptions): ParsedMarkdownDocument {
  const extracted = extractMarkdownDocument(text);
  const extractedFootnotes = extractFootnotes(extracted.markdown);
  const raw = marked.parse(extractedFootnotes.markdown, { gfm: true, breaks: options?.breaks ?? true }) as string;
  const sanitized = sanitizeHtml(raw, { ADD_ATTR: ['target', 'rel', 'data-wikilink', 'data-wiki-target-path'] });
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

  preserveLeadingIndentation(template.content);
  applySmartPunctuation(template.content);

  return {
    html: template.innerHTML,
    customCss: extracted.customCss,
    customCssScope: extracted.customCssScope,
    frontMatterError: extracted.frontMatterError,
    cssWarning: extracted.cssWarning,
  };
}

export function parseMarkdownToHtml(text: string, options?: ParseMarkdownOptions): string {
  return parseMarkdownDocument(text, options).html;
}
