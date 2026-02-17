# Input (WIP)

## GitHub App (repo-scoped) auth prototype

This repo now includes a tiny local server that mints **GitHub App installation access tokens** and lets the frontend list repos accessible to the installation.
It also includes a small repo-backed document store that reads/writes Markdown files via the GitHub **Contents API** under `.input/documents/`.

### 1) Create/configure a GitHub App

- Create a GitHub App (GitHub → Settings → Developer settings → GitHub Apps).
- Grant **Repository permissions → Contents: Read & write** (repo file storage uses the Contents API).
- Set the **Setup URL** to your app URL (for local dev: `http://localhost:5173/`).
  - After install/update, GitHub will redirect back with `?installation_id=...&setup_action=...&state=...`.
  - The frontend captures `installation_id` from the query string and stores it in `localStorage`.
- Install the app on your account/org and select repos (repo-scoped).

### 2) Run locally

- Copy `.env.example` to `.env` and fill:
  - `GITHUB_APP_ID`
  - `GITHUB_APP_SLUG`
  - `GITHUB_APP_PRIVATE_KEY` **or** `GITHUB_APP_PRIVATE_KEY_PATH`
- Terminal A: `npm run server` (defaults to `http://localhost:8787`)
- Terminal B: `npm run dev` (Vite; defaults to `http://localhost:5173`)

### Endpoints

- `GET /api/github-app/install-url?state=...` → returns the GitHub App install URL.
- `GET /api/github-app/installations/:installationId/repositories` → lists repos for that installation.
- `GET /api/github-app/installations/:installationId/repos/:owner/:repo/contents?path=...` → reads repo contents (file or directory listing).
- `PUT /api/github-app/installations/:installationId/repos/:owner/:repo/contents` → creates/updates a file (base64 content).
- `DELETE /api/github-app/installations/:installationId/repos/:owner/:repo/contents` → deletes a file.
- `POST /api/github-app/debug/installation-token` → returns an installation token (debug only; don’t expose in prod).
