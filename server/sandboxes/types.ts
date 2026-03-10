import type { Session } from '../types';

export type SandboxesSession = Session;

export type SandboxProviderId = 'openai';

export type SandboxState = 'provisioning' | 'hydrating' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface SandboxRecord {
  id: string;
  userId: number;
  repoFullName: string;
  branch: string;
  baseCommitSha: string | null;
  lastPersistedSha: string | null;
  flyMachineId: string | null;
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
  provider: SandboxProviderId;
  model: string;
  summary: string;
  suggestedCommands: string[];
  notes: string[];
  usedRemoteModel: boolean;
}
