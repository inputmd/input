import type { ReaderAiMessage, ReaderAiToolLogEntry } from './components/ReaderAiPanel';
import type { ReaderAiEditProposal, ReaderAiStagedChange } from './reader_ai';
import type { ReaderAiProposalToolCallStatus } from './reader_ai_state';

export type ReaderAiRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface ReaderAiRunStep {
  id: string;
  kind: 'tool' | 'task';
  toolCallId?: string;
  taskId?: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  detail?: string;
  args?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  retryCount: number;
  maxRetries: number;
  retryable: boolean;
  retryState: 'none' | 'ready' | 'in_progress' | 'exhausted';
  retryReason?: 'transient' | 'tool-arguments' | 'task-failure' | 'unknown';
}

export interface ReaderAiRunRecord {
  id: string;
  parentRunId?: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  status: ReaderAiRunStatus;
  summary?: string;
  scope?: { kind: 'document' } | { kind: 'selection'; source: string };
  baseMessages: ReaderAiMessage[];
  response?: string;
  error?: string;
  toolLog: ReaderAiToolLogEntry[];
  steps: ReaderAiRunStep[];
}

export type ReaderAiChangeSetStatus =
  | 'draft'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'partial'
  | 'failed'
  | 'conflicted'
  | 'superseded';

export interface ReaderAiChangeSetFailure {
  path: string;
  error: string;
}

export interface ReaderAiChangeSetFileRecord {
  path: string;
  status: 'ready' | 'missing_content' | 'stale' | 'applied' | 'failed' | 'conflicted';
  hasCompleteContent: boolean;
  baseRevision?: number;
  originalHash?: string;
  modifiedHash?: string;
}

export interface ReaderAiChangeSetRecord {
  id: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: ReaderAiChangeSetStatus;
  editProposals: ReaderAiEditProposal[];
  proposalStatusesByToolCallId: Record<string, ReaderAiProposalToolCallStatus>;
  stagedChanges: ReaderAiStagedChange[];
  stagedFileContents: Record<string, string>;
  documentEditedContent: string | null;
  files: ReaderAiChangeSetFileRecord[];
  appliedPaths: string[];
  failedPaths: ReaderAiChangeSetFailure[];
}

export function createReaderAiLedgerId(prefix: 'run' | 'step' | 'changeset'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function createReaderAiRunRecord(options: {
  modelId: string;
  baseMessages: ReaderAiMessage[];
  scope: ReaderAiRunRecord['scope'];
  parentRunId?: string;
}): ReaderAiRunRecord {
  const now = new Date().toISOString();
  return {
    id: createReaderAiLedgerId('run'),
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    modelId: options.modelId,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    ...(options.scope ? { scope: options.scope } : {}),
    baseMessages: options.baseMessages,
    toolLog: [],
    steps: [],
  };
}

export function createReaderAiChangeSetRecord(options: {
  runId: string;
  editProposals?: ReaderAiEditProposal[];
  proposalStatusesByToolCallId?: Record<string, ReaderAiProposalToolCallStatus>;
  stagedChanges?: ReaderAiStagedChange[];
  stagedFileContents?: Record<string, string>;
  documentEditedContent?: string | null;
  files?: ReaderAiChangeSetFileRecord[];
}): ReaderAiChangeSetRecord {
  const now = new Date().toISOString();
  return {
    id: createReaderAiLedgerId('changeset'),
    runId: options.runId,
    createdAt: now,
    updatedAt: now,
    status: (options.stagedChanges?.length ?? 0) > 0 ? 'ready' : 'draft',
    editProposals: options.editProposals ?? [],
    proposalStatusesByToolCallId: options.proposalStatusesByToolCallId ?? {},
    stagedChanges: options.stagedChanges ?? [],
    stagedFileContents: options.stagedFileContents ?? {},
    documentEditedContent: options.documentEditedContent ?? null,
    files: options.files ?? [],
    appliedPaths: [],
    failedPaths: [],
  };
}
