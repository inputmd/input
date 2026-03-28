# Extended Markdown Syntax

Input uses [marked](https://marked.js.org/) with GFM enabled, plus the custom extensions below. Standard features like headings, bold, italic, links, images, lists, blockquotes, fenced code blocks, tables, and strikethrough all work as expected.

## Prompt Lists

Conversational turn-taking lists using special markers:

```
~ What is the capital of France?
⏺ The capital of France is Paris.
```

| Marker | Role |
|--------|------|
| `~` | Question |
| `❯` | Question |
| `⏺` | Answer |
| `✻` | Comment |
| `%` | Comment |

Continuation lines are indented 2 spaces (or 1 tab) past the marker column. A single blank line between items keeps them in one list; two blank lines start a new one.

**Nesting:** Indent items to create branches:

```
~ Top-level question
⏺ Answer
  ~ Follow-up question
  ⏺ Nested answer
```

Multi-message lists (2+ items) are wrapped in a collapsible "Conversation with N messages" container. Long multi-paragraph answers get a "Show more" toggle.

An empty item (marker with no text) renders an animated placeholder.

## CriticMarkup

Inline editorial annotations ([CriticMarkup](https://criticmarkup.com/) spec, single-line only):

| Syntax | Meaning | Renders as |
|--------|---------|------------|
| `{++text++}` | Addition | `<ins>` |
| `{--text--}` | Deletion | `<del>` |
| `{==text==}` | Highlight | `<mark>` |
| `{>>text<<}` | Comment | inline comment |
| `{~~old~>new~~}` | Substitution | `<del>old</del><ins>new</ins>` |

## Wikilinks

```
[[Page Name]]
[[Page Name|Display Label]]
```

Links to `page-name.md` (slugified). If the target includes path separators (`/`), they are preserved. Missing targets are styled with a `missing-wikilink` class.

## Footnotes

```
Some claim.[^1]

[^1]: Supporting detail here.
```

Footnote definitions are extracted before parsing. References become superscript numbers linking to a footnotes section at the bottom. Multi-line definitions use indented continuation (2+ spaces or tab).

## Superscript

```
H^2^O           -->  H<sup>2</sup>O
```

Text between `^` markers (no whitespace at boundaries) is rendered as superscript.

## Superscript Links

```
[^docs](https://example.com)
```

Renders as a superscript link. Note: The special label `[^src]` auto-derives display text: X/Twitter URLs show the handle; other URLs show the domain.

## Emoji Shortcodes

```
:white_check_mark:  -->  ✅
:+1:                -->  👍
```

Uses the [gemoji](https://github.com/wooorm/gemoji) name-to-emoji mapping. Unknown shortcodes are left as literal text.

## Bracketed Text

```
[draft]
[TODO]
```

Bare brackets (not followed by `(`, `[`, or `:`, and not starting with `^`) render as a styled inline label.

## Brace Expansion Prompts

```
{draft a reply}
{come up with two more examples}
```

Curly-brace-wrapped text (that doesn't overlap with CriticMarkup) renders as a styled inline prompt. Braces are preserved in the output.

## Template Tag Lines

```
{% TODO %}
```

Lines matching `{% ... %}` are rendered as literal text in a paragraph, preventing them from being parsed as prompt list items.

## Front Matter

YAML front matter between `---` fences at the top of the document supports two keys:

### Custom CSS

```yaml
---
css: |
  h1 { color: #8B0000; }
  :light p { background: white; }
  :dark p { background: #1a1a1a; }
---
```

CSS is sanitized against an allowlist of properties. Only `@import` for Google Fonts URLs is permitted. `:light` and `:dark` pseudo-selectors scope rules to the corresponding theme. No `@media`, `@supports`, or `@layer`.

### Custom Fonts

```yaml
---
fonts: [Libre Franklin, Montserrat]
---
```

Or with per-role assignment:

```yaml
---
fonts:
  body: Libre Franklin
  headings: Montserrat
---
```

Fonts are loaded from Google Fonts and applied as `font-family` rules.

## Smart Punctuation

`--` is converted to an em-dash (\u2014) outside of `<code>`, `<pre>`, `<kbd>`, and `<samp>` elements.

## Leading Indentation

Since indented code blocks are disabled, leading whitespace in paragraphs and list items is preserved visually via CSS custom properties.

## Image Dimensions

```
![photo](image.png "input-size=640x480")
```

The `input-size=WxH` pattern in an image title sets `width` and `height` attributes on the `<img>` element.

## Link Auto-Protocol

Bare domains like `example.com` get `https://` prepended automatically. Localhost and IP addresses get `http://`. Non-HTTP protocols are stripped.

## Disabled Standard Features

| Feature | Reason |
|---------|--------|
| Setext headings (`===`/`---` underlines) | Dashes stay as literal content |
| Indented code blocks (4-space indent) | Leading spaces are preserved as prose instead |
| HTML blocks and inline HTML tags | Only closed HTML comments (`<!-- -->`) are allowed |
| Mailto autolinks | Email addresses are rendered as plain text |
