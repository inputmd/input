# Input

Input is a multi-file Markdown document editor, like Obsidian or HackMD,
where every workspace is a Git repo connected via the GitHub API.

Use it for personal notes, knowledge bases, or as a shared workspace for
organizations.

You can view any public GitHub repo inside Input by replacing github.com
with input.md, e.g. https://input.md/:username/:repo.

## Features

- **Multi-file**: Each gist or repo directory is a collection of `.md` files.
  Create, rename, or delete files.
- **Gists or repos**: Persist workspaces to specific Git repos without exposing
  all your files. Or persist to Gists if you don't want to connect a repo.
- **Share links**: Generate server-signed links for sharing individual private
  files from a private repo.
- **Reader AI**: Comes with an experimental AI interface similar to Cursor, that
  uses OpenRouter free models. Great for proofreading or quick edits.
- **Interoperable**: Except for share links, all data is stored in your Git repos.
  The server is just a caching proxy on top of the GitHub API.
- **Open source**: AGPL licensed, MIT licensed version coming soon.

## Quick use

You can view any public GitHub repo inside Input by replacing `github.com`
with `input.md`, for example `https://input.md/:username/:repo`.

## Prompt dialogue markdown

Reader AI prompt threads can be written directly in markdown using a custom
list syntax:

```md
-* What does this function do?
-- It normalizes the input and returns a stable cache key.
```

- `-* ` starts a prompt question.
- `-- ` starts a prompt answer.
- Indented continuation lines stay inside the same prompt item, so answers can
  include multiple paragraphs or nested lists.

These prompt dialogue lists render with a dedicated `prompt-list` class in the
viewer and keep prompt answers visually distinct from normal prose.

## Custom CSS

Markdown documents can include a `css` block in front matter. When present,
Input applies the sanitized CSS in both the document viewer and the editor
preview.

Selectors are scoped to the rendered markdown container, and class selectors
inside that container are allowed. ID selectors, attribute selectors,
pseudo-elements, and non-Google Fonts imports are still rejected.
Allowed properties cover common typography, spacing, sizing, wrapping, simple
layout, and list styling.

```yaml
---
css: |
  @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap");
  h1, p {
    color: #123456;
    font-family: "IBM Plex Sans", var(--reader-font-family), sans-serif;
  }
---
```

For Google Fonts, you can also use a higher-level `fonts` field instead of
writing the import URL directly:

```yaml
---
fonts: [Libre Franklin, Montserrat]
css: |
  p {
    font-family: "Libre Franklin", var(--font-sans), sans-serif;
  }

  h1, h2, h3 {
    font-family: "Montserrat", var(--font-sans), sans-serif;
  }
---
```

The `fonts` field also supports a structured form:

```yaml
---
fonts:
  body: Libre Franklin
  headings: Montserrat
---
```

When `fonts` is a list or comma-separated string, it is treated as `load`.
When `body` or `headings` is set, Input automatically loads those families
from Google Fonts and generates matching markdown font rules.

The CSS support is intentionally limited:

- Selectors are scoped to the rendered markdown root.
- Only a safe subset of typography, spacing, border, color, list, and text
  decoration properties is allowed.
- `@import` is allowed only for `https://fonts.googleapis.com/...`.
- All custom CSS is rejected if any rule uses an unsupported selector,
  property, or at-rule.

## Wildcard subdomains

`[username].input.md` automatically renders the public GitHub repo
`[username]/homepage` as a read-only workspace. This requires wildcard
DNS and TLS.

## Getting started

See [DEVELOPING.md](/Users/selkie/Development/input/DEVELOPING.md) for local
setup, environment variables, development workflow, and deployment notes.

## License

[AGPL-V3 (C) 2026](https://opensource.org/license/agpl-3-0-only)
