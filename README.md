# Input

Input is a multi-file Markdown document editor, like Obsidian or HackMD,
where every workspace is a Git repo connected via the GitHub API.

Use it for personal notes, knowledge bases, or as a shared workspace for
organizations.

You can view any public GitHub repo inside Input by replacing github.com
with input.md, e.g. https://input.md/:username/:repo.

Also, `[username].input.md` automatically renders the public GitHub repo
`[username]/homepage` as a read-only workspace.

## Features

- **Multi-file**: Each gist or repo directory is a collection of `.md` files.
  Create, rename, or delete files.
- **Gists or repos**: Persist workspaces to specific Git repos without exposing
  all your files. Or persist to Gists if you don't want to connect a repo.
- **Share links**: Generate server-signed links for sharing individual private
  files from a private repo.
- **Share editors**: Add an `editors` field in Markdown front matter to let
  specific GitHub users open and update a private repo document, without
  repo-wide write access.
- **Reader AI**: Comes with an experimental AI interface similar to Cursor, that
  uses OpenRouter free models. Great for proofreading or quick edits.
- **Interoperable**: Except for share links, all data is stored in your Git repos.
  The server is just a caching proxy on top of the GitHub API.
- **Open source**: AGPL licensed, MIT licensed version coming soon.

## Inline Prompting

You can prompt the currently selected AI directly inside the Markdown editor
using a custom list syntax:

- `% ` starts a prompt question.
- `= ` starts a prompt answer.

You can also create branches by indenting. Indented continuations will not be
included in further lines below the current one.

```md
% How many r's are in strawberry.
= There are three r's in strawberry - one in "straw", two in "berry".
  % Let me start a quick sidebar about that...
% Okay, how about blueberry?
```

You can change the AI used to respond to prompts by selecting it from the
sidebar. By default, we have selected a few of the best free models on
OpenRouter (e.g. NVIDIA Nemotron Super 120B, a Haiku-level model).

## Custom CSS and Fonts

Markdown documents can include a `css` block in front matter. When present,
Input applies the sanitized CSS in both the document viewer and the editor
preview.

Selectors are scoped to the rendered markdown container, and class selectors
inside that container are allowed. ID selectors, attribute selectors,
pseudo-elements are still rejected. Allowed properties cover common typography,
spacing, sizing, wrapping, simple layout, and list styling.

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

## Shared Editors

You can share individual fiiles by editing the front matter:

```yaml
---
editors:
  - alice
  - @bob
---
```

GitHub usernames listed in `editors` can open that document through Input
and save changes back to the repo. Editors are blocked from changing or
removing the `editors` field.

## Getting started

See [DEVELOPING.md](/Users/selkie/Development/input/DEVELOPING.md) for local
setup, environment variables, development workflow, and deployment notes.

## License

[AGPL-V3 (C) 2026](https://opensource.org/license/agpl-3-0-only)
