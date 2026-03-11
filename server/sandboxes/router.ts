import type http from 'node:http';
import { ClientError } from '../errors';
import { json, readJson } from '../http_helpers';

/**
 * Reject non-JSON POST/PUT/PATCH/DELETE requests to prevent CSRF via simple
 * form submissions or `navigator.sendBeacon`.  Browsers will not send
 * `Content-Type: application/json` cross-origin without a CORS preflight,
 * so requiring it effectively blocks cross-site forged requests.
 */
function requireJsonContentType(req: http.IncomingMessage): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  // DELETE with no body is OK (e.g. key deletion) — only enforce when a body is expected
  if (req.method === 'DELETE' && !req.headers['content-length'] && req.headers['transfer-encoding'] === undefined) {
    return;
  }
  const ct = req.headers['content-type'] ?? '';
  if (!ct.startsWith('application/json')) {
    throw new ClientError('Content-Type must be application/json', 415);
  }
}
import { getRememberedInstallationForUser } from '../session';
import { checkSandboxesRateLimit, requireSandboxesSession } from './auth';
import { runAgent } from './agent';
import {
  cloneRepoOnRunner,
  destroyRunnerMachine,
  getRunnerGitStatus,
  provisionRunnerMachine,
  runAuthenticatedGitCommandOnRunner,
  runCommandOnRunner,
  runGitCommandOnRunner,
  stopRunnerMachine,
  waitForRunner,
} from './fly_runtime';
import {
  clearSandboxesUserApiKey,
  getSandboxesUserApiKey,
  sandboxesUserApiKeyStatus,
  setSandboxesUserApiKey,
} from './keys';
import { DEFAULT_COMMAND_TIMEOUT_MS, enforceRepoSize } from './limits';
import {
  buildCloneUrl,
  getInstallationTokenForClone,
  getRepoDefaultBranch,
  verifyInstallationRepoAccess,
} from './repo_sync';
import {
  createSandboxSession,
  getSandboxByUserRepo,
  setSandboxMachineId,
  setSandboxPersistedSha,
  touchSandboxActivity,
  updateSandboxState,
} from './store';
import type { SandboxesSession } from './types';

function resolveInstallationId(session: SandboxesSession): string {
  const id = session.installationId ?? getRememberedInstallationForUser(session.githubUserId);
  if (!id) {
    throw new ClientError(
      'No GitHub App installation found. Connect a GitHub App installation from My Repos first.',
      403,
    );
  }
  return id;
}

function sanitizeSandboxForClient(sandbox: import('./types').SandboxRecord) {
  const { flyMachineId: _, ...rest } = sandbox;
  return rest;
}

function parseRepoPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = pathname.match(/^\/api\/sandboxes\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], rest: match[3] ?? '' };
}

// --- Session/key/health endpoints (unchanged) ---

async function handleSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  json(res, 200, {
    authenticated: true,
    user: {
      id: session.githubUserId,
      login: session.githubLogin,
      avatar_url: session.githubAvatarUrl,
      name: session.githubName,
    },
    key: sandboxesUserApiKeyStatus(session.githubUserId),
  });
}

async function handleKeyStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;
  json(res, 200, sandboxesUserApiKeyStatus(session.githubUserId));
}

async function handleSetKey(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;
  const body = await readJson(req);
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : '';
  setSandboxesUserApiKey(session.githubUserId, apiKey);
  json(res, 200, sandboxesUserApiKeyStatus(session.githubUserId));
}

async function handleDeleteKey(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;
  clearSandboxesUserApiKey(session.githubUserId);
  json(res, 200, sandboxesUserApiKeyStatus(session.githubUserId));
}

// --- Repo-scoped endpoints ---

