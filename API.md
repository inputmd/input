## API endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github-app/health` | Health check |
| `GET` | `/api/auth/github/start?return_to=...` | Starts GitHub OAuth and redirects to GitHub |
| `GET` | `/api/auth/github/callback` | OAuth callback endpoint (redirects back to app) |
| `GET` | `/api/auth/session` | Returns current auth session (`authenticated`, `user`, `installationId`) |
| `POST` | `/api/auth/logout` | Clears the server-side auth session |
| `GET` | `/api/github-app/install-url?state=...` | Returns the GitHub App installation URL |
| `POST` | `/api/github-app/sessions` | Associates an `installationId` with the current auth session |
| `POST` | `/api/github-app/disconnect` | Clears the saved GitHub App installation from the current user session |
| `GET` | `/api/gists/:id` | Cached proxy for public gist reads (see [Gist proxy](#gist-proxy)) |
| `GET` | `/api/public/repos/:owner/:repo/contents?path=...&ref=...` | Reads public repo file or directory contents |
| `GET` | `/api/public/repos/:owner/:repo/raw?path=...` | Reads a public repo file as raw bytes |
| `GET` | `/api/public/repos/:owner/:repo/tree?ref=...&markdown_only=...` | Lists files from a public repo tree |
| `GET` | `/api/share/repo-file/:token` | Resolves a private repo-file share token |
| `GET` | `/api/ai/models` | Lists available Reader AI models (requires server config) |

### Authenticated (requires `input_session_id` cookie)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github/user` | Returns the authenticated GitHub user profile |
| `GET` | `/api/github/gists?per_page=...&page=...` | Lists authenticated user's gists |
| `POST` | `/api/github/gists` | Creates a gist |
| `GET` | `/api/github/gists/:id` | Reads an authenticated gist |
| `PATCH` | `/api/github/gists/:id` | Updates gist metadata/files |
| `DELETE` | `/api/github/gists/:id` | Deletes a gist |
| `GET` | `/api/github-app/installations/:id/repositories` | Lists repos accessible to the installation |
| `GET` | `/api/github-app/installations/:id/repos/:owner/:repo/contents?path=...` | Reads a file or directory listing |
| `PUT` | `/api/github-app/installations/:id/repos/:owner/:repo/contents` | Creates or updates a file (base64 content) |
| `DELETE` | `/api/github-app/installations/:id/repos/:owner/:repo/contents` | Deletes a file |
| `GET` | `/api/github-app/installations/:id/repos/:owner/:repo/raw?path=...` | Reads an installed repo file as raw bytes |
| `GET` | `/api/github-app/installations/:id/repos/:owner/:repo/tree?ref=...&markdown_only=...` | Lists files from an installed repo tree |
| `POST` | `/api/share/repo-file` | Creates a private share token for an installed markdown file |
| `POST` | `/api/ai/chat` | Streams Reader AI chat completions for markdown content |
| `POST` | `/api/ai/apply` | Applies Reader AI staged changes to a gist or installed repo |
| `POST` | `/api/ai/project` | Creates a temporary Reader AI project session from uploaded files |
| `GET` | `/api/ai/project/:id/files` | Returns modified files currently staged in a project session |
| `POST` | `/api/ai/project/:id/file` | Replaces or adds a file in a project session |
| `POST` | `/api/ai/project/:id/reset` | Clears staged changes in a project session |
| `DELETE` | `/api/ai/project/:id` | Deletes a project session |

Sessions are stored server-side in SQLite (`DATABASE_PATH`) and keyed by an `HttpOnly` cookie. `installationId` is linked to the signed-in GitHub user and enforced on repo API routes.

## Reader AI streaming events

`POST /api/ai/chat` returns an SSE stream. In addition to OpenRouter-compatible `data:` deltas, the server emits typed events:

- `event: summary` — summarized prior context when conversation compaction occurs.
- `event: tool_call`, `event: tool_result`, `event: task_progress` — tool loop telemetry.
- `event: staged_changes` — emitted when file changes are staged. Payload includes:
  - `changes`: array of `{ path, type, diff }`
  - `file_contents`: object map of `{ [path]: modifiedContent }` for non-delete changes
  - `suggested_commit_message`: generated commit message suggestion
  - `document_content`: full staged content in single-document edit mode (when available)

`POST /api/ai/apply` accepts `changes` plus `file_contents` and applies them directly to GitHub (gist/repo) without requiring an active Reader AI project session.

## Gist proxy

`GET /api/gists/:id` proxies public gist reads through the server with an in-memory LRU cache. The frontend uses this as a fallback when direct GitHub API calls fail (e.g. due to rate limiting).

### Client behavior

1. Fetch directly from `https://api.github.com/gists/:id` (unauthenticated, 60 requests/hour per client IP)
2. If that fails (rate limit, network error, etc.), fall back to `/api/gists/:id` on the server

### Server-side caching

- Responses are cached in-memory keyed by gist ID
- **TTL**: 5 minutes — fresh cache hits are served without contacting GitHub
- **ETag revalidation**: stale entries are revalidated with `If-None-Match`; a `304 Not Modified` from GitHub does not count against rate limits
- **Max entry size**: 512 KB (larger gists are proxied but not cached)
- **Max total cache**: 50 MB with LRU eviction
- Stale entries are served as a fallback if GitHub returns an error or is unreachable

The `X-Cache` response header indicates cache status: `hit`, `miss`, `revalidated`, or `stale`.

### Rate limits

| Path | Limit | Source |
|------|-------|--------|
| Direct GitHub API (client) | 60/hr per client IP | GitHub unauthenticated |
| `/api/gists/:id` (server) | 30/min per client IP | Server rate limiter |
| Server → GitHub | 60/hr per server IP, or 5,000/hr if `GITHUB_TOKEN` is set | GitHub |

Set `GITHUB_TOKEN` in `.env` to a fine-grained PAT with zero permissions to raise the server's GitHub rate limit from 60/hr to 5,000/hr.

## Security

- CORS restricted to `https://input.md` and `http://localhost:<CLIENT_PORT>` (default `5173`)
- Per-IP rate limiting (30 requests/minute) on all API endpoints
- 1 MB request body limit with safe JSON parsing
- CSRF state validation on OAuth and GitHub App install redirects
- Server-side sessions with `HttpOnly` cookies (`SameSite=Lax`)
- ANSI RGB values sanitized to prevent CSS injection
- Error messages sanitized — internal details logged server-side only
- 15-second timeout on all outbound GitHub API calls
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
- Graceful shutdown on `SIGTERM`/`SIGINT`
