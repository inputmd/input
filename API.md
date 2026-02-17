## API endpoints

### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github-app/health` | Health check |
| `GET` | `/api/github-app/install-url?state=...` | Returns the GitHub App installation URL |
| `POST` | `/api/github-app/sessions` | Exchanges an `installationId` for a signed session token |

### Authenticated (requires `Authorization: Bearer <session-token>`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/github-app/installations/:id/repositories` | Lists repos accessible to the installation |
| `GET` | `/api/github-app/installations/:id/repos/:owner/:repo/contents?path=...` | Reads a file or directory listing |
| `PUT` | `/api/github-app/installations/:id/repos/:owner/:repo/contents` | Creates or updates a file (base64 content) |
| `DELETE` | `/api/github-app/installations/:id/repos/:owner/:repo/contents` | Deletes a file |

Session tokens are HMAC-SHA256 signed, scoped to a single installation, and expire after 8 hours. The `installationId` in the token must match the `:id` in the URL.

## Security

- CORS restricted to `https://input.md`, `localhost:5173`, and `localhost:5174`
- Per-IP rate limiting (30 requests/minute) on all API endpoints
- 1 MB request body limit with safe JSON parsing
- CSRF state validation on GitHub App install redirect
- PAT stored in `sessionStorage` (cleared when the tab closes)
- ANSI RGB values sanitized to prevent CSS injection
- Error messages sanitized — internal details logged server-side only
- 15-second timeout on all outbound GitHub API calls
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
- Graceful shutdown on `SIGTERM`/`SIGINT`