async function handleRuntimeStart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const installationId = resolveInstallationId(session);
  const repoFullName = `${owner}/${repo}`;

  // Check if already running
  const existing = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (existing && existing.state !== 'stopped' && existing.state !== 'failed') {
    json(res, 200, { sandbox: sanitizeSandboxForClient(existing), alreadyRunning: true });
    return;
  }

  // Verify access and get repo info
  const hasAccess = await verifyInstallationRepoAccess(installationId, owner, repo);
  if (!hasAccess) {
    throw new ClientError('Repository not accessible via your GitHub App installation.', 403);
  }

  const { defaultBranch, sizeKb } = await getRepoDefaultBranch(installationId, owner, repo);
  enforceRepoSize(sizeKb);

  // Concurrency caps are enforced atomically inside createSandboxSession
  // (same synchronous block as the insert, so no race is possible).
  const sandbox = createSandboxSession(session.githubUserId, repoFullName, defaultBranch);
  if (!sandbox) {
    // Another request created a sandbox between our initial check and here
    const current = getSandboxByUserRepo(session.githubUserId, repoFullName);
    json(res, 200, { sandbox: current ? sanitizeSandboxForClient(current) : null, alreadyRunning: true });
    return;
  }

  // Provision Fly runner
  let machineId: string | null = null;
  try {
    const machine = await provisionRunnerMachine({
      userId: session.githubUserId,
      repoFullName,
      sandboxId: sandbox.id,
    });
    machineId = machine.id;
    setSandboxMachineId(sandbox.id, machineId);

    // Wait for the runner agent to be reachable
    await waitForRunner(machineId);
    updateSandboxState(sandbox.id, 'hydrating');

    // Clone repo onto runner
    const token = await getInstallationTokenForClone(installationId);
    const cloneUrl = buildCloneUrl(owner, repo);
    await cloneRepoOnRunner(machineId, cloneUrl, defaultBranch, token);

    updateSandboxState(sandbox.id, 'ready');
    touchSandboxActivity(sandbox.id);

    const updated = getSandboxByUserRepo(session.githubUserId, repoFullName);
    json(res, 201, { sandbox: updated ? sanitizeSandboxForClient(updated) : null });
  } catch (err) {
    updateSandboxState(sandbox.id, 'failed');
    if (machineId) {
      destroyRunnerMachine(machineId).catch((e) => {
        console.error(`[sandboxes] Failed to clean up machine after start failure:`, e);
      });
    }
    throw err;
  }
}

async function handleRuntimeStop(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox) {
    json(res, 404, { error: 'No active sandbox for this repository' });
    return;
  }

  updateSandboxState(sandbox.id, 'stopping');
  try {
    if (sandbox.flyMachineId) {
      await stopRunnerMachine(sandbox.flyMachineId);
    }
    updateSandboxState(sandbox.id, 'stopped');
  } catch (err) {
    console.error(`[sandboxes] stopRunnerMachine failed for sandbox ${sandbox.id}:`, err);
    updateSandboxState(sandbox.id, 'failed');
    if (sandbox.flyMachineId) {
      destroyRunnerMachine(sandbox.flyMachineId).catch((e) => {
        console.error(`[sandboxes] Failed to destroy machine after stop failure:`, e);
      });
    }
    throw new ClientError('Failed to stop sandbox runtime', 502);
  }

  json(res, 200, { ok: true });
}

async function handleRuntimeStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox) {
    json(res, 200, { sandbox: null });
    return;
  }

  json(res, 200, { sandbox: sanitizeSandboxForClient(sandbox) });
}

async function handleCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox || sandbox.state !== 'ready') {
    throw new ClientError('Sandbox is not running', 409);
  }
  if (!sandbox.flyMachineId) {
    throw new ClientError('Sandbox has no runner machine', 500);
  }

  const body = await readJson(req);
  const command = typeof body?.command === 'string' ? body.command.trim() : '';
  if (!command) throw new ClientError('command is required', 400);
  if (command.length > 3_000) throw new ClientError('command is too long', 400);

  touchSandboxActivity(sandbox.id);
  const result = await runCommandOnRunner(sandbox.flyMachineId, command, DEFAULT_COMMAND_TIMEOUT_MS);
  touchSandboxActivity(sandbox.id);

  json(res, 200, { result });
}

async function handleGitStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox || !sandbox.flyMachineId || sandbox.state !== 'ready') {
    throw new ClientError('Sandbox is not running', 409);
  }

  const status = await getRunnerGitStatus(sandbox.flyMachineId);
  json(res, 200, { ...status, sandbox: { id: sandbox.id, state: sandbox.state, branch: sandbox.branch } });
}

