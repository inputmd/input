# Sandboxes PRD + Implementation Plan

## 1. Motivation and Project Description

Input helps users edit Markdown in GitHub repos, but does not provide a safe execution environment for running terminal workflows against those repos. Users want a browser-native coding/runtime workflow tied directly to their repositories, launchable from My Repos, and isolated from the app server. This project replaces the existing workspace-based sandbox system with a repo-scoped sandbox experience powered by Fly runner VMs, with persistence via connected GitHub repos.

The goal is to make Input a practical environment for quick-turn repo work: prompt, inspect, run commands, and write results back to the repo branch with minimal friction.

## 2. Problem Statement

The current `/sandboxes` system has fundamental issues:

- **Commands execute on the API host.** `runtime.ts` shells out via `execFile('/bin/zsh', ...)` directly on the server process. This is a critical security and isolation gap.
- **Workspaces are opaque, not repo-scoped.** Workspaces are identified by random hex IDs with user-chosen names, and have no association to any GitHub repo. The route is `/sandboxes/:workspaceId`.
- **Local disk persistence doesn't scale.** Workspace state lives in `.data/sandboxes/<userId>/<workspaceId>/` on the single Fly volume. No backup, no multi-machine support.
- **No VM isolation.** There is no Fly runner VM layer — the app is a single 256MB machine.

We need to evolve this into:

- True sandbox isolation via separate Fly runner VMs for command execution.
- Repo-scoped identity (`/sandboxes/:owner/:repo`) replacing opaque workspace IDs.
- Git-backed persistence through GitHub API, eliminating local disk as source of truth.
- Seamless entry from existing My Repos UX.

## 3. Product Goals

- Provide isolated terminal execution per repo at `/sandboxes/:owner/:repo`.
- Launch sandboxes directly from My Repos via a new `Sandbox` action.
- Persist all meaningful work by syncing changes to the connected Git repo.
- Keep implementation aligned with existing Input auth/session and GitHub App permissions.
- Keep API and UI latency acceptable for interactive terminal usage.

## 4. Non-Goals

- Gist support in sandboxes.
- Share/fork/eval/artifact workflows in this phase.
- General-purpose VM management UI outside repo-scoped sandbox usage.
- New generic storage abstraction for sandbox filesystem persistence.
- Preserving backwards compatibility with the existing workspace-based sandbox model.

## 5. Users and Primary Jobs

- Repo owner/editor using Input with installed GitHub App permissions.
- Job to be done: "Open a repo in Input, run terminal tasks safely in the browser, and commit/push my changes back to the same repo."

## 6. Existing System — What Was Replaced

The previous sandbox implementation consisted of:

**Backend (`server/sandboxes/`):**
- `router.ts` — workspace CRUD, compose, and command endpoints under `/api/sandboxes/workspaces/:id/*`
- `runtime.ts` — local command execution via `execFile` on API host
- `store.ts` — SQLite-backed workspace metadata (`sandboxes_workspaces` table)
- `keys.ts` — AES-256-GCM encrypted user API key storage (`sandboxes_user_keys` table)
- `auth.ts` — session/rate-limit checks delegating to main session system
- `composer.ts` + `providers/openai.ts` — OpenAI-based compose flow using user-provided key
- `types.ts` — workspace/command/compose result types

**Frontend (`src/sandboxes/`):**
- `App.tsx` — workspace list, compose panel, terminal panel (single monolithic component)
- `api.ts` — fetch wrappers for all workspace endpoints
- `types.ts` — client-side type mirrors
- `styles.css` — sandbox-specific styles

**What carried forward:**
- `keys.ts` — encrypted key storage is sound and reusable
- `auth.ts` — session/rate-limit delegation pattern
- `composer.ts` — compose flow adapted for repo context
- SQLite as metadata store (schema changed)

