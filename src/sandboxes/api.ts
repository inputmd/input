import { ApiError } from '../api_error';
import type {
  AgentResult,
  CommandRunResult,
  GitStatusResult,
  SandboxesKeyStatus,
  SandboxesSessionResponse,
  SandboxRecord,
} from './types';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> ?? {}) };
  // Only set Content-Type when there is a request body
  if (init?.body) {
    headers['Content-Type'] ??= 'application/json';
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // ignore json parse issues
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

function repoBase(owner: string, repo: string): string {
  return `/api/sandboxes/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

// --- Session/health/key ---

export async function getSandboxesSession(): Promise<SandboxesSessionResponse> {
  try {
    return await apiFetch<SandboxesSessionResponse>('/api/sandboxes/session');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { authenticated: false };
    throw err;
  }
}

export async function getSandboxesHealth(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/sandboxes/health');
}

export async function getSandboxesKeyStatus(): Promise<SandboxesKeyStatus> {
  return apiFetch<SandboxesKeyStatus>('/api/sandboxes/key-status');
}

export async function setSandboxesKey(apiKey: string): Promise<SandboxesKeyStatus> {
  return apiFetch<SandboxesKeyStatus>('/api/sandboxes/key', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
}

export async function deleteSandboxesKey(): Promise<SandboxesKeyStatus> {
  return apiFetch<SandboxesKeyStatus>('/api/sandboxes/key', { method: 'DELETE' });
}

// --- Repo-scoped runtime ---

export async function startSandboxRuntime(
  owner: string,
  repo: string,
): Promise<{ sandbox: SandboxRecord; alreadyRunning?: boolean }> {
  return apiFetch(`${repoBase(owner, repo)}/runtime/start`, { method: 'POST' });
}

export async function stopSandboxRuntime(owner: string, repo: string): Promise<void> {
  await apiFetch(`${repoBase(owner, repo)}/runtime/stop`, { method: 'POST' });
}

export async function getSandboxRuntimeStatus(owner: string, repo: string): Promise<{ sandbox: SandboxRecord | null }> {
  return apiFetch(`${repoBase(owner, repo)}/runtime/status`);
}

// --- Commands ---

export async function runSandboxCommand(owner: string, repo: string, command: string): Promise<CommandRunResult> {
  const payload = await apiFetch<{ result: CommandRunResult }>(`${repoBase(owner, repo)}/command`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  return payload.result;
}

// --- Git ---

export async function getSandboxGitStatus(owner: string, repo: string): Promise<GitStatusResult> {
  return apiFetch<GitStatusResult>(`${repoBase(owner, repo)}/git/status`);
}

export async function commitSandboxChanges(
  owner: string,
  repo: string,
  message: string,
): Promise<{ commitSha: string }> {
  return apiFetch(`${repoBase(owner, repo)}/git/commit`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export async function pushSandboxChanges(owner: string, repo: string): Promise<{ ok: boolean; sha: string }> {
  return apiFetch(`${repoBase(owner, repo)}/git/push`, { method: 'POST' });
}

export async function pullSandboxChanges(owner: string, repo: string): Promise<{ ok: boolean }> {
  return apiFetch(`${repoBase(owner, repo)}/git/pull`, { method: 'POST' });
}

// --- Agent ---

export async function runAgentOnSandbox(
  owner: string,
  repo: string,
  prompt: string,
  model: string,
): Promise<AgentResult> {
  const payload = await apiFetch<{ result: AgentResult }>(`${repoBase(owner, repo)}/agent/run`, {
    method: 'POST',
    body: JSON.stringify({ prompt, model }),
  });
  return payload.result;
}
