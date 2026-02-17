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

Create a fine-grained personal access token, with no expiration date
and no permissions, via https://github.com/settings/personal-access-tokens.
Copy it into your .env as GITHUB_TOKEN.

Create an OAuth app via https://github.com/settings/developers:

- Check **Enable Device Flow**.
- Set **Homepage URL** to your app URL (e.g. `http://localhost:5173/`).
- **Authorization callback URL** is not used by Device Flow but is
  required — any valid URL works.

Copy the **Client ID** into your .env as GITHUB_CLIENT_ID.

Create a GitHub App to allow Input to be installed onto repos, via
https://github.com/settings/apps/new:

- Set the **Homepage URL** and **Callback URL** to your app URL,
  e.g. `http://localhost:5173/`.
- Grant **Repository permissions → Contents: Read & write**.
- No webhook is required.

Copy the application ID, application slug, and a generated private key
into your .env.

```
# Terminal A — API server (default: http://localhost:8787)
npm run server

# Terminal B — Vite dev server (default: http://localhost:5173)
npm run dev
```

## Building for production

```
npm run build
```

Output is written to `dist/`. The API server serves both the API and
static files in production, so only one process is needed:

```
npm run server
```

## Deploying to Fly.io

Install the [Fly CLI](https://fly.io/docs/flyctl/install/) and sign in:

```
fly auth login
```

Create the app and set your secrets:

```
fly launch --no-deploy
fly secrets set SESSION_SECRET=$(openssl rand -hex 32)
fly secrets set GITHUB_CLIENT_ID=...
fly secrets set GITHUB_APP_ID=...
fly secrets set GITHUB_APP_SLUG=...
fly secrets set GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"
fly deploy
```

After deploying, update your GitHub OAuth App and GitHub App settings
to point to your production URL (e.g. `https://input.fly.dev`).

## License

MIT (C) 2026