**What was replaced:**
- `runtime.ts` — replaced by `fly_runtime.ts` (Fly runner VM adapter). Old local `execFile` path fully removed.
- `store.ts` — schema changed from workspace-centric to repo-scoped (`sandbox_sessions` table)
- `router.ts` — new route structure under `/api/sandboxes/repos/:owner/:repo/*`
- `App.tsx` — rebuilt around repo identity, HTTP command execution, git status
- `api.ts` + `types.ts` — new API surface

## 7. User Experience

- Route: `/sandboxes/:owner/:repo` as canonical entry for sandbox UI.
- My Repos card has `Sandbox` button next to `Open` — navigates in the same tab.
- If user is authenticated but repo is not accessible via installation, show clear authorization/reconnect guidance.
- Terminal panel supports command execution via HTTP POST with logs, exit status, and working directory context.
- Composer panel is optional and uses user-provided key policy already implemented.
- Git panel shows changed files, supports commit/push/pull actions.

## 8. Functional Requirements

- Create or attach a Fly runner VM for a specific repo sandbox.
- Clone the target repo onto the runner VM using GitHub App installation tokens.
- Execute commands in repo working directory via HTTP (runner agent `/exec` endpoint).
- Track sandbox lifecycle states: `provisioning`, `hydrating`, `ready`, `stopping`, `stopped`, `failed`.
- Enforce per-user and global concurrency limits.
- Enforce per-command timeout (default 45s, hard max 120s on runner) and max output size (1MB).
- Idle shutdown of runner VMs via lifecycle reaper (10-minute idle timeout, checked every 60s).
- Persist work via runner-side `git add -u && git commit` and `git push` using credential helpers.
- If push fails due to branch protection, return explicit protected-branch error.
- Provide explicit `Pull` (fetch + rebase) and `Push` actions in the UI.
- No Gist endpoints or flows in sandbox UI.

## 9. Persistence Model (Git-Backed, Runner-Side)

- Source of truth is Git repo state, not VM disk snapshots.
- VM local disk is treated as disposable cache/working copy.
- Persistence flow:
  - On sandbox start: shallow clone (`--depth 1`) + checkout target branch on the runner VM.
  - Default checkout branch is the repository default branch (fetched from GitHub API).
- During session: detect changed tracked files via `git status --porcelain` on runner.
- On explicit user action (commit button):
  - `git add -u` (tracked files only — avoids committing secrets or generated files).
  - `git commit -m <message>` on the runner VM.
  - Commit author: constructed from GitHub OAuth profile on session (`githubLogin`, `githubName`, noreply email).
  - Record resulting HEAD SHA as `last_persisted_sha` in SQLite.
- On explicit user push:
  - `git push origin HEAD:<branch>` with credential helper (token via `SANDBOX_GIT_TOKEN` env var).
  - If ref update fails due to branch protection, surface a protected-branch error.
  - If rejected due to divergence, surface a "pull first" error.
- On VM stop or idle reap: VM is stopped/destroyed without auto-persist. Unsaved work is lost.
- Recovery flow:
  - If VM dies, recreate VM and restore by shallow cloning/fetching branch.
- Deliberately non-persistent in VM:
  - dependency caches (`node_modules`, package-manager caches)
  - build artifacts and temporary files
  - background process state and shell history

**Note:** The original plan called for persistence via the GitHub Git Data API (creating trees/blobs/commits server-side). The current implementation uses runner-side `git commit` + `git push` instead, which is simpler and more straightforward. The original plan also called for auto-persist on idle shutdown and graceful stop — this is not currently implemented; stop/idle-reap just kills the VM.

## 10. Fly Runner VM Design

### Architecture: API server ↔ Runner VM communication

The API server (single Fly machine, 256MB) and runner VMs are separate Fly machines:

