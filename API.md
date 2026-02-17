## API endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github-app/health` | Health check |
| `GET` | `/api/github-app/install-url?state=...` | Returns the GitHub App installation URL |
| `POST` | `/api/github-app/sessions` | Exchanges an `installationId` for a signed session token |
| `GET` | `/api/gists/:id` | Cached proxy for public gist reads (see [Gist proxy](#gist-proxy)) |
| `POST` | `/api/device-flow/code` | Initiates GitHub Device Flow for gist OAuth |
| `POST` | `/api/device-flow/token` | Polls for a Device Flow access token (requires `device_code` in body) |

### Authenticated (requires `Authorization: Bearer <session-token>`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github-app/installations/:id/repositories` | Lists repos accessible to the installation |
| `GET` | `/api/github-app/installations/:id/repos/:owner/:repo/contents?path=...` | Reads a file or directory listing |
| `PUT` | `/api/github-app/installations/:id/repos/:owner/:repo/contents` | Creates or updates a file (base64 content) |
| `DELETE` | `/api/github-app/installations/:id/repos/:owner/:repo/contents` | Deletes a file |

Session tokens are HMAC-SHA256 signed, scoped to a single installation, and expire after 8 hours. The `installationId` in the token must match the `:id` in the URL.

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

- CORS restricted to `https://input.md`, `localhost:5173`, and `localhost:5174`
- Per-IP rate limiting (30 requests/minute) on all API endpoints
- 1 MB request body limit with safe JSON parsing
- CSRF state validation on GitHub App install redirect
- Manual PAT and GitHub App session token stored in `sessionStorage` (cleared when the tab closes); OAuth Device Flow token stored in `localStorage` (persists across sessions)
- ANSI RGB values sanitized to prevent CSS injection
- Error messages sanitized — internal details logged server-side only
- 15-second timeout on all outbound GitHub API calls
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
- Graceful shutdown on `SIGTERM`/`SIGINT`
