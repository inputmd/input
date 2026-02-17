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

1) Install dependencies

```sh
npm install
```

2) Configure environment

Copy `.env.example` to `.env` and fill in the values:

```sh
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `8787`) |
| `TRUST_PROXY` | No | Set to `true` to trust `X-Forwarded-For` for rate limiting (when behind a reverse proxy) |
| `SESSION_SECRET` | No | Secret for signing session tokens. If unset, a random ephemeral secret is generated (sessions won't survive restarts) |
| `GITHUB_CLIENT_ID` | For gist auth | OAuth App Client ID for Device Flow sign-in (see step 3a below) |
| `GITHUB_APP_ID` | For repo auth | Your GitHub App's ID (see step 3b below) |
| `GITHUB_APP_SLUG` | For repo auth | Your GitHub App's URL slug |
| `GITHUB_APP_PRIVATE_KEY` | One of these | RSA private key as a string (use `\n` for newlines inside double quotes) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | One of these | Absolute path to the `.pem` private key file |

Generate a session secret:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

3a) Create an OAuth App (for gist sign-in)

1. Go to **GitHub → Settings → Developer settings → OAuth Apps** and create a new app.
2. Check **Enable Device Flow**.
3. Set the **Homepage URL** to your app URL (e.g. `http://localhost:5173/`). The **Authorization callback URL** is not used by Device Flow but is required by GitHub — any valid URL works.
4. Copy the **Client ID** into your `.env` as `GITHUB_CLIENT_ID`.

No client secret is needed — Device Flow is safe with a public client ID.

3b) Create a GitHub App (for repo access)

1. Go to **GitHub → Settings → Developer settings → GitHub Apps** and create a new app.
2. Grant **Repository permissions → Contents: Read & write**.
3. Set the **Setup URL** to your app URL (for local dev: `http://localhost:5173/`).
   - GitHub redirects back with `?installation_id=...&setup_action=...&state=...` after install.
4. Install the app on your account/org and select the repos you want to access.

4) Start the servers

```sh
# Terminal A — API server (default: http://localhost:8787)
npm run server

# Terminal B — Vite dev server (default: http://localhost:5173)
npm run dev
```

The Vite dev server proxies `/api` requests to the API server.

## Building for production

```sh
npm run build
```

Output is written to `dist/`. Serve the static files and run `npm run server` for the API.

## License

MIT (C) 2026