- **Fly Machines API** (`https://api.machines.dev/v1/apps/{FLY_RUNNER_APP}/machines`) for provisioning/starting/stopping runner VMs. Authenticated via `FLY_API_TOKEN`.
- **Private networking** (Fly internal DNS / `<machine_id>.vm.<app>.internal:8080`) for API server → runner VM communication.
- **Runner VM agent process** — a lightweight Node.js HTTP server (`runner/agent.ts`) inside each runner VM that accepts commands from the API server and streams output back. Validates `Authorization: Bearer <RUNNER_AUTH_TOKEN>` on every request.
- **Runner VM Docker image** — separate Fly app (`FLY_RUNNER_APP`) with its own Dockerfile based on `node:22-slim` + `git`. Agent process bundled via esbuild at build time. Runs as non-root `runner` user.

### Runner agent endpoints

- `GET /health` — liveness check (used by `waitForRunner` polling loop).
- `POST /exec` — execute a shell command (`/bin/sh -c <command>`) in `/workspace`. Accepts `command`, `timeout_ms`, and optional `env` vars. Returns `CommandRunResult`.
- `POST /clone` — clone a repo into `/workspace` with `--depth 1`. Accepts `repo_url`, `branch`, `token`.
- `GET /git/status` — returns `branch`, `changedFiles`, `headSha` from the working tree.

### VM lifecycle

- One active runner VM per `(user_id, repo_full_name)`.
- States: `provisioning` → `hydrating` → `ready` → `stopping` → `stopped` (or `failed` on error).
- Activity heartbeats update `last_activity_at_ms` on each command.
- Idle reaper runs every 60s, stops VMs idle for >10 minutes.
- Failed provisions clean up the machine via `destroyRunnerMachine`.

### VM provisioning config

- CPU: shared, 1 vCPU, 512 MB memory.
- `auto_destroy: true` — Fly automatically cleans up stopped machines.
- Metadata tags: `sandbox_id`, `user_id`, `repo`.
- Env vars on runner: `RUNNER_AUTH_TOKEN`, `SANDBOX_ID`, `REPO_FULL_NAME`, `PORT`.

### Isolation

- Commands execute only inside runner VM, never on API host. The old `runtime.ts` (local `execFile`) has been fully removed.
- Runner VMs have no access to API host secrets, database, or session store.

### Connectivity

- API server brokers HTTP requests to runner agent via Fly private networking.
- WebSocket upgrade handler exists in `server/index.ts` for terminal streaming (`server.on('upgrade', ...)`), routing to `terminal_ws.ts`. The `ws` npm package is used.
- The frontend currently uses HTTP-based command execution, not the WebSocket terminal.

## 11. Resource Controls and Policies

### Implemented

- Repo eligibility cap from GitHub metadata: repository size ≤ 300 MB (`enforceRepoSize`).
- Max active runners per user: 2 (`enforceUserConcurrency`).
- Max active runners globally (staging): 8 (`enforceGlobalConcurrency`).
- Max command runtime per invocation: default 45s (`DEFAULT_COMMAND_TIMEOUT_MS`), hard max 120s on runner agent.
- Max stdout/stderr bytes: 1 MB per command (enforced by runner agent `maxBuffer`).
- HTTP command endpoint: max command string length 3,000 characters.
- Idle timeout: 10 minutes (`IDLE_TIMEOUT_MS`), reaper checks every 60s.

### Not yet implemented

- Hard max VM lifetime (TTL): 60 minutes — not enforced; a sandbox with continuous activity is never reaped.
- Single-flight command execution per repo session — HTTP `/command` endpoint has no concurrency guard (the WebSocket path has a basic `running` boolean, but no queue).
- Command queue: 1 running + up to 2 queued, reject additional — not implemented.
- Checked-out workspace hard cap: 500 MB on disk — not implemented (only the 300MB repo-size metadata check exists).
- Optional safety cap: ≤ 75,000 files in working tree — not implemented.
- Circuit-breaker fallback when Fly capacity/API limits are reached — not implemented.

## 12. System Architecture

### Backend (`server/sandboxes/`)

