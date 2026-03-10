// Client-side mirrors of server/sandboxes/types.ts (minus internal fields like flyMachineId).
// Keep in sync manually when changing the server types.

export interface SandboxesUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface ComposerCapabilities {
  requiresUserKey: true;
}

export interface SandboxesKeyStatus {
  configured: boolean;
  masked: string | null;
}

export interface SandboxesSessionResponse {
  authenticated: boolean;
  user?: SandboxesUser;
  capabilities?: ComposerCapabilities;
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

export interface ComposeResult {
  provider: 'openai';
  model: string;
  summary: string;
  suggestedCommands: string[];
  notes: string[];
  usedRemoteModel: boolean;
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
