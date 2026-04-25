import DOMPurify from 'dompurify';
import { nameToEmoji } from 'gemoji';
import type { Token, Tokens } from 'marked';
import { marked, Renderer, type RendererThis, Tokenizer, type TokenizerThis } from 'marked';
import { BRACE_PROMPT_HINT_LABEL } from './brace_prompt.ts';
import { parseCriticMarkupAt } from './criticmarkup.ts';
import { parseMarkdownFrontMatterBlock } from './document_permissions.ts';
import { parseHighlightMarkupAt } from './highlight_markup.ts';
import { parseImageDimensionTitle } from './image_markdown.ts';
import { parseInlineCommentAt } from './inline_comment.ts';
import { hashPromptListIdentifierText, normalizePromptListIdentifierText } from './prompt_list_state.ts';
import { EMPTY_PROMPT_QUESTION_PLACEHOLDER, matchPromptListLine, parsePromptListBlock } from './prompt_list_syntax.ts';
import { encodePathForHref, isExternalHttpHref } from './util.ts';

marked.setOptions({
  gfm: true,
});

const domPurify = DOMPurify as unknown as {
  sanitize?: (dirty: string, config?: object) => string;
  (window: Window): { sanitize: (dirty: string, config?: object) => string };
};

const WEB_TLDS = new Set(['com', 'org', 'net', 'app', 'dev', 'xyz']);
let promptListConversationDuplicateCounts = new Map<string, number>();

interface PromptListToken extends Tokens.Generic {
  type: 'promptList';
  items: Array<{
    kind: 'question' | 'answer' | 'comment';
    className: 'prompt-question' | 'prompt-answer' | 'prompt-comment';
    sourceText: string;
    indentWidth: number;
    renderAsBlock: boolean;
    tokens: Token[];
  }>;
}

interface PromptListRenderNode {
  className: 'prompt-question' | 'prompt-answer' | 'prompt-comment';
  contentHtml: string;
  depth: number;
  itemIndex: number;
  blockCount: number;
  sourceText: string;
  children: PromptListRenderNode[];
}

interface CriticMarkupToken extends Tokens.Generic {
  type: 'criticMarkup';
  criticKind: 'addition' | 'deletion' | 'highlight' | 'comment' | 'substitution';
  tokens?: Token[];
  oldTokens?: Token[];
  newTokens?: Token[];
  text?: string;
}

interface HighlightMarkupToken extends Tokens.Generic {
  type: 'highlightMarkup';
  tokens?: Token[];
}

interface InlineCommentToken extends Tokens.Generic {
  type: 'inlineComment';
  text: string;
}

interface SuperscriptLinkToken extends Tokens.Generic {
  type: 'superscriptLink';
  href: string;
  text: string;
  tokens?: Token[];
  autoNumbered?: boolean;
  citationKey?: string;
}

export interface MarkdownSyncBlock {
  id: string;
  from: number;
  to: number;
  type: string;
}

interface MarkdownSyncToken extends Tokens.Generic {
  syncId?: string;
}

interface PromptListAwareLexerState {
  promptListContainerDepth?: number;
}

function promptListToolCallName(sourceText: string): string | null {
  const lines = sourceText.replace(/\r\n?/g, '\n').split('\n');
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0)?.trim() ?? '';
  const match = /^([A-Z][A-Za-z0-9_-]{1,})(?:\s*)\(/.exec(firstNonEmptyLine);
  if (!match) return null;

  const hasToolTrace = lines.some((line, index) => index > 0 && line.trimStart().startsWith('⎿'));
  const looksWrappedCall = lines.length > 1 && !hasToolTrace;
  if (!hasToolTrace && !looksWrappedCall) return null;

  return match[1];
}

function promptListContainerDepth(thisRef: TokenizerThis): number {
  return (thisRef.lexer.state as typeof thisRef.lexer.state & PromptListAwareLexerState).promptListContainerDepth ?? 0;
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

function isToggleListItemToken(item: Tokens.ListItem): boolean {
  return /^\s*\+\s+/.test(item.raw);
}

function renderMarkdownListItem(renderer: RendererThis<string, string>, item: Tokens.ListItem, syncAttr = ''): string {
  if (!isToggleListItemToken(item)) {
    const body = renderer.parser.parse(item.tokens);
    return `<li${syncAttr}>${body}</li>\n`;
  }

  const [summaryToken, ...bodyTokens] = item.tokens;
  const summaryHtml =
    summaryToken && 'tokens' in summaryToken
      ? renderer.parser.parseInline(summaryToken.tokens ?? [])
      : escapeHtmlAttr(item.text.split('\n', 1)[0] ?? '');
  const bodyHtml = bodyTokens.length > 0 ? renderer.parser.parse(bodyTokens) : '';
  return `<li class="toggle-list-item"${syncAttr}><details class="toggle-list" data-open="false"><summary class="toggle-list-summary" aria-expanded="false">${summaryHtml}</summary>${bodyHtml ? `<div class="toggle-list-body">${bodyHtml}</div>` : ''}</details></li>\n`;
}

function markdownSyncAttr(token: { syncId?: string } | null | undefined): string {
  return token?.syncId ? ` data-sync-id="${escapeHtmlAttr(token.syncId)}"` : '';
}

function parseEmojiShortcode(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!/^[a-z0-9_+-]+$/.test(normalized)) return null;
  return nameToEmoji[normalized] ?? null;
}

function startsWithCriticMarkupLikeMarker(text: string): boolean {
  return /^[\t ]*[+\-=~>]/.test(text);
}

function matchTemplateTagLine(src: string): string | null {
  const firstLine = src.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
  if (!/^[{]%[\t ].*%[}]$/u.test(firstLine)) return null;
  return firstLine;
}

