import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import type { BlockContext, InlineParser, Line, MarkdownExtension } from '@lezer/markdown';

const wikiLinkInlineParser: InlineParser = {
  name: 'WikiLink',
  before: 'Link',
  parse(cx, next, pos) {
    if (next !== 91 || cx.char(pos + 1) !== 91) return -1; // `[[`

    for (let index = pos + 2; index < cx.end; index += 1) {
      const ch = cx.char(index);
      if (ch === 10 || ch === 13) return -1; // don't span lines
      if (ch === 93 && cx.char(index + 1) === 93) {
        if (index === pos + 2) return -1; // disallow empty `[[ ]]`
        return cx.addElement(cx.elt('WikiLink', pos, index + 2));
      }
    }

    return -1;
  },
};

const wikiLinkMarkdownExtension: MarkdownExtension = {
  defineNodes: [{ name: 'WikiLink', style: tags.link }],
  parseInline: [wikiLinkInlineParser],
};

const htmlCommentInlineParser: InlineParser = {
  name: 'HtmlComment',
  before: 'Emphasis',
  parse(cx, next, pos) {
    if (next !== 60 || cx.char(pos + 1) !== 33 || cx.char(pos + 2) !== 45 || cx.char(pos + 3) !== 45) return -1;

    for (let index = pos + 4; index < cx.end - 2; index += 1) {
      const ch = cx.char(index);
      if (ch === 10 || ch === 13) return -1;
      if (ch === 45 && cx.char(index + 1) === 45 && cx.char(index + 2) === 62) {
        return cx.addElement(cx.elt('HtmlComment', pos, index + 3));
      }
    }

    return -1;
  },
};

const htmlCommentMarkdownExtension: MarkdownExtension = {
  defineNodes: [
    { name: 'HtmlComment', style: tags.comment },
    { name: 'HtmlCommentBlock', block: true, style: tags.comment },
  ],
  parseBlock: [
    {
      name: 'HtmlCommentBlock',
      parse(cx: BlockContext, line: Line) {
        if (!line.text.slice(line.pos).startsWith('<!--')) return false;

        const from = cx.lineStart + line.pos;

        while (!line.text.includes('-->') && cx.nextLine()) {}

        if (line.text.includes('-->')) {
          cx.nextLine();
        }

        const to = cx.prevLineEnd();
        cx.addElement(cx.elt('HtmlCommentBlock', from, to));
        return true;
      },
      before: 'SetextHeading',
    },
  ],
  parseInline: [htmlCommentInlineParser],
};

const markdownParserExtensions: MarkdownExtension = [
  {
    // Leaving HTML parsing enabled makes unfinished `<!--` comments
    // reclassify the remaining document and can cause severe typing lag.
    remove: ['HTMLBlock', 'HTMLTag'],
  },
  {
    remove: ['SetextHeading', 'IndentedCode'],
  },
  htmlCommentMarkdownExtension,
  wikiLinkMarkdownExtension,
];

export function markdownEditorLanguageSupport() {
  return markdown({
    base: markdownLanguage,
    completeHTMLTags: false,
    extensions: markdownParserExtensions,
  });
}

export function markdownCodeLanguageSupport() {
  return markdown({
    base: markdownLanguage,
    completeHTMLTags: false,
    extensions: [{ remove: ['HTMLBlock', 'HTMLTag', 'IndentedCode'] }, htmlCommentMarkdownExtension],
  });
}