async function handleGitCommit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox || !sandbox.flyMachineId || sandbox.state !== 'ready') {
    throw new ClientError('Sandbox is not running', 409);
  }

  const body = await readJson(req);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) throw new ClientError('commit message is required', 400);

  // Configure author identity on the runner
  const authorName = session.githubName || session.githubLogin;
  const authorEmail = `${session.githubUserId}+${session.githubLogin}@users.noreply.github.com`;
  await runGitCommandOnRunner(sandbox.flyMachineId, ['config', 'user.name', authorName]);
  await runGitCommandOnRunner(sandbox.flyMachineId, ['config', 'user.email', authorEmail]);

  // Stage tracked files only — avoids accidentally committing secrets or
  // generated files (e.g. .env, node_modules) written by commands.
  // Users can explicitly `git add <file>` via the terminal for new files.
  await runGitCommandOnRunner(sandbox.flyMachineId, ['add', '-u']);
  const commitResult = await runGitCommandOnRunner(sandbox.flyMachineId, ['commit', '-m', message]);
  if (commitResult.exitCode !== 0) {
    // exit code 1 with "nothing to commit" is not an error
    if (/nothing to commit/i.test(commitResult.stdout + commitResult.stderr)) {
      throw new ClientError('Nothing to commit — working tree is clean.', 400);
    }
    throw new ClientError(`Commit failed: ${commitResult.stderr}`, 500);
  }

  // Get the new HEAD sha
  const revParse = await runGitCommandOnRunner(sandbox.flyMachineId, ['rev-parse', 'HEAD']);
  const commitSha = revParse.stdout.trim();

  setSandboxPersistedSha(sandbox.id, commitSha);
  touchSandboxActivity(sandbox.id);

  json(res, 200, { commitSha });
}

async function handleGitPush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox || !sandbox.flyMachineId || sandbox.state !== 'ready') {
    throw new ClientError('Sandbox is not running', 409);
  }

  // Push using credential helper — token is passed via env var, never in URLs or command args
  const installationId = resolveInstallationId(session);
  const token = await getInstallationTokenForClone(installationId);

  // Ensure remote URL is clean (no embedded credentials)
  const cleanUrl = buildCloneUrl(owner, repo);
  await runGitCommandOnRunner(sandbox.flyMachineId, ['remote', 'set-url', 'origin', cleanUrl]);

  const pushResult = await runAuthenticatedGitCommandOnRunner(
    sandbox.flyMachineId,
    ['push', 'origin', `HEAD:${sandbox.branch}`],
    token,
  );
  if (pushResult.exitCode !== 0) {
    const stderr = pushResult.stderr;
    if (/protected branch/i.test(stderr)) {
      throw new ClientError('Push rejected — branch is protected.', 409);
    }
    if (/rejected|non-fast-forward/i.test(stderr)) {
      throw new ClientError('Push rejected — branch has diverged. Pull and resolve conflicts first.', 409);
    }
    throw new ClientError(`Push failed: ${stderr}`, 502);
  }

  // Record the pushed SHA
  const revParse = await runGitCommandOnRunner(sandbox.flyMachineId, ['rev-parse', 'HEAD']);
  const sha = revParse.stdout.trim();
  setSandboxPersistedSha(sandbox.id, sha);
  touchSandboxActivity(sandbox.id);

  json(res, 200, { ok: true, sha });
}

async function handleGitPull(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox || !sandbox.flyMachineId || sandbox.state !== 'ready') {
    throw new ClientError('Sandbox is not running', 409);
  }

  // Fetch using credential helper — token is passed via env var, never in URLs or command args
  const installationId = resolveInstallationId(session);
  const token = await getInstallationTokenForClone(installationId);

  // Ensure remote URL is clean (no embedded credentials)
  const cleanUrl = buildCloneUrl(owner, repo);
  await runGitCommandOnRunner(sandbox.flyMachineId, ['remote', 'set-url', 'origin', cleanUrl]);

  const fetchResult = await runAuthenticatedGitCommandOnRunner(
    sandbox.flyMachineId,
    ['fetch', 'origin', sandbox.branch],
    token,
  );
  if (fetchResult.exitCode !== 0) {
    throw new ClientError(`Fetch failed: ${fetchResult.stderr}`, 502);
  }

  const rebaseResult = await runGitCommandOnRunner(sandbox.flyMachineId, ['rebase', `origin/${sandbox.branch}`]);
  if (rebaseResult.exitCode !== 0) {
    // Abort rebase on conflict
    await runGitCommandOnRunner(sandbox.flyMachineId, ['rebase', '--abort']);
    throw new ClientError(
      `Rebase failed due to conflicts. Changes have been preserved. Resolve manually or reset.`,
      409,
    );
  }

  touchSandboxActivity(sandbox.id);
  json(res, 200, { ok: true });
}

