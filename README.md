# Input

Multi-file markdown documents, backed by Gists & repos.

## Features

- **Multi-file documents** — Each gist or repo directory is a
    collection of `.md` files. A sidebar lets you switch between files,
    and create, rename, or delete them inline.
- **Gist viewer** — Paste any public gist URL to render its
    contents. Supports ANSI colors for e.g. Claude Code/Codex output.
- **Connect to gists** — Sign in with GitHub (OAuth web flow) to list,
    create, edit, and delete your gists as documents. Each gist holds
    one or more `.md` files.
- **Connect to repos** — Connects to your GitHub repos as an installed
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

Set `APP_URL` in `.env` to your API server URL (local default:
`http://localhost:8787`). OAuth redirect URIs are generated from this value.

Create a fine-grained personal access token with no permissions via
https://github.com/settings/personal-access-tokens. This is optional
and only used to raise server-side rate limits for public gist proxy
fallbacks. Copy it into `.env` as `GITHUB_TOKEN`.

Create an OAuth app via https://github.com/settings/developers:

- Set **Homepage URL** to the same origin as `APP_URL`
  (local: `http://localhost:8787/`).
- Set **Authorization callback URL** to
  `http://localhost:8787/api/auth/github/callback`.

Use the same hostname and port for both fields locally.

Copy the **Client ID** and **Client secret** into `.env` as
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

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

Auth sessions and remembered GitHub App installations are persisted in
SQLite using `DATABASE_PATH` (default `./.data/input.db`).

Optional frontend cache tuning:

- `VITE_GISTS_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github/gists`.
- `VITE_REPO_CONTENTS_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github-app/installations/:id/repos/:owner/:repo/contents`.

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

Create the app, persistent volume, and secrets:

```
fly launch --no-deploy
fly volumes create data --size 1 --region ewr -n 2
fly secrets set GITHUB_CLIENT_ID=...
fly secrets set GITHUB_CLIENT_SECRET=...
fly secrets set GITHUB_APP_ID=...
fly secrets set GITHUB_APP_SLUG=...
fly secrets set GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"
fly deploy
```

`fly.toml` mounts the `data` volume at `/data` and sets
`DATABASE_PATH=/data/input.db`, so sessions and remembered GitHub App
installations persist across restarts/deploys.

After deploying, update your GitHub OAuth App and GitHub App settings:

- **Homepage URL**: `https://input-dry-thunder-7019.fly.dev/`
- **OAuth callback URL**:
  `https://input-dry-thunder-7019.fly.dev/api/auth/github/callback`
- **GitHub App callback URL**:
  `https://input-dry-thunder-7019.fly.dev/`

Note: during deploys, Fly may briefly need more than one unattached
`data` volume in the region for rolling replacement. Creating two
volumes up front avoids that failure mode.

## License

MIT (C) 2026