- `router.ts` — all HTTP endpoint handlers and routing dispatch for `/api/sandboxes/*`.
- `fly_runtime.ts` — Fly Machines API client for runner VM provisioning/teardown. HTTP bridge for running commands, cloning repos, and getting git status on runner VMs.
- `store.ts` — SQLite metadata persistence. Schema: `sandbox_sessions` table with `id`, `user_id`, `repo_full_name`, `branch`, `base_commit_sha`, `last_persisted_sha`, `fly_machine_id`, `state`, timestamps. Indexed by `(user_id, repo_full_name)` and `state`.
- `lifecycle.ts` — idle reaper. Runs on API server via `setInterval`, polls for idle sandboxes and stops/destroys their VMs.
- `limits.ts` — policy enforcement constants and check functions (repo size, concurrency, timeout).
- `repo_sync.ts` — GitHub API helpers: verify installation repo access, get repo default branch/size, mint installation tokens, build clone URLs.
- `terminal_ws.ts` — WebSocket upgrade handler for terminal streaming. Server-side implementation exists; frontend client does not.
- `auth.ts` — session check and rate limiting delegation.
- `keys.ts` — AES-256-GCM encrypted user API key storage (`sandboxes_user_keys` table).
- `composer.ts` + `providers/openai.ts` — OpenAI-based compose flow for generating command plans from prompts. Adapted to receive repo context (repo name + branch) instead of workspace name.
- `db.ts` — shared SQLite database singleton (reuses `DATABASE_PATH`).
- `types.ts` — `SandboxState`, `SandboxRecord`, `CommandRunResult`, `ComposeResult`, `SandboxProviderId`.

### Frontend (`src/sandboxes/`)

- `App.tsx` — single-component sandbox UI. Parses `:owner/:repo` from URL. Panels: runtime control, API key management, compose, terminal (HTTP-based), git status/commit/push/pull.
- `api.ts` — fetch wrappers for all repo-scoped endpoints.
- `types.ts` — client-side type mirrors (excludes internal fields like `flyMachineId`).
- `styles.css` — sandbox-specific styles (currently imported globally in `src/main.tsx`).

### Runner (`runner/`)

- `agent.ts` — lightweight Node.js HTTP server. Endpoints: `/health`, `/exec`, `/clone`, `/git/status`. Runs as non-root user. Validates `RUNNER_AUTH_TOKEN` on every request.
- `Dockerfile` — multi-stage build: esbuild in `node:22-slim`, final image with `git` installed, non-root `runner` user.
- `fly.toml` — template documenting the runner app config (VMs are provisioned via Machines API, not `fly deploy`).

### Server infrastructure

- `server/index.ts` — WebSocket upgrade handler (`server.on('upgrade', ...)`) routes to `terminal_ws.ts`.
- `server/routes.ts` — `handleSandboxesApiRequest` integrated into main request handler.
- `server/config.ts` — exports `FLY_API_TOKEN`, `FLY_RUNNER_APP`, `RUNNER_AUTH_TOKEN`, `SANDBOXES_KEY_ENCRYPTION_SECRET`.
- `src/main.tsx` — sandbox SPA entry point mounted on `/sandboxes/*` paths.
- `src/routing.ts` — `'sandboxes'` in `RESERVED_ROOT_SEGMENTS` (sandbox app mounted outside normal router).
- `src/views/WorkspacesView.tsx` — "Sandbox" button on repo cards navigates to `/sandboxes/:owner/:repo`.

### npm dependencies

- `ws` — WebSocket server for terminal streaming.

## 13. API Surface

### Repo-scoped endpoints (new)

