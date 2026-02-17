# Input

Markdown documents, backed by Gists & repos.

## Features

- **Gist viewer** — Paste any public gist URL to render its
    contents. Supports ANSI colors for e.g. Claude Code/Codex output.
- **Connect to gists** — Sign in with GitHub (OAuth Device Flow) to
    list, create, edit, and delete your gists as documents. Manual
    Personal Access Token entry is also supported as a fallback.
- **Connect to repos** — Connects to your Github repos as an installed
    application, to read/write Markdown files under
    `.input/documents/`.

## Prerequisites

- Node.js (v18+)
- npm

## Running locally

```
npm install
cp .env.example .env
```

Create an OAuth app via https://github.com/settings/developers:

- Check **Enable Device Flow**.
- Set **Homepage URL** to your app URL (e.g. `http://localhost:5173/`).
- **Authorization callback URL** is not used by Device Flow but is
  required — any valid URL works.

Copy the **Client ID** into your .env as GITHUB_CLIENT_ID.
No client secret is needed.

Create a GitHub App to allow Input to be installed onto repos, via
https://github.com/settings/apps/new:

- Set the **Homepage URL** and **Callback URL** to your app URL,
  e.g. `http://localhost:5173/`.
- Grant **Repository permissions → Contents: Read & write**.
- No webhook is required.

Copy the application ID, application slug, and a generated private key
into your .env.

```sh
# Terminal A — API server (default: http://localhost:8787)
npm run server

# Terminal B — Vite dev server (default: http://localhost:5173)
npm run dev
```

## Building for production

```sh
npm run build
```

Output is written to `dist/`. Serve the static files and run `npm run server` for the API.

## License

MIT (C) 2026