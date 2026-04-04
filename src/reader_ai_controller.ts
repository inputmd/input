import type { ReaderAiMessage } from './components/ReaderAiPanel';
import type { ReaderAiToolLogEntry } from './components/ReaderAiToolLog';
import type { ReaderAiEditProposal, ReaderAiStagedChange } from './reader_ai';
import type { ReaderAiEditorCheckpoint } from './reader_ai_editor_checkpoints';
import type { ReaderAiHistoryEntry } from './reader_ai_history_store';
import type { ReaderAiChangeSetRecord, ReaderAiRunRecord } from './reader_ai_ledger';
import type { ReaderAiProposalToolCallStatus, ReaderAiSelectedHunkIdsByChangeId } from './reader_ai_state';

export type ReaderAiConversationScope = { kind: 'document' } | { kind: 'selection'; source: string };

export interface ReaderAiSessionSnapshot {
  messages: ReaderAiMessage[];
  queuedCommands: string[];
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
  editorCheckpoints: ReaderAiEditorCheckpoint[];
  activeEditorCheckpointId: string | null;
  error: string | null;
  runs: ReaderAiRunRecord[];
  activeRunId: string | null;
  changeSets: ReaderAiChangeSetRecord[];
  activeChangeSetId: string | null;
}

export function createEmptyReaderAiSessionSnapshot(): ReaderAiSessionSnapshot {
  return {
    messages: [],
    queuedCommands: [],
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
    editorCheckpoints: [],
    activeEditorCheckpointId: null,
    error: null,
    runs: [],
    activeRunId: null,
    changeSets: [],
    activeChangeSetId: null,
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
  const activeChangeSet =
    loaded.activeChangeSetId && loaded.changeSets
      ? (loaded.changeSets.find((changeSet) => changeSet.id === loaded.activeChangeSetId) ?? null)
      : null;
  return {
    ...empty,
    messages: loaded.messages,
    queuedCommands: loaded.queuedCommands ?? [],
    summary: loaded.summary ?? '',
    scope: loaded.scope ?? null,
    toolLog: (loaded.toolLog ?? []) as ReaderAiToolLogEntry[],
    editProposals: loaded.editProposals ?? activeChangeSet?.editProposals ?? [],
    proposalStatusesByToolCallId:
      Object.keys(proposalStatusesByToolCallId).length > 0
        ? proposalStatusesByToolCallId
        : (activeChangeSet?.proposalStatusesByToolCallId ?? {}),
    stagedChanges: loaded.stagedChanges ?? activeChangeSet?.stagedChanges ?? [],
    selectedChangeIds,
    selectedHunkIdsByChangeId,
    appliedChanges: loaded.appliedChanges ?? [],
    stagedChangesInvalid: loaded.stagedChangesInvalid === true,
    stagedFileContents: loaded.stagedFileContents ?? activeChangeSet?.stagedFileContents ?? {},
    documentEditedContent: activeChangeSet?.documentEditedContent ?? empty.documentEditedContent,
    editorCheckpoints: loaded.editorCheckpoints ?? [],
    activeEditorCheckpointId: loaded.activeEditorCheckpointId ?? null,
    runs: loaded.runs ?? [],
    activeRunId: loaded.activeRunId ?? null,
    changeSets: loaded.changeSets ?? [],
    activeChangeSetId: loaded.activeChangeSetId ?? null,
  };
}

export function createReaderAiHistoryEntryFromSessionSnapshot(
  snapshot: Pick<
    ReaderAiSessionSnapshot,
    | 'messages'
    | 'queuedCommands'
    | 'summary'
    | 'scope'
    | 'toolLog'
    | 'editProposals'
    | 'proposalStatusesByToolCallId'
    | 'stagedChanges'
    | 'stagedChangesInvalid'
    | 'stagedFileContents'
    | 'appliedChanges'
    | 'editorCheckpoints'
    | 'activeEditorCheckpointId'
    | 'runs'
    | 'activeRunId'
    | 'changeSets'
    | 'activeChangeSetId'
  >,
): ReaderAiHistoryEntry {
  return {
    messages: snapshot.messages,
    ...(snapshot.queuedCommands.length > 0 ? { queuedCommands: snapshot.queuedCommands } : {}),
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
    ...(snapshot.editorCheckpoints.length > 0 ? { editorCheckpoints: snapshot.editorCheckpoints } : {}),
    ...(snapshot.activeEditorCheckpointId ? { activeEditorCheckpointId: snapshot.activeEditorCheckpointId } : {}),
    ...(snapshot.runs.length > 0 ? { runs: snapshot.runs } : {}),
    ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
    ...(snapshot.changeSets.length > 0 ? { changeSets: snapshot.changeSets } : {}),
    ...(snapshot.activeChangeSetId ? { activeChangeSetId: snapshot.activeChangeSetId } : {}),
  };
}
