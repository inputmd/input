import { createReaderAiLedgerId } from './reader_ai_ledger.ts';

const READER_AI_EDITOR_CHECKPOINT_MAX_ENTRIES = 8;

export interface ReaderAiEditorCheckpointSelection {
  anchor: number;
  head: number;
}

export interface ReaderAiEditorCheckpoint {
  id: string;
  path: string;
  content: string;
  appliedContent?: string | null;
  revision: number;
  selection: ReaderAiEditorCheckpointSelection | null;
  scrollTop: number | null;
  createdAt: string;
  changeSetId: string | null;
  status: 'active' | 'restored' | 'discarded';
}

export function createReaderAiEditorCheckpoint(options: {
  path: string;
  content: string;
  appliedContent?: string | null;
  revision: number;
  selection?: ReaderAiEditorCheckpointSelection | null;
  scrollTop?: number | null;
  changeSetId?: string | null;
}): ReaderAiEditorCheckpoint {
  return {
    id: createReaderAiLedgerId('checkpoint'),
    path: options.path,
    content: options.content,
    appliedContent: options.appliedContent ?? null,
    revision: options.revision,
    selection: options.selection ?? null,
    scrollTop: options.scrollTop ?? null,
    createdAt: new Date().toISOString(),
    changeSetId: options.changeSetId ?? null,
    status: 'active',
  };
}

export function findActiveReaderAiEditorCheckpoint(
  checkpoints: ReaderAiEditorCheckpoint[],
  activeCheckpointId: string | null,
): ReaderAiEditorCheckpoint | null {
  if (!activeCheckpointId) return null;
  return checkpoints.find((checkpoint) => checkpoint.id === activeCheckpointId) ?? null;
}

export function findLatestReaderAiEditorCheckpointForPath(
  checkpoints: ReaderAiEditorCheckpoint[],
  path: string | null,
): ReaderAiEditorCheckpoint | null {
  if (!path) return null;
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint?.path === path && checkpoint.status !== 'discarded') return checkpoint;
  }
  return null;
}

export function appendReaderAiEditorCheckpoint(
  checkpoints: ReaderAiEditorCheckpoint[],
  nextCheckpoint: ReaderAiEditorCheckpoint,
): ReaderAiEditorCheckpoint[] {
  const next = checkpoints
    .map((checkpoint) =>
      checkpoint.status !== 'active'
        ? checkpoint
        : {
            ...checkpoint,
            status: 'discarded' as const,
          },
    )
    .concat(nextCheckpoint);
  return next.slice(-READER_AI_EDITOR_CHECKPOINT_MAX_ENTRIES);
}

export function updateReaderAiEditorCheckpointStatus(
  checkpoints: ReaderAiEditorCheckpoint[],
  checkpointId: string,
  status: ReaderAiEditorCheckpoint['status'],
): ReaderAiEditorCheckpoint[] {
  return checkpoints.map((checkpoint) =>
    checkpoint.id !== checkpointId
      ? checkpoint
      : {
          ...checkpoint,
          status,
        },
  );
}

export function activateReaderAiEditorCheckpoint(
  checkpoints: ReaderAiEditorCheckpoint[],
  checkpointId: string,
): ReaderAiEditorCheckpoint[] {
  return checkpoints.map((checkpoint) =>
    checkpoint.id === checkpointId
      ? {
          ...checkpoint,
          status: 'active',
        }
      : checkpoint.status !== 'active'
        ? checkpoint
        : {
            ...checkpoint,
            status: 'discarded',
          },
  );
}