async function handleAgentRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repo: string,
): Promise<void> {
  const session = requireSandboxesSession(req, res);
  if (!session) return;
  if (!checkSandboxesRateLimit(req, res, session)) return;

  const repoFullName = `${owner}/${repo}`;
  const sandbox = getSandboxByUserRepo(session.githubUserId, repoFullName);
  if (!sandbox || !sandbox.flyMachineId || sandbox.state !== 'ready') {
    throw new ClientError('Sandbox is not running', 409);
  }

  const body = await readJson(req);
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new ClientError('prompt is required', 400);
  if (prompt.length > 20_000) throw new ClientError('prompt is too long', 400);

  const model = typeof body?.model === 'string' ? body.model : undefined;
  const apiKey = getSandboxesUserApiKey(session.githubUserId);
  if (!apiKey) throw new ClientError('API key required. Set your key in settings.', 428);

  touchSandboxActivity(sandbox.id);

  const result = await runAgent({
    machineId: sandbox.flyMachineId,
    repoFullName,
    branch: sandbox.branch,
    prompt,
    model,
    apiKey,
  });

  touchSandboxActivity(sandbox.id);
  json(res, 200, { result });
}

// --- Router ---

export async function handleSandboxesApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _url: URL,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/sandboxes')) return false;

  try {
    // CSRF protection: require application/json on mutating requests
    requireJsonContentType(req);

    // Global endpoints
    if (pathname === '/api/sandboxes/health' && req.method === 'GET') {
      if (!checkSandboxesRateLimit(req, res, null)) return true;
      json(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/sandboxes/session' && req.method === 'GET') {
      await handleSession(req, res);
      return true;
    }

    if (pathname === '/api/sandboxes/key-status' && req.method === 'GET') {
      await handleKeyStatus(req, res);
      return true;
    }

    if (pathname === '/api/sandboxes/key' && req.method === 'POST') {
      await handleSetKey(req, res);
      return true;
    }

    if (pathname === '/api/sandboxes/key' && req.method === 'DELETE') {
      await handleDeleteKey(req, res);
      return true;
    }

    // Repo-scoped endpoints
    const repoParts = parseRepoPath(pathname);
    if (repoParts) {
      const { owner, repo, rest } = repoParts;

      if (rest === 'runtime/start' && req.method === 'POST') {
        await handleRuntimeStart(req, res, owner, repo);
        return true;
      }
      if (rest === 'runtime/stop' && req.method === 'POST') {
        await handleRuntimeStop(req, res, owner, repo);
        return true;
      }
      if (rest === 'runtime/status' && req.method === 'GET') {
        await handleRuntimeStatus(req, res, owner, repo);
        return true;
      }
      if (rest === 'command' && req.method === 'POST') {
        await handleCommand(req, res, owner, repo);
        return true;
      }
      if (rest === 'git/status' && req.method === 'GET') {
        await handleGitStatus(req, res, owner, repo);
        return true;
      }
      if (rest === 'git/commit' && req.method === 'POST') {
        await handleGitCommit(req, res, owner, repo);
        return true;
      }
      if (rest === 'git/push' && req.method === 'POST') {
        await handleGitPush(req, res, owner, repo);
        return true;
      }
      if (rest === 'git/pull' && req.method === 'POST') {
        await handleGitPull(req, res, owner, repo);
        return true;
      }
      if (rest === 'agent/run' && req.method === 'POST') {
        await handleAgentRun(req, res, owner, repo);
        return true;
      }

      json(res, 404, { error: 'Not found' });
      return true;
    }

    json(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) res.end();
      return true;
    }
    if (err instanceof ClientError) {
      json(res, err.statusCode, { error: err.message });
      return true;
    }

    console.error('[sandboxes] Unhandled error', err);
    json(res, 500, { error: 'Internal server error' });
    return true;
  }
}