- `POST /api/sandboxes/repos/:owner/:repo/runtime/start` — provision runner VM, clone repo, return sandbox record.
- `POST /api/sandboxes/repos/:owner/:repo/runtime/stop` — stop runner VM.
- `GET  /api/sandboxes/repos/:owner/:repo/runtime/status` — return current sandbox state.
- `POST /api/sandboxes/repos/:owner/:repo/command` — execute shell command on runner via HTTP.
- `GET  /api/sandboxes/repos/:owner/:repo/git/status` — return git working tree status from runner.
- `POST /api/sandboxes/repos/:owner/:repo/git/commit` — `git add -u && git commit` on runner.
- `POST /api/sandboxes/repos/:owner/:repo/git/push` — `git push` on runner with credential helper.
- `POST /api/sandboxes/repos/:owner/:repo/git/pull` — `git fetch && git rebase` on runner with credential helper.
- `POST /api/sandboxes/repos/:owner/:repo/compose` — generate command plan from prompt via OpenAI.
- `WS   /api/sandboxes/repos/:owner/:repo/terminal` — WebSocket terminal (server-side only; frontend not connected).

### Preserved endpoints (unchanged)

- `GET  /api/sandboxes/session` — authenticated session details + composer capabilities + key status.
- `GET  /api/sandboxes/health` — public health check + capabilities.
- `GET  /api/sandboxes/key-status` — API key configuration status.
- `POST /api/sandboxes/key` — store/rotate API key.
- `DELETE /api/sandboxes/key` — delete API key.

### Removed endpoints

- All `/api/sandboxes/workspaces/*` routes (list, create, get, patch, delete, compose, command).

### Auth flow for repo endpoints

Each repo endpoint:
1. Validates session via `requireSandboxesSession`.
2. Resolves installation ID: `session.installationId ?? getRememberedInstallationForUser(session.githubUserId)`. Returns 403 with connect-app guidance if null.
3. Verifies the installation has access to the requested `owner/repo` via `githubFetchWithInstallationToken` (`GET /repos/:owner/:repo`).
4. Mints a scoped installation token for clone/push/pull operations.

## 14. Security and Compliance

### Implemented

- AuthN/AuthZ reuse existing session + installation checks.
- Repo access validated against current installation permissions on every repo-scoped request.
- Sandbox commands never execute on API host — `runtime.ts` fully removed.
- Runner VM runs as non-root `runner` user (Dockerfile `USER runner`).
- Runner VM minimal environment: only `RUNNER_AUTH_TOKEN`, `PORT`, `SANDBOX_ID`, `REPO_FULL_NAME`.
- User Codex key encrypted at rest server-side (AES-256-GCM via `keys.ts`).
- Clone/push/pull all use credential helper with token via env var (`SANDBOX_GIT_TOKEN`) — token never appears in URLs, process args, or git remote config.
- Command injection mitigation: commands forwarded as opaque strings to runner agent, executed via `/bin/sh -c`.

### Known gaps

- **Read-only root filesystem** not configured on runner VMs (Dockerfile and Fly machine config do not set this).
- **Linux capabilities not dropped** and `no-new-privileges` not set.
- **Terminal WebSocket** has no rate limiting or command length validation (HTTP endpoint enforces both).
- **Audit logging** — only basic `console.log`/`console.error`. No structured audit logging for lifecycle events or git write operations.

## 15. Observability and Metrics

### Not yet implemented

- Product metrics: sandbox starts/day, median start-to-ready latency, command success rate, commit/push success rate, average session duration.
- Reliability metrics: VM provision failures, idle cleanup success, terminal disconnect/reconnect rates, API error rate by endpoint.
- Cost metrics: VM runtime minutes by user/repo, abandoned idle runtime minutes.

Currently only `console.log` / `console.error` logging exists.

## 16. Rollout Plan

- ~~Phase 0: Remove local command execution from API host (`runtime.ts` `execFile` path).~~ Done.
- ~~Phase 1: Repo sandbox routing and My Repos `Sandbox` button. Repo-scoped session/auth validation. SQLite schema migration.~~ Done.
- ~~Phase 2: Fly runner VM provisioning + runner agent process + HTTP command execution endpoint + basic limits.~~ Done.
- Phase 3: WebSocket terminal streaming (server-side handler exists, frontend client needed). Command queue and single-flight enforcement.
- Phase 4: Hard TTL enforcement, circuit-breaker, runtime disk/file limits, runner security hardening (read-only root FS, capability dropping, clone credential helper).
- Phase 5: Observability expansion, structured audit logging, retries/failure drills, and production tuning.

