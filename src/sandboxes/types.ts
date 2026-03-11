// Client-side mirrors of server/sandboxes/types.ts (minus internal fields like flyMachineId).
// Keep in sync manually when changing the server types.

export interface SandboxesUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface SandboxesKeyStatus {
  configured: boolean;
  masked: string | null;
}

export interface SandboxesSessionResponse {
  authenticated: boolean;
  user?: SandboxesUser;
  key?: SandboxesKeyStatus;
}

export type SandboxState = 'provisioning' | 'hydrating' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface SandboxRecord {
  id: string;
  userId: number;
  repoFullName: string;
  branch: string;
  baseCommitSha: string | null;
  lastPersistedSha: string | null;
  state: SandboxState;
  createdAtMs: number;
  updatedAtMs: number;
  lastActivityAtMs: number;
}

export interface CommandRunResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface AgentStep {
  type: 'tool_call' | 'message';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  text?: string;
}

export interface AgentResult {
  steps: AgentStep[];
  summary: string;
  model: string;
  changedFiles: string[];
}

export interface GitStatusResult {
  branch: string;
  changedFiles: string[];
  headSha: string;
  sandbox: {
    id: string;
    state: SandboxState;
    branch: string;
  };
}
