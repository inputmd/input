import { FLY_API_TOKEN, FLY_RUNNER_APP, RUNNER_AUTH_TOKEN } from '../config';
import { ClientError } from '../errors';
import type { CommandRunResult } from './types';

const FLY_API_BASE = 'https://api.machines.dev/v1';

function flyHeaders(): Record<string, string> {
  if (!FLY_API_TOKEN) throw new ClientError('Sandbox runtime is not configured', 503);
  return {
    Authorization: `Bearer ${FLY_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function runnerApp(): string {
  if (!FLY_RUNNER_APP) throw new ClientError('Sandbox runtime is not configured', 503);
  return FLY_RUNNER_APP;
}

export interface FlyMachineInfo {
  id: string;
  state: string;
  private_ip?: string;
}

export async function provisionRunnerMachine(metadata: {
  userId: number;
  repoFullName: string;
  sandboxId: string;
}): Promise<FlyMachineInfo> {
  const app = runnerApp();
  const res = await fetch(`${FLY_API_BASE}/apps/${encodeURIComponent(app)}/machines`, {
    method: 'POST',
    headers: flyHeaders(),
    body: JSON.stringify({
      config: {
        image: `registry.fly.io/${app}:latest`,
        env: {
          RUNNER_AUTH_TOKEN,
          SANDBOX_ID: metadata.sandboxId,
          REPO_FULL_NAME: metadata.repoFullName,
        },
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
        auto_destroy: true,
        metadata: {
          sandbox_id: metadata.sandboxId,
          user_id: String(metadata.userId),
          repo: metadata.repoFullName,
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[fly] Failed to provision machine: ${res.status} ${text}`);
    throw new ClientError('Failed to provision sandbox runtime', 502);
  }

  return (await res.json()) as FlyMachineInfo;
}

export async function stopRunnerMachine(machineId: string): Promise<void> {
  const app = runnerApp();
  const res = await fetch(
    `${FLY_API_BASE}/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/stop`,
    { method: 'POST', headers: flyHeaders(), signal: AbortSignal.timeout(15_000) },
  );
  // 404 means the machine is already gone — treat as success
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    console.error(`[fly] Failed to stop machine ${machineId}: ${res.status} ${text}`);
    throw new ClientError(`Failed to stop runner machine (${res.status})`, 502);
  }
}

export async function destroyRunnerMachine(machineId: string): Promise<void> {
  const app = runnerApp();
  const res = await fetch(
    `${FLY_API_BASE}/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}?force=true`,
    { method: 'DELETE', headers: flyHeaders(), signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    console.error(`[fly] Failed to destroy machine ${machineId}: ${res.status} ${text}`);
  }
}

function runnerBaseUrl(machineId: string): string {
  const app = runnerApp();
  return `http://${machineId}.vm.${app}.internal:8080`;
}

function runnerHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${RUNNER_AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function waitForRunner(machineId: string, maxWaitMs = 30_000): Promise<void> {
  const url = `${runnerBaseUrl(machineId)}/health`;
  const deadline = Date.now() + maxWaitMs;
  const interval = 1_000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new ClientError('Runner VM did not become ready in time', 504);
}

export async function runCommandOnRunner(
  machineId: string,
  command: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<CommandRunResult> {
  return runOnRunner(machineId, { command, timeout_ms: timeoutMs, env });
}

/**
 * Execute a command on the runner using an argv array (no shell interpretation).
 * Preferred over `runCommandOnRunner` to avoid shell injection.
 */
export async function runArgvOnRunner(
  machineId: string,
  argv: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<CommandRunResult> {
  return runOnRunner(machineId, { argv, timeout_ms: timeoutMs, env });
}

async function runOnRunner(
  machineId: string,
  payload: Record<string, unknown>,
): Promise<CommandRunResult> {
  const timeoutMs = (payload.timeout_ms as number) ?? 45_000;
  const url = `${runnerBaseUrl(machineId)}/exec`;
  const res = await fetch(url, {
    method: 'POST',
    headers: runnerHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs + 10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ClientError(`Runner command failed (${res.status}): ${text || 'unknown error'}`, 502);
  }

  return (await res.json()) as CommandRunResult;
}

export async function writeFileOnRunner(
  machineId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const url = `${runnerBaseUrl(machineId)}/write`;
  const res = await fetch(url, {
    method: 'POST',
    headers: runnerHeaders(),
    body: JSON.stringify({ path: filePath, content }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ClientError(`Failed to write file on runner: ${text || 'unknown error'}`, 502);
  }
}

export async function cloneRepoOnRunner(
  machineId: string,
  repoUrl: string,
  branch: string,
  token: string,
): Promise<void> {
  const url = `${runnerBaseUrl(machineId)}/clone`;
  const res = await fetch(url, {
    method: 'POST',
    headers: runnerHeaders(),
    body: JSON.stringify({ repo_url: repoUrl, branch, token, use_credential_helper: true }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ClientError(`Failed to clone repository: ${text || 'unknown error'}`, 502);
  }
}

export async function runGitCommandOnRunner(
  machineId: string,
  gitArgs: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runArgvOnRunner(machineId, ['git', ...gitArgs], 30_000, env);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/**
 * Run a git command that needs repo authentication (push/pull/fetch).
 * The token is passed via process environment and a credential helper reads it,
 * so it never appears in command strings, process args, or git remote URLs.
 */
export async function runAuthenticatedGitCommandOnRunner(
  machineId: string,
  gitArgs: string[],
  token: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const credentialHelper = '!f() { echo "username=x-access-token"; echo "password=$SANDBOX_GIT_TOKEN"; }; f';
  const fullArgs = ['-c', `credential.helper=${credentialHelper}`, ...gitArgs];
  return runGitCommandOnRunner(machineId, fullArgs, { SANDBOX_GIT_TOKEN: token });
}

export async function getRunnerGitStatus(machineId: string): Promise<{
  branch: string;
  changedFiles: string[];
  headSha: string;
}> {
  const url = `${runnerBaseUrl(machineId)}/git/status`;
  const res = await fetch(url, {
    headers: runnerHeaders(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ClientError(`Failed to get git status: ${text || 'unknown error'}`, 502);
  }

  return (await res.json()) as { branch: string; changedFiles: string[]; headSha: string };
}
