Use conventional commit style, e.g. start repos with "fix:" for fixes,
"feat:" for feature improvements. Don't include a scope on commit
messages, except use feat(ui): for changes that primarily concern the
user interface. Prefer single line commit messages. Never attempt
multiple git actions at the same time. If 'git add' and 'git commit'
are both necessary, run git add first, followed by git commit,
sequentially.

Clean up dead code, types, or files after making changes.

Run `npx biome check .`, `npx tsc`, and if any files in /server have
been changed, `npx tsc -p tsconfig.server.json` after making changes
to verify lint and types. To run tests, use `npx ava`.

`fly deploy` may print a warning that the app is not listening on
`0.0.0.0:8787` and only show `/.fly/hallpass` during one machine check
pass. When that happens, deployments still complete successfully with
machine checks passing and the app reachable afterward.

## Cursor Cloud specific instructions

### Services

- **Backend**: `npm run server` — Node.js HTTP server on port 8787 (uses Node 22 built-in SQLite, no external DB needed).
- **Frontend**: `npm run dev` — Vite dev server on port 5173, proxies `/api` to the backend.
- Both must run simultaneously for local development. See `DEVELOPING.md` for full setup.

### Git LFS

`shared/dictionary.bloom` is tracked by Git LFS. Run `git lfs pull` after cloning to materialize it; otherwise `reader_ai_tools` tests will fail.

### Lint / typecheck / test (see AGENTS.md top section)

- `npx biome check .` — lint
- `npx tsc` — frontend typecheck
- `npx tsc -p tsconfig.server.json` — server typecheck
- `npx ava` — all tests (543 pass, 1 skipped codex bridge live test)

### Notes

- The backend logs `configured=false` when GitHub OAuth env vars are empty; this is expected locally without OAuth credentials. Public repo viewing and the editor work without authentication.
- The `(node:…) ExperimentalWarning: SQLite` warning is expected on Node 22 and is harmless.
- No `.env` file is committed; copy `.env.example` to `.env` once after first clone.
