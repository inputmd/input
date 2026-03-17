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

## Prerequisites

- Node.js (v22+)
- npm

## Quickstart

```
npm i

# In two separate terminals:
npm run dev
npm run server
```

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
  e.g. `http://localhost:5173/` (or your `CLIENT_PORT` value).
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

Set `CLIENT_PORT` in `.env` if you want to run the Vite dev server on a
different port. The API server CORS allowlist uses this value.

Auth sessions and remembered GitHub App installations are persisted in
SQLite using `DATABASE_PATH` (default `./.data/input.db`).

Optional frontend cache tuning:

- `VITE_GISTS_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github/gists`.
- `VITE_GIST_DETAIL_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github/gists/:id`.
- `VITE_REPO_CONTENTS_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github-app/installations/:id/repos/:owner/:repo/contents`.

Optional Reader AI setup:

- Set `OPENROUTER_API_KEY` in `.env` to enable markdown Q&A in the Reader
  AI panel.
- Optionally set `OPENROUTER_PAID_API_KEY` to enable a small hardcoded list
  of paid OpenRouter models that always use the paid key:
  `google/gemini-3-flash-preview` and
  `google/gemini-3.1-flash-lite-preview`.
- Reader AI requests are proxied through the backend (`/api/ai/*`) and
  do not call OpenRouter directly from the browser.

## Custom CSS

Markdown documents can include a `css` block in front matter. When present,
Input applies the sanitized CSS in both the document viewer and the editor
preview.

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
fly secrets set OPENROUTER_API_KEY=...
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

## Wildcard subdomains

`[username].input.md` automatically renders the public GitHub repo
`[username]/homepage` as a read-only workspace. This requires wildcard
DNS and TLS.

### Fly.io TLS

Issue a wildcard certificate so Fly can terminate TLS from Cloudflare
(required when SSL mode is Full (strict)):

```
fly certs create "*.input.md" -a input-dry-thunder-7019
```

This returns the A/AAAA IP addresses and an ACME challenge record needed
for the steps below. Check status at any time with:

```
fly certs show "*.input.md" -a input-dry-thunder-7019
```

### Cloudflare DNS

Add wildcard A and AAAA records using the IP addresses from `fly certs`,
plus the ACME challenge CNAME for certificate validation:

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| `A` | `*` | *(A IP from `fly certs`)* | Proxied |
| `AAAA` | `*` | *(AAAA IP from `fly certs`)* | Proxied |
| `CNAME` | `_acme-challenge` | *(target from `fly certs`)* | **DNS only** |

**Important:** The `_acme-challenge` record **must** be set to DNS only
(grey cloud, not proxied). Cloudflare proxying will prevent Fly from
validating the certificate.

### Cloudflare settings

- **SSL/TLS > Overview**: Full (strict)
- **SSL/TLS > Edge Certificates**: Verify Universal SSL covers `*.input.md`

### Protected subdomains

`www`, `api`, `app`, `mail`, `ftp`, `admin`, `blog`, `docs`, `status`,
`cdn`, `staging`, and `dev` are reserved and bypass subdomain routing.

## License

[AGPL-V3 (C) 2026](https://opensource.org/license/agpl-3-0-only)
