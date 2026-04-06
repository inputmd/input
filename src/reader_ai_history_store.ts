import {
  buildReaderAiHistoryDocumentKey,
  clearReaderAiMessagesFromHistory,
  loadReaderAiEntryFromHistory,
  persistReaderAiMessagesToHistory,
  type ReaderAiHistoryEntry,
  type ReaderAiHistoryStore,
} from './reader_ai_history';
import type { ReaderAiProposalToolCallStatus, ReaderAiSelectedHunkIdsByChangeId } from './reader_ai_state';

export type { ReaderAiHistoryEntry, ReaderAiHistoryStore };
export { buildReaderAiHistoryDocumentKey };

export function loadReaderAiHistoryEntry(historyKey: string): ReaderAiHistoryEntry {
  return loadReaderAiEntryFromHistory(historyKey);
}

export function persistReaderAiHistoryEntry(historyKey: string, entry: ReaderAiHistoryEntry): void {
  persistReaderAiMessagesToHistory(
    historyKey,
    entry.messages,
    entry.queuedCommands,
    entry.summary,
    entry.scope,
    entry.transcript,
    entry.toolLog,
    entry.editProposals,
    entry.proposalStatusesByToolCallId,
    entry.stagedChanges,
    entry.stagedChangesInvalid,
    entry.stagedFileContents,
    entry.appliedChanges,
    entry.runs,
    entry.activeRunId,
    entry.changeSets,
    entry.activeChangeSetId,
  );
}

export function clearReaderAiHistoryEntry(historyKey: string): void {
  clearReaderAiMessagesFromHistory(historyKey);
}

export function getReaderAiProposalStatusesFromHistoryEntry(
  loaded: ReaderAiHistoryEntry,
): Record<string, ReaderAiProposalToolCallStatus> {
  if (loaded.proposalStatusesByToolCallId && Object.keys(loaded.proposalStatusesByToolCallId).length > 0) {
    return loaded.proposalStatusesByToolCallId;
  }
  return Object.fromEntries(
    (loaded.editProposals ?? [])
      .filter(
        (
          proposal,
        ): proposal is NonNullable<ReaderAiHistoryEntry['editProposals']>[number] & {
          toolCallId: string;
          status: 'accepted' | 'rejected';
        } =>
          typeof proposal.toolCallId === 'string' && (proposal.status === 'accepted' || proposal.status === 'rejected'),
      )
      .map((proposal) => [proposal.toolCallId, proposal.status]),
  );
}

export function createReaderAiSelectionStateFromHistoryEntry(loaded: ReaderAiHistoryEntry): {
  selectedChangeIds: Set<string>;
  selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId;
} {
  const stagedChanges =
    loaded.stagedChanges ??
    (loaded.activeChangeSetId
      ? loaded.changeSets?.find((changeSet) => changeSet.id === loaded.activeChangeSetId)?.stagedChanges
      : undefined) ??
    [];
  return {
    selectedChangeIds: new Set(
      stagedChanges.map((change) => change.id).filter((id): id is string => typeof id === 'string'),
    ),
    selectedHunkIdsByChangeId: Object.fromEntries(
      stagedChanges
        .filter((change) => change.id && Array.isArray(change.hunks))
        .map((change) => [
          change.id as string,
          new Set((change.hunks ?? []).map((hunk) => hunk.id).filter((id): id is string => typeof id === 'string')),
        ]),
    ),
  };
}