function parseBracePromptAt(
  source: string,
  from: number,
): {
  raw: string;
  text: string;
  to: number;
} | null {
  if (source[from] !== '{') return null;

  const closeIndex = source.indexOf('}', from + 1);
  if (closeIndex < 0) return null;
  if (source[from + 1] === '{' || source[closeIndex + 1] === '}') return null;
  if (parseCriticMarkupAt(source, from)?.to === closeIndex + 1) return null;
  if (source.indexOf('{', from + 1) >= 0 && source.indexOf('{', from + 1) < closeIndex) return null;
  if (source.indexOf('}', from + 1) !== closeIndex) return null;

  const text = source.slice(from + 1, closeIndex);
  if (text.includes('{') || text.includes('}')) return null;
  if (startsWithCriticMarkupLikeMarker(text)) return null;
  if (text.trim().length === 0) return null;

  return {
    raw: source.slice(from, closeIndex + 1),
    text,
    to: closeIndex + 1,
  };
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

function normalizeInlineCitationKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function inlineCitationIdentity(key: string | null, href: string): string {
  if (key) return `key:${normalizeInlineCitationKey(key)}`;
  return `href:${href.trim()}`;
}

marked.use({
  renderer: {
    listitem(token) {
      return renderMarkdownListItem(this, token);
    },
  },
  tokenizer: {
    list(this: TokenizerThis, src: string) {
      const state = this.lexer.state as PromptListAwareLexerState;
      state.promptListContainerDepth = (state.promptListContainerDepth ?? 0) + 1;
      try {
        return Tokenizer.prototype.list.call(this, src);
      } finally {
        state.promptListContainerDepth -= 1;
      }
    },
    blockquote(this: TokenizerThis, src: string) {
      const state = this.lexer.state as PromptListAwareLexerState;
      state.promptListContainerDepth = (state.promptListContainerDepth ?? 0) + 1;
      try {
        return Tokenizer.prototype.blockquote.call(this, src);
      } finally {
        state.promptListContainerDepth -= 1;
      }
    },
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
      name: 'templateTagLine',
      level: 'block',
      start(src: string) {
        const match = /(?:^|\n)[ \t]*[{]%[\t ].*%[}](?=\r?\n|$)/u.exec(src);
        return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined;
      },
      tokenizer(src: string) {
        const raw = matchTemplateTagLine(src);
        if (!raw) return undefined;

        return {
          type: 'templateTagLine',
          raw,
          text: raw,
        };
      },
      renderer(token) {
        return `<p${markdownSyncAttr(token as MarkdownSyncToken)}>${escapeHtmlAttr((token as Tokens.Generic & { text?: string }).text ?? '')}</p>\n`;
      },
    },
    {
      name: 'promptList',
      level: 'block',
      start(this: TokenizerThis, src: string) {
        if (promptListContainerDepth(this) > 0) return undefined;
        const match = /(?:^|\n)(?:[ \t]*)(?:~|❯|⏺|✻|%)[ \t]+/u.exec(src);
        return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined;
      },
      tokenizer(this: TokenizerThis, src: string) {
        if (promptListContainerDepth(this) > 0) return undefined;
        const sourceLines = src.split('\n');
        const normalizedLines = sourceLines.map((line) => line.replace(/\r$/, ''));
        const block = parsePromptListBlock(normalizedLines, 0);
        if (!block) return undefined;

        const items: PromptListToken['items'] = [];
        for (const item of block.items) {
          const toolCallName = item.match.kind === 'answer' ? promptListToolCallName(item.content) : null;
          const content = toolCallName ?? item.content;
          const renderAsBlock = content.includes('\n') || /^\s*$/.test(content);
          const tokens = renderAsBlock ? this.lexer.blockTokens(content) : this.lexer.inlineTokens(content);

          items.push({
            kind: item.match.kind,
            className: toolCallName
              ? 'prompt-comment'
              : item.match.kind === 'question'
                ? 'prompt-question'
                : item.match.kind === 'answer'
                  ? 'prompt-answer'
                  : 'prompt-comment',
            sourceText: content,
            indentWidth: countIndent(item.match.indent),
            renderAsBlock,
            tokens,
          });
        }

        return {
          type: 'promptList',
          raw: sourceLines.slice(0, block.endLineIndexExclusive).join('\n'),
          items,
        };
      },
      renderer(this: RendererThis<string, string>, token: Tokens.Generic) {
        const promptListToken = token as PromptListToken;

        const promptListTree = buildPromptListTree(
          promptListToken.items.map((item, itemIndex) => {
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
            return {
              className: item.className,
              contentHtml,
              depth: item.indentWidth,
              itemIndex,
              blockCount: item.renderAsBlock
                ? countPromptListSummaryBlocks(item.tokens)
                : item.sourceText.trim()
                  ? 1
                  : 0,
              sourceText: item.sourceText,
            };
          }),
        );
        const itemCount = promptListToken.items.length;
        const firstQuestion =
          promptListToken.items.find((item) => item.kind === 'question')?.sourceText ??
          promptListToken.items[0]?.sourceText ??
          '';
        const promptHash = hashPromptListIdentifierText(normalizePromptListIdentifierText(firstQuestion));
        const duplicateIndex = promptListConversationDuplicateCounts.get(promptHash) ?? 0;
        promptListConversationDuplicateCounts.set(promptHash, duplicateIndex + 1);
        const promptListId = `${promptHash}-${duplicateIndex}`;
        const itemsHtml = renderPromptListTree(promptListTree, promptListId);
        if (itemCount <= 1) {
          return `<ul class="${promptListTreeClassName(promptListTree, true)}" data-prompt-list-id="${promptListId}">${itemsHtml}</ul>`;
        }
        return `<div class="prompt-list-conversation" data-prompt-list-id="${promptListId}" data-prompt-list-mode="collapse-responses" data-collapsed="true"${markdownSyncAttr(promptListToken as PromptListToken & { syncId?: string })}><div class="prompt-list-header"><div class="prompt-list-mode-toggle" role="group" aria-label="Prompt list mode"><button type="button" class="prompt-list-mode-option" data-prompt-list-mode="collapse-all" aria-pressed="false">Collapse All</button><button type="button" class="prompt-list-mode-option" data-prompt-list-mode="collapse-responses" aria-pressed="true">Collapse Responses</button><button type="button" class="prompt-list-mode-option" data-prompt-list-mode="expand-all" aria-pressed="false">Expand All</button></div></div><div class="prompt-list-body"><ul class="${promptListTreeClassName(promptListTree, true)}">${itemsHtml}</ul></div></div>`;
      },
    },
    {
      name: 'criticMarkup',
      level: 'inline',
      start(src: string) {
        return src.indexOf('{');
      },
      tokenizer(src: string) {
        const match = parseCriticMarkupAt(src, 0);
        if (!match) return undefined;

        if (match.kind === 'substitution') {
          return {
            type: 'criticMarkup',
            raw: match.raw,
            criticKind: match.kind,
            oldTokens: this.lexer.inlineTokens(match.oldText ?? ''),
            newTokens: this.lexer.inlineTokens(match.newText ?? ''),
          } satisfies CriticMarkupToken;
        }

        if (match.kind === 'comment') {
          return {
            type: 'criticMarkup',
            raw: match.raw,
            criticKind: match.kind,
            text: match.text,
          } satisfies CriticMarkupToken;
        }

        return {
          type: 'criticMarkup',
          raw: match.raw,
          criticKind: match.kind,
          tokens: this.lexer.inlineTokens(match.text),
        } satisfies CriticMarkupToken;
      },
      renderer(token) {
        const criticToken = token as CriticMarkupToken;
        if (criticToken.criticKind === 'addition') {
          return `<ins class="critic-addition">${this.parser.parseInline(criticToken.tokens ?? [])}</ins>`;
        }
        if (criticToken.criticKind === 'deletion') {
          return `<del class="critic-deletion">${this.parser.parseInline(criticToken.tokens ?? [])}</del>`;
        }
        if (criticToken.criticKind === 'highlight') {
          return `<mark class="critic-highlight">${this.parser.parseInline(criticToken.tokens ?? [])}</mark>`;
        }
        if (criticToken.criticKind === 'comment') {
          return `<span class="critic-comment">${escapeHtmlAttr(criticToken.text ?? '')}</span>`;
        }
        return `<span class="critic-substitution"><del class="critic-deletion">${this.parser.parseInline(criticToken.oldTokens ?? [])}</del><ins class="critic-addition">${this.parser.parseInline(criticToken.newTokens ?? [])}</ins></span>`;
      },
    },
    {
      name: 'highlightMarkup',
      level: 'inline',
      start(src: string) {
        return src.indexOf('::');
      },
      tokenizer(src: string) {
        const match = parseHighlightMarkupAt(src, 0);
        if (!match) return undefined;
        return {
          type: 'highlightMarkup',
          raw: match.raw,
          tokens: this.lexer.inlineTokens(match.text),
        } satisfies HighlightMarkupToken;
      },
      renderer(token) {
        return `<mark class="double-colon-highlight">${this.parser.parseInline((token as HighlightMarkupToken).tokens ?? [])}</mark>`;
      },
    },
    {
      name: 'inlineComment',
      level: 'inline',
      start(src: string) {
        return src.indexOf('++');
      },
      tokenizer(src: string) {
        const match = parseInlineCommentAt(src, 0);
        if (!match) return undefined;
        return {
          type: 'inlineComment',
          raw: match.raw,
          text: match.text,
        } satisfies InlineCommentToken;
      },
      renderer(token) {
        return `<span class="inline-comment">${escapeHtmlAttr((token as InlineCommentToken).text)}</span>`;
      },
    },
    {
      name: 'bracePrompt',
      level: 'inline',
      start(src: string) {
        return src.indexOf('{');
      },
      tokenizer(src: string) {
        const match = parseBracePromptAt(src, 0);
        if (!match) return undefined;
        return {
          type: 'bracePrompt',
          raw: match.raw,
          text: match.text,
          tokens: this.lexer.inlineTokens(match.text),
        };
      },
      renderer(token) {
        return `<span class="brace-prompt">{${this.parser.parseInline(token.tokens ?? [])}}</span>`;
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
      name: 'superscriptLink',
      level: 'inline',
      start(src: string) {
        return src.indexOf('[^');
      },
      tokenizer(src: string) {
        const match = /^\[\^([^\]\n]*)\]\(([^)\s]+)\)/.exec(src);
        if (!match) return undefined;
        const text = match[1].trim();
        const href = match[2].trim();
        if (!href) return undefined;
        const autoNumbered = text.length === 0 || text.startsWith('#');
        const citationKey = text.startsWith('#') ? text.slice(1).trim() : '';
        if (autoNumbered && text.startsWith('#') && !citationKey) return undefined;
        if (!autoNumbered && !text) return undefined;
        return {
          type: 'superscriptLink',
          raw: match[0],
          href,
          text,
          autoNumbered,
          citationKey: citationKey || undefined,
          tokens: this.lexer.inlineTokens(text),
        } satisfies SuperscriptLinkToken;
      },
      renderer(token: SuperscriptLinkToken) {
        if (token.autoNumbered) {
          const keyAttr = token.citationKey ? ` data-cite-key="${escapeHtmlAttr(token.citationKey)}"` : '';
          return `<sup class="superscript-link" data-inline-cite="true"${keyAttr}><a href="${escapeHtmlAttr(token.href)}">?</a></sup>`;
        }
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

function comparableExternalUrl(raw: string): string | null {
  const sanitized = sanitizeMarkdownHref(raw);
  if (!sanitized || !isExternalHttpHref(sanitized)) return null;

  try {
    const url = new URL(sanitized);
    const pathname = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function isRenderedUrlLabel(anchor: HTMLAnchorElement, href: string): boolean {
  const label = (anchor.textContent ?? '').replace(/\u200b/g, '').trim();
  if (!label) return false;

  const comparableLabel = comparableExternalUrl(label);
  const comparableHref = comparableExternalUrl(href);
  return comparableLabel != null && comparableHref != null && comparableLabel === comparableHref;
}

interface ParseMarkdownOptions {
  breaks?: boolean;
  smartQuotes?: boolean;
  resolveImageSrc?: (src: string) => string | null;
  resolveWikiLinkMeta?: (targetPath: string) => { exists: boolean; resolvedHref?: string | null } | null;
}

export interface ParsedMarkdownDocument {
  html: string;
  customCss: string | null;
  customCssScope: string | null;
  frontMatterError: string | null;
  cssWarning: string | null;
  syncBlocks: MarkdownSyncBlock[];
}

interface ExtractedFootnotes {
  markdown: string;
  definitions: Map<string, string>;
  outputToOriginal: number[];
}

interface FootnoteReferences {
  order: string[];
  referenceIds: Map<string, string[]>;
}

function extractFootnotes(markdown: string): ExtractedFootnotes {
  const rawLines = markdown.split(/\r?\n/);
  let lineCursor = 0;
  const lines = rawLines.map((text, index) => {
    const lineStart = lineCursor;
    const lineEnd = lineStart + text.length;
    const newlineLength =
      index < rawLines.length - 1 ? (markdown.startsWith('\r\n', lineEnd) ? 2 : markdown[lineEnd] ? 1 : 0) : 0;
    lineCursor = lineEnd + newlineLength;
    return {
      text,
      lineStart,
      lineEnd,
      nextLineStart: lineCursor,
    };
  });
  const definitions = new Map<string, string>();
  const body: typeof lines = [];
  const outputToOriginal: number[] = [0];

  let inFence = false;
  let fenceMarker = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(```+|~~~+)/.exec(line.text);
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

    const definitionMatch = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(line.text);
    if (!definitionMatch) {
      body.push(line);
      continue;
    }

    const id = definitionMatch[1];
    const contentLines = [definitionMatch[2]];

    let lookahead = index + 1;
    while (lookahead < lines.length) {
      const continuation = lines[lookahead];
      if (/^\s*$/.test(continuation.text)) {
        contentLines.push('');
        lookahead += 1;
        continue;
      }
      if (/^(?: {2,}|\t)/.test(continuation.text)) {
        contentLines.push(continuation.text.replace(/^(?: {1,4}|\t)/, ''));
        lookahead += 1;
        continue;
      }
      break;
    }

    definitions.set(id, contentLines.join('\n').trim());
    index = lookahead - 1;
  }

  const parts: string[] = [];
  let outputLength = 0;

  const appendText = (text: string, from: number, to: number) => {
    if (!text) return;
    if (outputLength === 0) outputToOriginal[0] = from;
    for (let index = 0; index < text.length; index += 1) {
      outputToOriginal[outputLength + index] = from + index;
    }
    outputLength += text.length;
    outputToOriginal[outputLength] = to;
    parts.push(text);
  };

  const appendNewline = (from: number, to: number) => {
    if (outputLength === 0) outputToOriginal[0] = from;
    parts.push('\n');
    outputLength += 1;
    outputToOriginal[outputLength] = to;
  };

  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    appendText(line.text, line.lineStart, line.lineEnd);
    if (index < body.length - 1) appendNewline(line.lineEnd, body[index + 1].lineStart);
  }

  return { markdown: parts.join(''), definitions, outputToOriginal };
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

// Same-depth items become parent → child (a chain of single-child nodes), not siblings; renderPromptListNode
// flattens single-child chains back into a flat list at render time. Siblings only exist at real branch forks,
// which lets render-time branch detection use `children.length > 1`.
function buildPromptListTree(
  items: Array<{
    className: 'prompt-question' | 'prompt-answer' | 'prompt-comment';
    contentHtml: string;
    depth: number;
    itemIndex: number;
    blockCount: number;
    sourceText: string;
  }>,
): PromptListRenderNode[] {
  const root: PromptListRenderNode[] = [];
  const depthSlots: Array<PromptListRenderNode | undefined> = [];
  let previous: PromptListRenderNode | undefined;

  for (const item of items) {
    const node: PromptListRenderNode = {
      className: item.className,
      contentHtml: item.contentHtml,
      depth: item.depth,
      itemIndex: item.itemIndex,
      blockCount: item.blockCount,
      sourceText: item.sourceText,
      children: [],
    };

    let parent: PromptListRenderNode | undefined;
    if (!previous) {
      parent = undefined;
    } else if (item.depth >= previous.depth) {
      parent = previous;
    } else {
      for (let depth = item.depth; depth >= 0; depth -= 1) {
        parent = depthSlots[depth];
        if (parent) break;
      }
    }

    if (parent) parent.children.push(node);
    else root.push(node);

    depthSlots[item.depth] = node;
    depthSlots.length = item.depth + 1;
    previous = node;
  }

  return root;
}

function hasPromptListBranch(nodes: PromptListRenderNode[]): boolean {
  return nodes.length > 1;
}

function promptListTreeClassName(nodes: PromptListRenderNode[], root = false): string {
  return `${root ? 'prompt-list ' : ''}prompt-list-tree${hasPromptListBranch(nodes) ? ' prompt-list-tree--branched' : ''}`;
}

function promptMessageLabel(role: 'user' | 'assistant'): string {
  return `<span class="prompt-message-label prompt-message-label--${role}">${role}: </span>`;
}

function countPromptListSummaryBlocks(tokens: Token[]): number {
  return tokens.filter((token) => token.type !== 'space' && (token.raw?.trim() || token.type === 'hr')).length;
}

function promptAnswerCollapsedSummary(
  sourceText: string,
  blockCount: number,
  fallbackFirstLine = 'Continue here',
): { firstLine: string; continuation: string } {
  const normalized = sourceText.replace(/\r\n?/g, '\n');
  const firstLine = normalized
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  const moreParagraphs = Math.max(0, blockCount - 1);
  const continuation = moreParagraphs > 0 ? `[${moreParagraphs} more paragraph${moreParagraphs === 1 ? '' : 's'}]` : '';
  return {
    firstLine: firstLine || fallbackFirstLine,
    continuation,
  };
}

function promptQuestionCollapsedSummary(
  sourceText: string,
  blockCount: number,
): { previewText: string; continuation: string } {
  const previewLines = sourceText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  const moreParagraphs = Math.max(0, blockCount - previewLines.length);
  const continuation = moreParagraphs > 0 ? `[${moreParagraphs} more paragraph${moreParagraphs === 1 ? '' : 's'}]` : '';
  return {
    previewText: previewLines.join(' '),
    continuation,
  };
}

function promptAnswerSummaryContinuation(summary: { continuation: string }): string {
  return summary.continuation
    ? ` <span class="prompt-answer-summary-continuation">${escapeHtmlAttr(summary.continuation)}</span>`
    : '';
}

function promptListContinueNode(node: PromptListRenderNode, promptListId: string): string {
  if (node.className === 'prompt-answer' || (node.className === 'prompt-question' && !node.contentHtml.trim())) {
    return `<li class="prompt-continue" hidden><button type="button" class="prompt-list-action-button prompt-list-continue-button" data-prompt-list-id="${promptListId}" data-prompt-list-continue-target-item-index="${node.itemIndex}" disabled>Open editor to continue</button></li>`;
  }
  return '';
}

function renderPromptListItem(node: PromptListRenderNode, promptListId: string, branchStart = false): string {
  const className = branchStart ? `${node.className} prompt-list-branch-start` : node.className;
  const hasContent = !!node.contentHtml.trim();
  if (node.className === 'prompt-answer') {
    const contentHtml = hasContent ? node.contentHtml : '<span class="prompt-list-placeholder">Continue here</span>';
    const summary = promptAnswerCollapsedSummary(node.sourceText, node.blockCount);
    return `<li class="${className}" data-prompt-list-id="${promptListId}" data-prompt-list-item-index="${node.itemIndex}" data-expanded="false" aria-expanded="false" tabindex="0"><div class="prompt-answer-summary"><span class="prompt-answer-summary-text">${promptMessageLabel('assistant')}<span class="prompt-answer-summary-line">${escapeHtmlAttr(summary.firstLine)}</span></span>${promptAnswerSummaryContinuation(summary)}</div><div class="prompt-message-content prompt-answer-body">${promptMessageLabel('assistant')}${contentHtml}</div></li><li class="prompt-ask" hidden><button type="button" class="prompt-list-action-button prompt-list-ask-button" data-prompt-list-id="${promptListId}" data-prompt-list-ask-target-item-index="${node.itemIndex}" disabled>Open editor to branch</button></li>`;
  }
  if (node.className === 'prompt-question') {
    const summary = promptQuestionCollapsedSummary(node.sourceText, node.blockCount);
    const summaryPreview = summary.previewText
      ? `<span class="prompt-answer-summary-line">${escapeHtmlAttr(summary.previewText)}</span>`
      : '';
    return `<li class="${className}" data-prompt-list-id="${promptListId}" data-prompt-list-item-index="${node.itemIndex}" data-expanded="true" aria-expanded="true" tabindex="0"><div class="prompt-answer-summary prompt-answer-summary--user"><span class="prompt-answer-summary-text">${promptMessageLabel('user')}${summaryPreview}</span>${promptAnswerSummaryContinuation(summary)}</div><div class="prompt-message-content prompt-answer-body">${promptMessageLabel('user')}${hasContent ? node.contentHtml : ''}</div></li>`;
  }
  const contentHtml = hasContent ? node.contentHtml : '<span class="prompt-list-placeholder">Continue here</span>';
  return `<li class="${className}">${contentHtml}</li>`;
}

function renderPromptListNode(node: PromptListRenderNode, promptListId: string, branchStart = false): string {
  const itemHtml = renderPromptListItem(node, promptListId, branchStart);
  if (node.children.length === 0) return `${itemHtml}${promptListContinueNode(node, promptListId)}`;
  if (node.children.length === 1) return `${itemHtml}${renderPromptListNode(node.children[0]!, promptListId)}`;

  const branchesHtml = node.children
    .map(
      (child) =>
        `<li class="prompt-list-branch"><ul class="${promptListTreeClassName([child])}">${renderPromptListNode(child, promptListId, true)}</ul></li>`,
    )
    .join('');
  return `${itemHtml}<li class="prompt-list-branch-set"><ul class="${promptListTreeClassName(node.children)}">${branchesHtml}</ul></li>`;
}

function renderPromptListTree(nodes: PromptListRenderNode[], promptListId: string): string {
  return nodes.map((node) => renderPromptListNode(node, promptListId)).join('');
}

// --- io code block highlighting ---

const IO_HIGHLIGHT_RULES: Array<{ pattern: RegExp; className: string }> = [
  // CriticMarkup (must precede brace prompt)
  { pattern: /\{~~[\s\S]*?~>[\s\S]*?~~\}/g, className: 'io-hl-critic-substitution' },
  { pattern: /\{\+\+[\s\S]*?\+\+\}/g, className: 'io-hl-critic-addition' },
  { pattern: /\{--[\s\S]*?--\}/g, className: 'io-hl-critic-deletion' },
  { pattern: /\{==[\s\S]*?==\}/g, className: 'io-hl-critic-highlight' },
  { pattern: /\{>>[\s\S]*?<<\}/g, className: 'io-hl-critic-comment' },
  { pattern: /\+\+[^\r\n]*?\+\+/g, className: 'io-hl-inline-comment' },
  // Template tags
  { pattern: /\{%[\t ].*?%\}/g, className: 'io-hl-template-tag' },
  // Brace prompts (single-line, no nested braces, not CriticMarkup)
  { pattern: /\{[^{}]+\}/g, className: 'io-hl-brace-prompt' },
  // Wikilinks
  { pattern: /\[\[[^\]]+\]\]/g, className: 'io-hl-wikilink' },
  // Superscript links
  { pattern: /\[\^[^\]]*\]\([^)]*\)/g, className: 'io-hl-sup-link' },
];

interface IoHighlightSpan {
  from: number;
  to: number;
  className: string;
}

interface IoHighlightInsertion {
  at: number;
  className: string;
  text: string;
}

function collectIoHighlightSpans(text: string): IoHighlightSpan[] {
  const spans: IoHighlightSpan[] = [];
  const claimed = new Uint8Array(text.length);

  for (const rule of IO_HIGHLIGHT_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const from = m.index;
      const to = from + m[0].length;
      let overlap = false;
      for (let i = from; i < to; i++) {
        if (claimed[i]) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      for (let i = from; i < to; i++) claimed[i] = 1;
      spans.push({ from, to, className: rule.className });
    }
  }

  spans.sort((a, b) => a.from - b.from);
  return spans;
}

function collectIoPromptDecorations(text: string): { spans: IoHighlightSpan[]; insertions: IoHighlightInsertion[] } {
  const spans: IoHighlightSpan[] = [];
  const insertions: IoHighlightInsertion[] = [];
  let lineStart = 0;

  for (const line of text.split('\n')) {
    const match = matchPromptListLine(line);
    if (match) {
      spans.push({
        from: lineStart + match.indent.length,
        to: lineStart + match.markerEnd,
        className:
          match.marker === '~'
            ? 'io-hl-prompt-question-marker io-hl-prompt-prefix'
            : 'io-hl-prompt-marker io-hl-prompt-prefix',
      });

      if (match.marker === '~' && !match.content.trim()) {
        insertions.push({
          at: lineStart + match.markerEnd,
          className: 'io-hl-prompt-question-placeholder',
          text: EMPTY_PROMPT_QUESTION_PLACEHOLDER,
        });
      }
    }

    lineStart += line.length + 1;
  }

  return { spans, insertions };
}

function ioPromptContinuationIndent(marker: string): string {
  return marker === '❯' ? ' ' : '  ';
}

function normalizeIoDisplayText(text: string): string {
  const lines = text.split('\n');
  const normalizedLines: string[] = [];
  let continuationIndent: string | null = null;
  let tabContinuationIndent: string | null = null;

  for (const line of lines) {
    const match = matchPromptListLine(line);
    if (match) {
      continuationIndent = `${match.indent}${ioPromptContinuationIndent(match.marker)}`;
      tabContinuationIndent = `${match.indent}\t`;
      normalizedLines.push(line);
      continue;
    }

    if (continuationIndent && line.startsWith(continuationIndent)) {
      normalizedLines.push(line.slice(continuationIndent.length));
      continue;
    }

    if (tabContinuationIndent && line.startsWith(tabContinuationIndent)) {
      normalizedLines.push(line.slice(tabContinuationIndent.length));
      continue;
    }

    continuationIndent = null;
    tabContinuationIndent = null;
    normalizedLines.push(line);
  }

  return normalizedLines.join('\n');
}

function collectIoBracePromptInsertions(text: string, spans: IoHighlightSpan[]): IoHighlightInsertion[] {
  const insertions: IoHighlightInsertion[] = [];

  for (const span of spans) {
    if (span.className !== 'io-hl-brace-prompt') continue;
    const lineEnd = text.indexOf('\n', span.to);
    const lineBoundary = lineEnd >= 0 ? lineEnd : text.length;
    if (span.to !== lineBoundary) continue;
    insertions.push({
      at: span.to,
      className: 'io-hl-brace-prompt-hint',
      text: BRACE_PROMPT_HINT_LABEL,
    });
  }

  return insertions;
}

function highlightIoCodeBlocks(root: ParentNode): void {
  root.querySelectorAll('code.language-io').forEach((code) => {
    const text = normalizeIoDisplayText(code.textContent ?? '');
    const spans = collectIoHighlightSpans(text);
    const promptDecorations = collectIoPromptDecorations(text);
    code.classList.toggle('has-io-prompt-gutter', promptDecorations.spans.length > 0);
    const bracePromptInsertions = collectIoBracePromptInsertions(text, spans);
    spans.push(...promptDecorations.spans);
    spans.sort((a, b) => a.from - b.from || a.to - b.to);
    const insertions = [...promptDecorations.insertions, ...bracePromptInsertions].sort((a, b) => a.at - b.at);
    if (spans.length === 0 && insertions.length === 0) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let insertionIndex = 0;

    const flushInsertionsThrough = (limit: number) => {
      while (insertionIndex < insertions.length && insertions[insertionIndex].at <= limit) {
        const insertion = insertions[insertionIndex];
        if (cursor < insertion.at) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, insertion.at)));
          cursor = insertion.at;
        }
        const el = document.createElement('span');
        el.className = insertion.className;
        el.textContent = insertion.text;
        fragment.appendChild(el);
        insertionIndex += 1;
      }
    };

    for (const span of spans) {
      flushInsertionsThrough(span.from);
      if (span.from > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, span.from)));
      }
      const el = document.createElement('span');
      el.className = span.className;
      el.textContent = text.slice(span.from, span.to);
      fragment.appendChild(el);
      cursor = span.to;
    }

    flushInsertionsThrough(text.length);
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    code.textContent = '';
    code.appendChild(fragment);
  });
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

interface MarkdownFontVariant {
  italic: boolean;
  weight: number;
}

interface MarkdownFontReference {
  family: string;
  variants: MarkdownFontVariant[];
}

interface MarkdownFontConfig {
  load: MarkdownFontReference[];
  body: MarkdownFontReference | null;
  headings: MarkdownFontReference | null;
}

function splitCommaSeparatedValues(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = index > 0 ? value[index - 1] : '';

    if (char === "'" && !inDoubleQuote && previous !== '\\') {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }
    if (char === '"' && !inSingleQuote && previous !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }
    if (char === ',' && !inSingleQuote && !inDoubleQuote) {
      const part = stripMatchingQuotes(current.trim());
      if (part) parts.push(part);
      current = '';
      continue;
    }
    current += char;
  }

  const part = stripMatchingQuotes(current.trim());
  if (part) parts.push(part);
  return parts;
}

function parseFontFamilyScalar(value: string): string | null {
  const normalized = stripMatchingQuotes(value.trim());
  if (!normalized) return null;
  if (/[<>\\@]/.test(normalized)) return null;
  return normalized;
}

function parseFontVariantToken(value: string): MarkdownFontVariant | null {
  const normalized = stripMatchingQuotes(value.trim()).toLowerCase();
  const match = /^([1-9]00)(italic)?$/.exec(normalized);
  if (!match) return null;
  return {
    italic: match[2] === 'italic',
    weight: Number.parseInt(match[1], 10),
  };
}

function normalizeFontVariants(variants: MarkdownFontVariant[]): MarkdownFontVariant[] {
  const unique = new Map<string, MarkdownFontVariant>();
  for (const variant of variants) {
    unique.set(`${variant.italic ? 1 : 0}:${variant.weight}`, variant);
  }
  return Array.from(unique.values()).sort((a, b) => {
    if (a.italic !== b.italic) return Number(a.italic) - Number(b.italic);
    return a.weight - b.weight;
  });
}

function parseMarkdownFontReferenceScalar(value: string): MarkdownFontReference | null {
  const normalized = stripMatchingQuotes(value.trim());
  if (!normalized) return null;

  const atIndex = normalized.indexOf('@');
  if (atIndex === -1) {
    const family = parseFontFamilyScalar(normalized);
    return family ? { family, variants: [] } : null;
  }

  const family = parseFontFamilyScalar(normalized.slice(0, atIndex));
  if (!family) return null;

  const variantsSource = normalized.slice(atIndex + 1).trim();
  if (!variantsSource) return null;
  const variants = splitCommaSeparatedValues(variantsSource).map(parseFontVariantToken);
  if (variants.length === 0 || variants.some((variant) => !variant)) return null;
  return {
    family,
    variants: normalizeFontVariants(variants.filter((variant): variant is MarkdownFontVariant => variant != null)),
  };
}

function parseFontFamilyList(value: string): MarkdownFontReference[] | null {
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (!trimmed.startsWith('[') && !trimmed.endsWith(']') && trimmed.includes('@')) {
    const font = parseMarkdownFontReferenceScalar(trimmed);
    return font ? [font] : null;
  }

  const listSource = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
  if (!listSource) return [];

  const families = splitCommaSeparatedValues(listSource).map(parseMarkdownFontReferenceScalar);
  return families.length > 0 && families.every(Boolean)
    ? (families.filter((family): family is MarkdownFontReference => family != null) ?? null)
    : null;
}

function encodeGoogleFontsFamily(reference: MarkdownFontReference): string {
  const family = encodeURIComponent(reference.family).replace(/%20/g, '+');
  if (reference.variants.length === 0) return family;

  const hasItalic = reference.variants.some((variant) => variant.italic);
  if (!hasItalic) {
    return `${family}:wght@${reference.variants.map((variant) => variant.weight).join(';')}`;
  }

  return `${family}:ital,wght@${reference.variants
    .map((variant) => `${variant.italic ? 1 : 0},${variant.weight}`)
    .join(';')}`;
}

function uniqueFontReferences(references: MarkdownFontReference[]): MarkdownFontReference[] {
  const seen = new Set<string>();
  const result: MarkdownFontReference[] = [];
  for (const reference of references) {
    const key = `${reference.family.toLowerCase()}@${reference.variants
      .map((variant) => `${variant.italic ? 1 : 0}-${variant.weight}`)
      .join(';')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

function parseIndentedList(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { values: MarkdownFontReference[]; nextIndex: number; error: string | null } {
  const values: MarkdownFontReference[] = [];
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
    const value = parseMarkdownFontReferenceScalar(trimmed.slice(1).trim());
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

    const family = parseMarkdownFontReferenceScalar(value);
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

function buildGoogleFontsImportUrl(families: MarkdownFontReference[]): string {
  const query = families.map((family) => `family=${encodeGoogleFontsFamily(family)}`).join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

function formatFontFamilyCssValue(family: MarkdownFontReference): string {
  return `"${family.family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", var(--font-sans), sans-serif`;
}

function buildMarkdownFontCss(config: MarkdownFontConfig | null): string | null {
  if (!config) return null;

  const load = uniqueFontReferences(
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

    const match = /^([ \t]*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      return { css: null, error: 'Could not parse front matter' };
    }
    if (match[1].trim()) {
      return { css: null, error: 'Could not parse front matter' };
    }

    const key = match[2];
    const value = match[3].trim();

    // Skip unknown front matter keys and any indented children beneath them
    if (key !== 'css' && key !== 'fonts') {
      const parentIndent = countIndent(match[1]);
      for (let lookahead = index + 1; lookahead < lines.length; lookahead += 1) {
        const next = lines[lookahead];
        if (!next.trim()) continue;
        if (countIndent(next) <= parentIndent) break;
        index = lookahead;
      }
      continue;
    }

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
const ALLOWED_MARKDOWN_ROOT_TAG_ALIASES = new Set(['main']);
const MARKDOWN_ROOT_CLASS_SELECTOR_REWRITES = new Map([
  ['.content', 'data-markdown-custom-css-content'],
  ['.rendered-markdown', 'data-markdown-custom-css'],
]);
const MARKDOWN_ROOT_TAG_SELECTOR_REWRITES = new Map([['main', 'data-markdown-custom-css-main']]);

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
  if (trimmed.includes('<')) return false;

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
      const lower = token.toLowerCase();
      if (!ALLOWED_MARKDOWN_TAGS.has(lower) && !ALLOWED_MARKDOWN_ROOT_TAG_ALIASES.has(lower)) return false;
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

function rewriteSelectorToken(token: string, scope: string): string {
  const lower = token.toLowerCase();
  if (token.startsWith('.')) {
    const attribute = MARKDOWN_ROOT_CLASS_SELECTOR_REWRITES.get(lower);
    return attribute ? `[${attribute}="${scope}"]` : token;
  }

  const attribute = MARKDOWN_ROOT_TAG_SELECTOR_REWRITES.get(lower);
  return attribute ? `[${attribute}="${scope}"]` : token;
}

function buildScopedMarkdownSelector(selector: string, scope: string): string {
  const trimmed = selector.trim();
  const renderedMarkdownSelector = `.rendered-markdown[data-markdown-custom-css="${scope}"]`;
  const parts = trimmed.split(/(\s*[>+~]\s*|\s+)/).filter((part) => part.length > 0);
  let rewroteRootSelector = false;

  const rewritten = parts
    .map((part) => {
      if (/^\s*[>+~]?\s*$/.test(part)) return part;

      const tokens = part.match(/(?:^[a-z][a-z0-9-]*)|\.[a-z][a-z0-9-]*|:[a-z-]+/gi);
      if (!tokens) return part;

      return tokens
        .map((token) => {
          if (token.startsWith(':')) return token;
          const rewrittenToken = rewriteSelectorToken(token, scope);
          if (rewrittenToken !== token) rewroteRootSelector = true;
          return rewrittenToken;
        })
        .join('');
    })
    .join('');

  return rewroteRootSelector ? rewritten : `${renderedMarkdownSelector} ${trimmed}`;
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
  const scopedRules = rules
    .map((rule) => {
      const selectors = rule.selectors
        .map((selector) =>
          selector.theme
            ? `[data-theme="${selector.theme}"] ${buildScopedMarkdownSelector(selector.selector, scope)}`
            : buildScopedMarkdownSelector(selector.selector, scope),
        )
        .join(', ');
      return `${selectors} { ${rule.declarations}; }`;
    })
    .filter((rule): rule is string => Boolean(rule));

  return { css: [...imports, ...scopedRules].join('\n'), scope, hadRejectedRules };
}

function extractMarkdownDocument(text: string): {
  markdown: string;
  markdownOffset: number;
  customCss: string | null;
  customCssScope: string | null;
  frontMatterError: string | null;
  cssWarning: string | null;
} {
  const normalized = text.replace(/^\uFEFF/, '');
  const normalizedOffset = text.length - normalized.length;
  const leadingWhitespaceMatch = /^(?:[ \t]*\r?\n)+/.exec(normalized);
  const leadingWhitespaceOffset = leadingWhitespaceMatch?.[0].length ?? 0;
  const candidate = normalized.slice(leadingWhitespaceOffset);
  const frontMatter = parseMarkdownFrontMatterBlock(candidate);
  if (!frontMatter) {
    return {
      markdown: candidate,
      markdownOffset: normalizedOffset + leadingWhitespaceOffset,
      customCss: null,
      customCssScope: null,
      frontMatterError: null,
      cssWarning: null,
    };
  }
  if (frontMatter.error) {
    console.error('[markdown-frontmatter] Could not parse front matter', {
      error: frontMatter.error,
    });
    return {
      markdown: candidate,
      markdownOffset: normalizedOffset + leadingWhitespaceOffset,
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
      markdownOffset: normalizedOffset + leadingWhitespaceOffset,
      customCss: null,
      customCssScope: null,
      frontMatterError: parsedFrontMatter.error,
      cssWarning: null,
    };
  }

  const sanitizedCss = parsedFrontMatter.css ? sanitizeMarkdownCustomCss(parsedFrontMatter.css) : null;
  const contentOffsetMatch = /^---(?:\r?\n)[\s\S]*?(?:\r?\n)(?:---|\.\.\.)(?:\r?\n|$)/.exec(candidate);
  const markdownOffset = normalizedOffset + leadingWhitespaceOffset + (contentOffsetMatch?.[0].length ?? 0);
  return {
    markdown: frontMatter.content,
    markdownOffset,
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

const TYPOGRAPHY_WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const COMMON_LEADING_ELISIONS = ['bout', 'cause', 'em', 'nother', 'round', 'til', 'tis', 'twas'];

function isTypographyWordChar(char: string | null): boolean {
  return char != null && TYPOGRAPHY_WORD_CHAR_RE.test(char);
}

function isTypographyDigitChar(char: string | null): boolean {
  return char != null && /[0-9]/.test(char);
}

function isTypographyWhitespaceChar(char: string | null): boolean {
  return char != null && /\s/u.test(char);
}

function isTypographyOpeningPunctuationChar(char: string | null): boolean {
  return char != null && /[[({<\u2013\u2014]/u.test(char);
}

function isTypographyClosingPunctuationChar(char: string | null): boolean {
  return char != null && /[)\]}>.,!?;:]/u.test(char);
}

function previousTypographyChar(texts: string[], nodeIndex: number, charIndex: number): string | null {
  for (let currentNodeIndex = nodeIndex; currentNodeIndex >= 0; currentNodeIndex -= 1) {
    const text = texts[currentNodeIndex] ?? '';
    for (let index = currentNodeIndex === nodeIndex ? charIndex - 1 : text.length - 1; index >= 0; index -= 1) {
      const char = text[index];
      if (char === '\u200b') continue;
      return char;
    }
  }
  return null;
}

function nextTypographyChar(texts: string[], nodeIndex: number, charIndex: number): string | null {
  for (let currentNodeIndex = nodeIndex; currentNodeIndex < texts.length; currentNodeIndex += 1) {
    const text = texts[currentNodeIndex] ?? '';
    for (let index = currentNodeIndex === nodeIndex ? charIndex + 1 : 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\u200b') continue;
      return char;
    }
  }
  return null;
}

function readFollowingTypographyWord(texts: string[], nodeIndex: number, charIndex: number, maxLength = 8): string {
  let word = '';
  for (
    let currentNodeIndex = nodeIndex;
    currentNodeIndex < texts.length && word.length < maxLength;
    currentNodeIndex += 1
  ) {
    const text = texts[currentNodeIndex] ?? '';
    for (let index = currentNodeIndex === nodeIndex ? charIndex + 1 : 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\u200b') continue;
      if (!isTypographyWordChar(char)) return word;
      word += char.toLowerCase();
      if (word.length >= maxLength) return word;
    }
  }
  return word;
}

function shouldUseOpeningDoubleQuote(previous: string | null, next: string | null): boolean {
  return (
    (previous == null || isTypographyWhitespaceChar(previous) || isTypographyOpeningPunctuationChar(previous)) &&
    isTypographyWordChar(next)
  );
}

function shouldUseClosingDoubleQuote(previous: string | null, next: string | null): boolean {
  return (
    isTypographyWordChar(previous) &&
    (next == null || isTypographyWhitespaceChar(next) || isTypographyClosingPunctuationChar(next))
  );
}

function shouldKeepLiteralDoubleQuote(previous: string | null, next: string | null): boolean {
  return (
    isTypographyDigitChar(previous) &&
    (next == null || isTypographyWhitespaceChar(next) || isTypographyClosingPunctuationChar(next))
  );
}

function shouldUseOpeningSingleQuote(previous: string | null, next: string | null): boolean {
  return (
    (previous == null || isTypographyWhitespaceChar(previous) || isTypographyOpeningPunctuationChar(previous)) &&
    isTypographyWordChar(next)
  );
}

function shouldUseClosingSingleQuote(previous: string | null, next: string | null): boolean {
  return (
    isTypographyWordChar(previous) &&
    (next == null || isTypographyWhitespaceChar(next) || isTypographyClosingPunctuationChar(next))
  );
}

function shouldKeepLiteralSingleQuote(previous: string | null, next: string | null): boolean {
  return (
    isTypographyDigitChar(previous) &&
    (next == null || isTypographyWhitespaceChar(next) || isTypographyClosingPunctuationChar(next))
  );
}

function shouldUseApostrophe(previous: string | null, next: string | null): boolean {
  return isTypographyWordChar(previous) && isTypographyWordChar(next);
}

function shouldUseLeadingElision(previous: string | null, next: string | null, followingWord: string): boolean {
  if (!(previous == null || isTypographyWhitespaceChar(previous) || isTypographyOpeningPunctuationChar(previous))) {
    return false;
  }
  if (isTypographyDigitChar(next)) return true;
  return COMMON_LEADING_ELISIONS.some((prefix) => followingWord.startsWith(prefix));
}

function applySmartQuotesToText(
  text: string,
  texts: string[],
  nodeIndex: number,
  state: { doubleQuoteOpen: boolean; singleQuoteOpen: boolean },
): string {
  let output = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '"' && char !== "'") {
      output += char;
      continue;
    }

    const previous = previousTypographyChar(texts, nodeIndex, index);
    const next = nextTypographyChar(texts, nodeIndex, index);

    if (char === '"') {
      if (shouldKeepLiteralDoubleQuote(previous, next)) {
        output += char;
        continue;
      }
      if (shouldUseOpeningDoubleQuote(previous, next)) {
        state.doubleQuoteOpen = true;
        output += '“';
        continue;
      }
      if (state.doubleQuoteOpen && shouldUseClosingDoubleQuote(previous, next)) {
        state.doubleQuoteOpen = false;
        output += '”';
        continue;
      }
      output += char;
      continue;
    }

    if (shouldKeepLiteralSingleQuote(previous, next)) {
      output += char;
      continue;
    }
    if (shouldUseApostrophe(previous, next)) {
      output += '’';
      continue;
    }

    const followingWord = readFollowingTypographyWord(texts, nodeIndex, index);
    if (shouldUseLeadingElision(previous, next, followingWord)) {
      output += '’';
      continue;
    }
    if (shouldUseOpeningSingleQuote(previous, next)) {
      state.singleQuoteOpen = true;
      output += '‘';
      continue;
    }
    if (state.singleQuoteOpen && shouldUseClosingSingleQuote(previous, next)) {
      state.singleQuoteOpen = false;
      output += '’';
      continue;
    }
    output += char;
  }

  return output;
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

function isStandaloneCriticCommentBlock(element: Element): boolean {
  if (element.tagName !== 'P') return false;

  const meaningfulChildren = Array.from(element.childNodes).filter((child) => {
    if (child instanceof Text) {
      return /\S/.test(child.textContent ?? '');
    }
    return child.nodeType === Node.ELEMENT_NODE;
  });

  return (
    meaningfulChildren.length === 1 &&
    meaningfulChildren[0]?.nodeType === Node.ELEMENT_NODE &&
    (meaningfulChildren[0] as Element).classList.contains('critic-comment')
  );
}

function applyBlockLeadingIndent(element: Element): void {
  for (const child of Array.from(element.childNodes)) {
    if (child instanceof Text) {
      const text = child.textContent ?? '';
      if (!text) continue;

      const indent = leadingIndentInfo(text);
      if (!indent) return;

      child.textContent = text.slice(indent.raw.length);
      element.classList.add('leading-indent-block');
      if (element instanceof HTMLElement) {
        element.style.setProperty('--leading-indent-columns', String(indent.columns));
      }
      return;
    }

    if (child instanceof HTMLElement) {
      if (child.tagName === 'BR' || isWhitespacePreservingElement(child)) return;
      return;
    }
  }
}

function preserveLeadingIndentationInNode(node: Node, atLineStart: { value: boolean }): void {
  if (node instanceof Text) {
    const text = node.textContent ?? '';
    if (!text) return;
    const parent = node.parentNode;
    if (
      parent &&
      parent.nodeType === Node.ELEMENT_NODE &&
      isStandaloneCriticCommentBlock(parent as Element) &&
      !/\S/.test(text)
    ) {
      node.remove();
      return;
    }

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

      const newlineLength = text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1;
      const nextIndex = end + newlineLength;
      const nextLineIndent = /^[ \t]+/.exec(text.slice(nextIndex));
      if (!nextLineIndent) {
        fragment.appendChild(document.createTextNode(' '));
      }
      index = nextIndex;
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
    if (isStandaloneCriticCommentBlock(element)) return;
    applyBlockLeadingIndent(element);
    preserveLeadingIndentationInNode(element, { value: false });
  });
}

function applySmartPunctuation(root: ParentNode, options?: Pick<ParseMarkdownOptions, 'smartQuotes'>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && !shouldSkipSmartPunctuation(current.parentNode)) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  const originalTexts = textNodes.map((node) => node.textContent ?? '');
  const smartQuoteState = { doubleQuoteOpen: false, singleQuoteOpen: false };

  textNodes.forEach((node, nodeIndex) => {
    const original = originalTexts[nodeIndex] ?? '';
    const withSmartQuotes = options?.smartQuotes
      ? applySmartQuotesToText(original, originalTexts, nodeIndex, smartQuoteState)
      : original;

    // Only convert either " -- " or tight "word--word", leaving mixed spacing untouched.
    node.textContent = withSmartQuotes.replace(/(?<= )--(?= )|(?<=\S)--(?=\S)/g, (match, offset, text) => {
      const previous = offset > 0 ? text[offset - 1] : '';
      const next = offset + match.length < text.length ? text[offset + match.length] : '';
      if (previous === '{' || next === '}') return match;
      return '—';
    });
  });
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
    const rendered = parseMarkedHtml(definitionMarkdown, { breaks: false });
    const sanitized = sanitizeHtml(rendered, {
      ADD_ATTR: [
        'target',
        'rel',
        'data-wikilink',
        'data-wiki-target-path',
        'data-prompt-list-id',
        'data-inline-cite',
        'data-cite-key',
      ],
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

function applyInlineCitationNumbers(root: ParentNode): void {
  const citationNumbers = new Map<string, number>();
  let nextNumber = 1;

  root.querySelectorAll('sup[data-inline-cite="true"]').forEach((sup) => {
    if (!(sup instanceof HTMLElement)) return;
    const anchor = sup.querySelector('a');
    if (!(anchor instanceof HTMLAnchorElement)) return;

    const href = (anchor.getAttribute('href') ?? '').trim();
    if (!href) return;
    if (href === '#') {
      anchor.textContent = 'TODO';
      anchor.removeAttribute('aria-label');
      return;
    }

    const key = sup.getAttribute('data-cite-key');
    const identity = inlineCitationIdentity(key, href);
    let number = citationNumbers.get(identity);
    if (number == null) {
      number = nextNumber;
      nextNumber += 1;
      citationNumbers.set(identity, number);
    }

    anchor.textContent = `${number}`;
    anchor.setAttribute('aria-label', `Citation ${number}`);
  });
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

function parseMarkedHtml(markdown: string, options: { breaks: boolean; resetPromptListIds?: boolean }): string {
  if (options.resetPromptListIds) promptListConversationDuplicateCounts = new Map<string, number>();
  return marked.parse(markdown, { gfm: true, breaks: options.breaks }) as string;
}

function isMarkdownSyncableToken(token: Token): token is MarkdownSyncToken {
  return (
    token.type === 'heading' ||
    token.type === 'paragraph' ||
    token.type === 'blockquote' ||
    token.type === 'list' ||
    token.type === 'table' ||
    token.type === 'code' ||
    token.type === 'hr' ||
    token.type === 'promptList' ||
    token.type === 'templateTagLine'
  );
}

function buildMarkdownSyncBlocks(
  markdown: string,
  tokens: Token[],
  offset = 0,
  outputToOriginal?: number[],
): MarkdownSyncBlock[] {
  const syncBlocks: MarkdownSyncBlock[] = [];
  let searchStart = 0;
  let syncIndex = 0;

  for (const token of tokens) {
    if (typeof token.raw !== 'string') continue;
    const tokenIndex = markdown.indexOf(token.raw, searchStart);
    const from = tokenIndex >= 0 ? tokenIndex : searchStart;
    const to = from + token.raw.length;
    searchStart = Math.max(searchStart, to);

    if (!isMarkdownSyncableToken(token)) continue;
    const id = `md-sync-${syncIndex++}`;
    const mappedFrom = outputToOriginal?.[Math.max(0, Math.min(from, outputToOriginal.length - 1))] ?? from;
    const mappedTo = outputToOriginal?.[Math.max(0, Math.min(to, outputToOriginal.length - 1))] ?? to;
    syncBlocks.push({
      id,
      from: offset + mappedFrom,
      to: offset + mappedTo,
      type: token.type,
    });
  }

  return syncBlocks;
}

function createMarkdownSyncRenderer(): Renderer {
  const renderer = new Renderer();

  renderer.code = ({ text, lang, escaped, ...token }: Tokens.Code) => {
    const language = (lang || '').match(/^\S*/)?.[0];
    const code = `${text.replace(/\n$/, '')}\n`;
    if (language) {
      return `<pre${markdownSyncAttr(token as MarkdownSyncToken)}><code class="language-${escapeHtmlAttr(language)}">${escaped ? code : escapeHtmlAttr(code)}</code></pre>\n`;
    }
    return `<pre${markdownSyncAttr(token as MarkdownSyncToken)}><code>${escaped ? code : escapeHtmlAttr(code)}</code></pre>\n`;
  };

  renderer.blockquote = function (token: Tokens.Blockquote) {
    return `<blockquote${markdownSyncAttr(token as MarkdownSyncToken)}>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
  };

  renderer.heading = function (token: Tokens.Heading) {
    return `<h${token.depth}${markdownSyncAttr(token as MarkdownSyncToken)}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  };

  renderer.hr = (token: Tokens.Hr) => `<hr${markdownSyncAttr(token as MarkdownSyncToken)}>\n`;

  renderer.list = function (token: Tokens.List) {
    const body = token.items.map((item) => this.listitem(item)).join('');
    const tagName = token.ordered ? 'ol' : 'ul';
    const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
    return `<${tagName}${markdownSyncAttr(token as MarkdownSyncToken)}${startAttr}>\n${body}</${tagName}>\n`;
  };

  renderer.listitem = function (item: Tokens.ListItem) {
    return renderMarkdownListItem(this, item);
  };

  renderer.paragraph = function (token: Tokens.Paragraph) {
    return `<p${markdownSyncAttr(token as MarkdownSyncToken)}>${this.parser.parseInline(token.tokens)}</p>\n`;
  };

  renderer.table = function (token: Tokens.Table) {
    let header = '';
    let body = '';
    for (const cell of token.header) header += this.tablecell(cell);
    const headerRow = this.tablerow({ text: header });
    for (const row of token.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    const bodyHtml = body ? `<tbody>${body}</tbody>` : '';
    return `<table${markdownSyncAttr(token as MarkdownSyncToken)}>\n<thead>\n${headerRow}</thead>\n${bodyHtml}</table>\n`;
  };

  return renderer;
}

function parseMarkedHtmlWithSync(
  markdown: string,
  options: { breaks: boolean; resetPromptListIds?: boolean; syncOffset?: number; outputToOriginal?: number[] },
): { html: string; syncBlocks: MarkdownSyncBlock[] } {
  if (options.resetPromptListIds) promptListConversationDuplicateCounts = new Map<string, number>();

  const topLevelTokens = marked.lexer(markdown, { gfm: true, breaks: options.breaks }) as Token[];
  const syncBlocks = buildMarkdownSyncBlocks(
    markdown,
    topLevelTokens,
    options.syncOffset ?? 0,
    options.outputToOriginal,
  );
  const syncableTopLevelTokens = topLevelTokens.filter(isMarkdownSyncableToken);
  const syncQueue = syncableTopLevelTokens.map((token, index) => ({
    id: syncBlocks[index]?.id ?? '',
    raw: token.raw,
    type: token.type,
  }));
  let queueIndex = 0;

  const html = marked.parse(markdown, {
    gfm: true,
    breaks: options.breaks,
    renderer: createMarkdownSyncRenderer(),
    walkTokens(token) {
      const next = syncQueue[queueIndex];
      if (!next || token.type !== next.type || token.raw !== next.raw) return;
      (token as MarkdownSyncToken).syncId = next.id;
      queueIndex += 1;
    },
  }) as string;

  return { html, syncBlocks };
}

export function parseMarkdownDocument(text: string, options?: ParseMarkdownOptions): ParsedMarkdownDocument {
  const extracted = extractMarkdownDocument(text);
  const extractedFootnotes = extractFootnotes(extracted.markdown);
  const rendered = parseMarkedHtmlWithSync(extractedFootnotes.markdown, {
    breaks: options?.breaks ?? false,
    resetPromptListIds: true,
    syncOffset: extracted.markdownOffset,
    outputToOriginal: extractedFootnotes.outputToOriginal,
  });
  const sanitized = sanitizeHtml(rendered.html, {
    ADD_ATTR: [
      'target',
      'rel',
      'data-wikilink',
      'data-wiki-target-path',
      'data-prompt-list-id',
      'data-sync-id',
      'data-inline-cite',
      'data-cite-key',
    ],
  });
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  assignHeadingIds(template.content);
  const footnoteReferences = applyFootnoteReferences(template.content, extractedFootnotes.definitions);
  appendFootnotesSection(template.content, footnoteReferences, extractedFootnotes.definitions);
  applyInlineCitationNumbers(template.content);

  template.content.querySelectorAll('a').forEach((anchor: HTMLAnchorElement) => {
    const href = sanitizeMarkdownHref(anchor.getAttribute('href') ?? '');
    if (href == null) {
      const fragment = document.createDocumentFragment();
      while (anchor.firstChild) fragment.appendChild(anchor.firstChild);
      anchor.replaceWith(fragment);
      return;
    }

    anchor.setAttribute('href', href);
    anchor.classList.toggle('url-display-link', isRenderedUrlLabel(anchor, href));

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
  applySmartPunctuation(template.content, options);
  highlightIoCodeBlocks(template.content);

  return {
    html: template.innerHTML,
    customCss: extracted.customCss,
    customCssScope: extracted.customCssScope,
    frontMatterError: extracted.frontMatterError,
    cssWarning: extracted.cssWarning,
    syncBlocks: rendered.syncBlocks,
  };
}

export function parseMarkdownToHtml(text: string, options?: ParseMarkdownOptions): string {
  return parseMarkdownDocument(text, options).html;
}
