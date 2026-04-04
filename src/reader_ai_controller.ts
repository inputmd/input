import type { ReaderAiMessage } from './components/ReaderAiPanel';
import type { ReaderAiToolLogEntry } from './components/ReaderAiToolLog';
import type { ReaderAiEditProposal, ReaderAiStagedChange } from './reader_ai';
import type { ReaderAiHistoryEntry } from './reader_ai_history_store';
import type { ReaderAiProposalToolCallStatus, ReaderAiSelectedHunkIdsByChangeId } from './reader_ai_state';

export type ReaderAiConversationScope = { kind: 'document' } | { kind: 'selection'; source: string };

export interface ReaderAiUndoState {
  path: string;
  content: string;
  revision: number;
}

export interface ReaderAiSessionSnapshot {
  messages: ReaderAiMessage[];
  summary: string;
  scope: ReaderAiConversationScope | null;
  hasEligibleSelection: boolean;
  sending: boolean;
  applyingChanges: boolean;
  toolStatus: string | null;
  toolLog: ReaderAiToolLogEntry[];
  editProposals: ReaderAiEditProposal[];
  proposalStatusesByToolCallId: Record<string, ReaderAiProposalToolCallStatus>;
  stagedChanges: ReaderAiStagedChange[];
  selectedChangeIds: Set<string>;
  selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId;
  appliedChanges: Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>;
  stagedChangesInvalid: boolean;
  stagedFileContents: Record<string, string>;
  documentEditedContent: string | null;
  undoState: ReaderAiUndoState | null;
  error: string | null;
}

export function createEmptyReaderAiSessionSnapshot(): ReaderAiSessionSnapshot {
  return {
    messages: [],
    summary: '',
    scope: null,
    hasEligibleSelection: false,
    sending: false,
    applyingChanges: false,
    toolStatus: null,
    toolLog: [],
    editProposals: [],
    proposalStatusesByToolCallId: {},
    stagedChanges: [],
    selectedChangeIds: new Set(),
    selectedHunkIdsByChangeId: {},
    appliedChanges: [],
    stagedChangesInvalid: false,
    stagedFileContents: {},
    documentEditedContent: null,
    undoState: null,
    error: null,
  };
}

export function createReaderAiSessionSnapshotFromHistory(options: {
  loaded: ReaderAiHistoryEntry;
  proposalStatusesByToolCallId: Record<string, ReaderAiProposalToolCallStatus>;
  selectedChangeIds: Set<string>;
  selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId;
}): ReaderAiSessionSnapshot {
  const empty = createEmptyReaderAiSessionSnapshot();
  const { loaded, proposalStatusesByToolCallId, selectedChangeIds, selectedHunkIdsByChangeId } = options;
  return {
    ...empty,
    messages: loaded.messages,
    summary: loaded.summary ?? '',
    scope: loaded.scope ?? null,
    toolLog: (loaded.toolLog ?? []) as ReaderAiToolLogEntry[],
    editProposals: loaded.editProposals ?? [],
    proposalStatusesByToolCallId,
    stagedChanges: loaded.stagedChanges ?? [],
    selectedChangeIds,
    selectedHunkIdsByChangeId,
    appliedChanges: loaded.appliedChanges ?? [],
    stagedChangesInvalid: loaded.stagedChangesInvalid === true,
    stagedFileContents: loaded.stagedFileContents ?? {},
  };
}

export function createReaderAiHistoryEntryFromSessionSnapshot(
  snapshot: Pick<
    ReaderAiSessionSnapshot,
    | 'messages'
    | 'summary'
    | 'scope'
    | 'toolLog'
    | 'editProposals'
    | 'proposalStatusesByToolCallId'
    | 'stagedChanges'
    | 'stagedChangesInvalid'
    | 'stagedFileContents'
    | 'appliedChanges'
  >,
): ReaderAiHistoryEntry {
  return {
    messages: snapshot.messages,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    ...(snapshot.scope ? { scope: snapshot.scope } : {}),
    ...(snapshot.toolLog.length > 0 ? { toolLog: snapshot.toolLog } : {}),
    ...(snapshot.editProposals.length > 0 ? { editProposals: snapshot.editProposals } : {}),
    ...(Object.keys(snapshot.proposalStatusesByToolCallId).length > 0
      ? { proposalStatusesByToolCallId: snapshot.proposalStatusesByToolCallId }
      : {}),
    ...(snapshot.stagedChanges.length > 0 ? { stagedChanges: snapshot.stagedChanges } : {}),
    ...(snapshot.stagedChangesInvalid ? { stagedChangesInvalid: true } : {}),
    ...(Object.keys(snapshot.stagedFileContents).length > 0 ? { stagedFileContents: snapshot.stagedFileContents } : {}),
    ...(snapshot.appliedChanges.length > 0 ? { appliedChanges: snapshot.appliedChanges } : {}),
  };
}