## 17. Acceptance Criteria

- [x] User can click `Sandbox` from My Repos and land on `/sandboxes/:owner/:repo`.
- [x] Commands run in Fly runner VM and return output in UI.
- [x] No sandbox command execution occurs on API host (local `execFile` path fully removed).
- [ ] Command execution is single-flight per repo session with bounded queue behavior.
- [x] Repo changes can be committed and pushed via UI actions.
- [x] Protected-branch push failures produce explicit error.
- [x] Repo size checked against 300 MB cap before provisioning.
- [ ] Checked-out workspace hard cap (500 MB) enforced at runtime.
- [ ] Idle runner cleanup persists work before stopping (currently does not auto-persist).
- [x] Gist-based sandbox flow is absent.
- [x] Old workspace-based sandbox endpoints are removed.

## 18. Risks and Mitigations

- **Fly provisioning latency affects UX.**
  - Mitigation: progressive loading states in UI (`provisioning` → `hydrating` → `ready`).
- **Git push conflicts from parallel editors.**
  - Mitigation: explicit pull/rebase UX and divergence error messaging.
- **Cost growth from long-lived idle VMs.**
  - Mitigation: idle timeout (10 min) + auto-destroy on Fly. Hard TTL not yet enforced.
- **Runner VM agent is a new component.**
  - Mitigation: kept minimal (HTTP + exec, ~200 lines).
- **SQLite on single Fly volume is a SPOF for state tracking.**
  - Mitigation: acceptable for current scale. State is metadata-only; actual data is in GitHub. VM loss just means re-hydrate from git.
- **Unsaved work lost on idle reap or manual stop.**
  - Mitigation: none currently. Auto-persist before stop is a future improvement.
- **Clone URL leaks token on runner.**
  - Mitigation: runner is isolated; push/pull already use credential helper. Migrate clone to credential helper too.

## 19. Outstanding TODOs

- [ ] **Circuit-breaker fallback.** When Fly capacity/API limits are reached, return a "sandbox unavailable" state instead of letting provision calls fail with opaque 502s. Track consecutive failures and short-circuit for a cooldown period.
- [ ] **Hard TTL enforcement.** The idle reaper only checks for idle sandboxes. Add a check for sandboxes that exceed a 60-minute hard TTL regardless of activity.
- [ ] **Command queue.** Enforce single-flight command execution per repo session (1 running + up to 2 queued, reject additional). Currently the HTTP `/command` endpoint has no concurrency guard, and the WebSocket path has only a basic `running` boolean with no queue.
- [ ] **Set `baseCommitSha` on sandbox creation.** The `base_commit_sha` column exists in `sandbox_sessions` but is always `null`. After clone, populate it from the runner's HEAD so commit/push can detect divergence.
- [ ] **Runner agent: handle pre-existing `/workspace`.** `git clone` into a non-empty directory fails. The `/clone` endpoint should clean or check the directory first to support recovery (re-clone after VM restart).
- [ ] **Frontend WebSocket terminal client.** The WS upgrade handler and `terminal_ws.ts` exist server-side, but `App.tsx` still uses HTTP `runSandboxCommand`. Build a WS client that connects to `/api/sandboxes/repos/:owner/:repo/terminal` for interactive streaming.
- [x] **Clone credential helper.** Push/pull use a credential helper to avoid embedding tokens in URLs. Clone now also uses the same credential helper approach — token passed via `SANDBOX_GIT_TOKEN` env var.
- [ ] **Terminal WebSocket rate limiting and command length validation.** The HTTP `/command` endpoint enforces rate limits and a 3KB command length cap. The WebSocket path has neither.
- [ ] **`handleRuntimeStop` error recovery.** If `stopRunnerMachine` throws, the sandbox is stuck in `'stopping'` state permanently. Add try/catch with fallback to `'failed'` state and machine destroy, matching the lifecycle reaper's pattern.
- [ ] **Auto-persist before stop/idle-reap.** The plan originally called for persisting on idle shutdown and graceful stop. Currently stop/reap just kills the VM. Consider auto-committing dirty state before teardown.
- [ ] **Runner VM hardening.** Read-only root filesystem, drop Linux capabilities, set no-new-privileges. Not configured in Dockerfile or Fly machine config.
- [ ] **Runtime disk and file count limits.** Only the 300MB repo-size metadata check exists. No runtime check of actual disk usage (500MB cap) or file count (75K cap) on the runner.
- [ ] **Structured audit logging and metrics.** Only `console.log`/`console.error` exists. Need structured logging for lifecycle events, git writes, and operational metrics.
- [x] **Compose branch fallback.** When no sandbox is running, compose now fetches the repo's actual default branch from GitHub API instead of defaulting to `'main'`.

