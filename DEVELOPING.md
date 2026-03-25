# Developer Instructions

## Prerequisites

- Node.js (v22+)
- npm

## Quickstart

```sh
npm install
cp .env.example .env
```

Then run the app in two terminals:

```sh
# Terminal A - API server (default: http://localhost:8787)
npm run server

# Terminal B - Vite dev server (default: http://localhost:5173)
npm run dev
```

## Local setup

Set `APP_URL` in `.env` to your API server URL (local default:
`http://localhost:8787`). OAuth redirect URIs are generated from this value.

Create a fine-grained personal access token with no permissions via
https://github.com/settings/personal-access-tokens. This is optional and only
used to raise server-side rate limits for public gist proxy fallbacks. Copy it
into `.env` as `GITHUB_TOKEN`.

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
- Grant **Repository permissions -> Contents: Read & write**.
- No webhook is required.

Copy the application ID, application slug, and a generated private key into
`.env`.

On the **Optional features** page, opt out of "User-to-server token expiration".

Set `CLIENT_PORT` in `.env` if you want to run the Vite dev server on a
different port. The API server CORS allowlist uses this value.

Auth sessions and remembered GitHub App installations are persisted in SQLite
using `DATABASE_PATH` (default `./.data/input.db`).

## Optional configuration

Frontend cache tuning:

- `VITE_GISTS_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github/gists`.
- `VITE_GIST_DETAIL_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github/gists/:id`.
- `VITE_REPO_CONTENTS_CACHE_TTL_MS` controls client-side cache TTL for
  `GET /api/github-app/installations/:id/repos/:owner/:repo/contents`.

Reader AI setup:

- Set `OPENROUTER_API_KEY` in `.env` to enable markdown Q&A in the Reader AI
  panel.
- Optionally set `OPENROUTER_PAID_API_KEY` to enable a small hardcoded list of
  paid OpenRouter models that always use the paid key:
  `anthropic/claude-opus-4.6`, `anthropic/claude-sonnet-4.6`,
  `google/gemini-3-flash-preview`, and `google/gemini-3-pro-preview`.
- Reader AI requests are proxied through the backend (`/api/ai/*`) and do not
  call OpenRouter directly from the browser.

## Local Codex app-server

By default, Input comes with a set of free models hosted on OpenRouter, which
you can use by setting `OPENROUTER_API_KEY`.

You can also set `OPENROUTER_PAID_API_KEY` to enable paid models, including the
latest Claude and Gemini models.

For OpenAI models, you can use a local Codex instance instead of OpenRouter:

```sh
npm run codex-bridge
```

By default this starts a local HTTP bridge on `http://127.0.0.1:8788` and
connects it to a Codex app-server at `ws://127.0.0.1:8765`. If the app-server
is not already running, the bridge will try to start it for you by running
`codex app-server --listen ws://127.0.0.1:8765`.

Optional environment variables:

- `CODEX_BRIDGE_PORT` to change the local bridge port.
- `CODEX_APP_SERVER_URL` to point at a different Codex app-server URL.
- `CODEX_BRIDGE_START_APP_SERVER=0` to disable auto-starting the Codex
  app-server.
- `CODEX_BRIDGE_ALLOWED_ORIGINS` to add extra allowed browser origins.

Very briefly, the bridge keeps the Codex JSON-RPC protocol out of the browser.
The UI talks to the local bridge over HTTP/SSE, and the bridge talks to the
local Codex app-server over WebSocket while adapting Reader AI and inline edit
requests into Codex threads and turns.

## Production build

```sh
npm run build
```

Output is written to `dist/`. The API server serves both the API and static
files in production, so only one process is needed:

```sh
npm run server
```

## Deploying to Fly.io

Install the [Fly CLI](https://fly.io/docs/flyctl/install/) and sign in:

```sh
fly auth login
```

Create the app, persistent volume, and secrets:

```sh
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
installations persist across restarts and deploys.

After deploying, update your GitHub OAuth App and GitHub App settings:

- **Homepage URL**: `https://input-dry-thunder-7019.fly.dev/`
- **OAuth callback URL**:
  `https://input-dry-thunder-7019.fly.dev/api/auth/github/callback`
- **GitHub App callback URL**:
  `https://input-dry-thunder-7019.fly.dev/`

During deploys, Fly may briefly need more than one unattached `data` volume in
the region for rolling replacement. Creating two volumes up front avoids that
failure mode.

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

### Proxy trust and rate limiting

The server rate limiter (`server/rate_limit.ts`) uses the first IP address from
the `X-Forwarded-For` header to identify clients. This is safe when running
behind a trusted reverse proxy (Fly.io / Cloudflare) that overwrites the header
before forwarding requests. If the server is ever exposed directly to the
internet without a trusted proxy in front, clients could spoof this header to
bypass per-IP rate limits.

### Protected subdomains

`www`, `api`, `app`, `mail`, `ftp`, `admin`, `blog`, `docs`, `status`,
`cdn`, `staging`, and `dev` are reserved and bypass subdomain routing.