## 20. Engineering Task Plan

### Done

- **Task A: Routing + navigation integration.** Route handling for `/sandboxes/:owner/:repo` (frontend path parsing in `App.tsx`). `Sandbox` button in My Repos cards. Old workspace routes removed.
- **Task B: Backend repo-scoped runtime APIs + auth.** New router under `/api/sandboxes/repos/:owner/:repo/*`. Installation permission validation. SQLite schema: `sandbox_sessions` table. Old workspace CRUD removed.
- **Task C: Runner VM agent + Fly lifecycle adapter.** Runner agent (`runner/agent.ts`): HTTP server with `/health`, `/exec`, `/clone`, `/git/status`. Dockerfile (`node:22-slim` + `git`, non-root user) and `fly.toml`. `fly_runtime.ts`: Fly Machines API client for provision/start/stop/destroy + command/clone/git-status bridge. Idle reaper in `lifecycle.ts`.
- **Task E (partial): Git persistence APIs + UX.** Runner-side `git add -u && git commit && git push` via credential helper. Git status panel, commit/push/pull actions. Protected-branch and divergence error handling.

### Remaining

- **Task D: WebSocket terminal client.** Server-side `terminal_ws.ts` exists. Need frontend WebSocket client in `src/sandboxes/` to replace HTTP-based `runSandboxCommand`.
- **Task E (remaining): Git enhancements.** Populate `baseCommitSha` after clone. Auto-persist before stop/idle-reap. Clone credential helper migration.
- **Task F: Limits + hardening.** Hard TTL enforcement. Command queue / single-flight. Runtime disk/file count limits. Circuit-breaker. Runner VM security hardening (read-only root FS, capability dropping).
- **Task G: Observability + cleanup.** Structured audit logging. Metrics collection. `handleRuntimeStop` error recovery. Terminal WS rate limiting. Compose branch fallback fix.

## 21. Dependencies

- Fly Machines API credentials: `FLY_API_TOKEN` env var (in `server/config.ts` and `.env.example`).
- Fly runner app name: `FLY_RUNNER_APP` env var (the separate Fly app that hosts runner VMs).
- Runner auth shared secret: `RUNNER_AUTH_TOKEN` env var (set on both API server and runner VMs).
- Runner VM Docker image (`node:22-slim` + `git`) and deployment pipeline (separate Dockerfile, separate `fly.toml`, independent `fly deploy`).
- `ws` npm package for WebSocket support.
- Existing GitHub App installation token flows in `server/github_client.ts` (`githubFetchWithInstallationToken`, `createAppJwt`).
- Existing auth/session middleware (`server/session.ts`: `getSession`, `getRememberedInstallationForUser`).
- Existing rate limiting (`server/rate_limit.ts`).
- Key encryption secret: `SANDBOXES_KEY_ENCRYPTION_SECRET` env var (for AES-256-GCM key storage).
