import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReaderAiMessage } from '../components/ReaderAiPanel';
import type { ReaderAiToolLogEntry } from '../components/ReaderAiToolLog';
import { stripCriticMarkupComments } from '../criticmarkup.ts';
import {
  askReaderAiStream,
  type ReaderAiEditProposal,
  type ReaderAiModel,
  type ReaderAiStagedChange,
} from '../reader_ai';
import { buildReaderAiContextLogPayload } from '../reader_ai_context';
import {
  createEmptyReaderAiSessionSnapshot,
  createReaderAiHistoryEntryFromSessionSnapshot,
  createReaderAiSessionSnapshotFromHistory,
  type ReaderAiConversationScope,
  type ReaderAiSessionSnapshot,
} from '../reader_ai_controller';
import {
  buildReaderAiChangeSetFileRecords,
  buildReaderAiRetryRequestFromRuns,
  classifyReaderAiStepRetryPolicy,
  completeReaderAiRunStepRetry,
  findReaderAiActiveChangeSet,
  markReaderAiChangeSetFileStatuses,
  markReaderAiRunStepRetryAttempt,
  rebaseReaderAiChangeAgainstContent,
  resolveReaderAiStagedHunkState,
} from '../reader_ai_controller_runtime';
import {
  activateReaderAiEditorCheckpoint,
  appendReaderAiEditorCheckpoint,
  createReaderAiEditorCheckpoint,
  findActiveReaderAiEditorCheckpoint,
  type ReaderAiEditorCheckpoint,
  updateReaderAiEditorCheckpointStatus,
} from '../reader_ai_editor_checkpoints';
import {
  buildReaderAiHistoryDocumentKey,
  createReaderAiSelectionStateFromHistoryEntry,
  getReaderAiProposalStatusesFromHistoryEntry,
  loadReaderAiHistoryEntry,
} from '../reader_ai_history_store';
import {
  createReaderAiChangeSetRecord,
  createReaderAiLedgerId,
  createReaderAiRunRecord,
  type ReaderAiChangeSetFailure,
  type ReaderAiChangeSetRecord,
  type ReaderAiRunRecord,
} from '../reader_ai_ledger';
import {
  selectEffectiveReaderAiStagedChanges,
  selectEffectiveReaderAiStagedFileContents,
} from '../reader_ai_selectors';
import type { ReaderAiProposalToolCallStatus, ReaderAiSelectedHunkIdsByChangeId } from '../reader_ai_state';
import {
  clearPersistedReaderAiHistoryEntry,
  flushPersistedReaderAiHistoryEntry,
  schedulePersistReaderAiHistoryEntry,
} from '../reader_ai_state_store';
import {
  createReaderAiTranscriptId,
  type ReaderAiTranscriptItem,
  reconcileReaderAiTranscriptWithMessages,
} from '../reader_ai_transcript';

export { buildReaderAiHistoryDocumentKey, type ReaderAiConversationScope, type ReaderAiEditorCheckpoint };

interface UseReaderAiSessionOptions {
  historyEligible: boolean;
  historyDocumentKey: string | null;
  resetInlinePromptState: () => void;
  inlinePromptAbortRef: { current: AbortController | null };
}

interface StartReaderAiStreamOptions {
  allowDocumentEdits: boolean;
  baseMessages: ReaderAiMessage[];
  currentDocPath: string | null;
  documentSource: string;
  edited?: boolean;
  modelId: string;
  parentRunId?: string;
  retryStepId?: string;
  selectedModel: ReaderAiModel | null;
  selectionSource: string | null;
  showWarningToast: (message: string) => void;
}

interface PruneAppliedReaderAiPathsOptions {
  clearDocumentEditedContentPath?: string | null;
}

interface ReaderAiRetryRequest {
  baseMessages: ReaderAiMessage[];
  modelId: string | null;
  parentRunId: string | null;
  retryStepId?: string;
}

type ReaderAiChangeSetDecisionItem = Extract<ReaderAiTranscriptItem, { kind: 'change_set_decision' }>;

function normalizeReaderAiSelectedHunkIdsByChangeId(value?: Record<string, string[]>): Record<string, string[]> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([changeId, hunkIds]) => [changeId, [...hunkIds].sort()]),
  );
}

function normalizeReaderAiStagedFileContents(value?: Record<string, string>): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeReaderAiDiscardedChanges(changes: ReaderAiStagedChange[]) {
  return [...changes]
    .map((change) => ({
      path: change.path,
      type: change.type,
      diff: change.diff,
      revision: change.revision ?? null,
      originalContent: change.originalContent ?? null,
      modifiedContent: change.modifiedContent ?? null,
      hunks:
        change.hunks?.map((hunk) => ({
          header: hunk.header,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: hunk.lines.map((line) => ({
            type: line.type,
            content: line.content,
          })),
        })) ?? [],
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.type.localeCompare(right.type) ||
        left.diff.localeCompare(right.diff),
    );
}

function buildReaderAiChangeSetDecisionComparisonPayload(
  item: Pick<
    ReaderAiChangeSetDecisionItem,
    | 'action'
    | 'changes'
    | 'selectedChangeIds'
    | 'selectedHunkIdsByChangeId'
    | 'stagedFileContents'
    | 'documentEditedContent'
  >,
) {
  return {
    action: item.action,
    changes: normalizeReaderAiDiscardedChanges(item.changes),
    selectedChangeIds: [...(item.selectedChangeIds ?? [])].sort(),
    selectedHunkIdsByChangeId: normalizeReaderAiSelectedHunkIdsByChangeId(item.selectedHunkIdsByChangeId),
    stagedFileContents: normalizeReaderAiStagedFileContents(item.stagedFileContents),
    documentEditedContent: item.documentEditedContent ?? null,
  };
}

function areReaderAiChangeSetDecisionsEquivalent(
  left: Pick<
    ReaderAiChangeSetDecisionItem,
    | 'action'
    | 'changes'
    | 'selectedChangeIds'
    | 'selectedHunkIdsByChangeId'
    | 'stagedFileContents'
    | 'documentEditedContent'
  >,
  right: Pick<
    ReaderAiChangeSetDecisionItem,
    | 'action'
    | 'changes'
    | 'selectedChangeIds'
    | 'selectedHunkIdsByChangeId'
    | 'stagedFileContents'
    | 'documentEditedContent'
  >,
): boolean {
  return (
    JSON.stringify(buildReaderAiChangeSetDecisionComparisonPayload(left)) ===
    JSON.stringify(buildReaderAiChangeSetDecisionComparisonPayload(right))
  );
}

export function useReaderAiSession({
  historyEligible,
  historyDocumentKey,
  resetInlinePromptState,
  inlinePromptAbortRef,
}: UseReaderAiSessionOptions) {
  const [readerAiMessages, setReaderAiMessages] = useState<ReaderAiMessage[]>([]);
  const [readerAiQueuedCommands, setReaderAiQueuedCommands] = useState<string[]>([]);
  const [readerAiSummary, setReaderAiSummary] = useState('');
  const [readerAiConversationScope, setReaderAiConversationScope] = useState<ReaderAiConversationScope | null>(null);
  const [readerAiHasEligibleSelection, setReaderAiHasEligibleSelection] = useState(false);
  const [readerAiSending, setReaderAiSending] = useState(false);
  const [readerAiToolStatus, setReaderAiToolStatus] = useState<string | null>(null);
  const [readerAiTranscript, setReaderAiTranscript] = useState<ReaderAiTranscriptItem[]>([]);
  const [readerAiToolLog, setReaderAiToolLog] = useState<ReaderAiToolLogEntry[]>([]);
  const [readerAiEditProposals, setReaderAiEditProposals] = useState<ReaderAiEditProposal[]>([]);
  const [readerAiProposalStatusesByToolCallId, setReaderAiProposalStatusesByToolCallId] = useState<
    Record<string, ReaderAiProposalToolCallStatus>
  >({});
  const [readerAiStagedChanges, setReaderAiStagedChanges] = useState<ReaderAiStagedChange[]>([]);
  const [readerAiAppliedChanges, setReaderAiAppliedChanges] = useState<
    Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>
  >([]);
  const [readerAiEditorCheckpoints, setReaderAiEditorCheckpoints] = useState<ReaderAiEditorCheckpoint[]>([]);
  const [readerAiActiveEditorCheckpointId, setReaderAiActiveEditorCheckpointId] = useState<string | null>(null);
  const [readerAiStagedChangesInvalid, setReaderAiStagedChangesInvalid] = useState(false);
  const [readerAiStagedFileContents, setReaderAiStagedFileContents] = useState<Record<string, string>>({});
  const [readerAiDocumentEditedContent, setReaderAiDocumentEditedContent] = useState<string | null>(null);
  const [readerAiApplyingChanges, setReaderAiApplyingChanges] = useState(false);
  const [readerAiError, setReaderAiError] = useState<string | null>(null);
  const [readerAiSelectedChangeIds, setReaderAiSelectedChangeIds] = useState<Set<string>>(() => new Set());
  const [readerAiSelectedHunkIdsByChangeId, setReaderAiSelectedHunkIdsByChangeId] =
    useState<ReaderAiSelectedHunkIdsByChangeId>({});
  const [readerAiRuns, setReaderAiRuns] = useState<ReaderAiRunRecord[]>([]);
  const [readerAiActiveRunId, setReaderAiActiveRunId] = useState<string | null>(null);
  const [readerAiChangeSets, setReaderAiChangeSets] = useState<ReaderAiChangeSetRecord[]>([]);
  const [readerAiActiveChangeSetId, setReaderAiActiveChangeSetId] = useState<string | null>(null);

  const effectiveReaderAiStagedChanges = useMemo(
    () =>
      selectEffectiveReaderAiStagedChanges({
        editProposals: readerAiEditProposals,
        stagedChanges: readerAiStagedChanges,
        selectedChangeIds: readerAiSelectedChangeIds,
        selectedHunkIdsByChangeId: readerAiSelectedHunkIdsByChangeId,
      }),
    [readerAiEditProposals, readerAiSelectedChangeIds, readerAiSelectedHunkIdsByChangeId, readerAiStagedChanges],
  );
  const effectiveReaderAiStagedFileContents = useMemo(
    () => selectEffectiveReaderAiStagedFileContents(effectiveReaderAiStagedChanges),
    [effectiveReaderAiStagedChanges],
  );
  const readerAiStagedChangesStreaming =
    readerAiSending && (readerAiEditProposals.length > 0 || readerAiStagedChanges.length > 0);
  const readerAiActiveChangeSet = useMemo(
    () => findReaderAiActiveChangeSet(readerAiChangeSets, readerAiActiveChangeSetId),
    [readerAiActiveChangeSetId, readerAiChangeSets],
  );
  const readerAiActiveEditorCheckpoint = useMemo(
    () => findActiveReaderAiEditorCheckpoint(readerAiEditorCheckpoints, readerAiActiveEditorCheckpointId),
    [readerAiActiveEditorCheckpointId, readerAiEditorCheckpoints],
  );

  const readerAiAbortRef = useRef<AbortController | null>(null);
  const readerAiStagedChangesRef = useRef<ReaderAiStagedChange[]>(readerAiStagedChanges);
  const readerAiEditProposalsRef = useRef<ReaderAiEditProposal[]>(readerAiEditProposals);
  const readerAiSelectedChangeIdsRef = useRef<Set<string>>(readerAiSelectedChangeIds);
  const readerAiSelectedHunkIdsByChangeIdRef = useRef<ReaderAiSelectedHunkIdsByChangeId>(
    readerAiSelectedHunkIdsByChangeId,
  );
  const readerAiPrevHistoryKeyRef = useRef<string | null>(null);
  const readerAiSkipPersistHistoryKeyRef = useRef<string | null>(null);
  const readerAiCurrentRunIdRef = useRef<string | null>(null);
  const readerAiSummaryRef = useRef(readerAiSummary);
  const readerAiConversationScopeRef = useRef<ReaderAiConversationScope | null>(readerAiConversationScope);
  const readerAiStagedFileContentsRef = useRef<Record<string, string>>(readerAiStagedFileContents);
  const readerAiDocumentEditedContentRef = useRef<string | null>(readerAiDocumentEditedContent);

  const appendReaderAiTranscriptItem = useCallback((item: ReaderAiTranscriptItem) => {
    setReaderAiTranscript((current) => [...current, item]);
  }, []);

  const updateReaderAiTranscriptItem = useCallback(
    (itemId: string | null, updater: (item: ReaderAiTranscriptItem) => ReaderAiTranscriptItem | null) => {
      if (!itemId) return;
      setReaderAiTranscript((current) =>
        current.flatMap((item) => {
          if (item.id !== itemId) return [item];
          const updated = updater(item);
          return updated ? [updated] : [];
        }),
      );
    },
    [],
  );

  const appendReaderAiChangeSetDecision = useCallback(
    (options: {
      action: Extract<ReaderAiTranscriptItem, { kind: 'change_set_decision' }>['action'];
      changes: ReaderAiStagedChange[];
      runId?: string;
      iteration?: number;
      selectedChangeIds?: string[];
      selectedHunkIdsByChangeId?: Record<string, string[]>;
      stagedFileContents?: Record<string, string>;
      documentEditedContent?: string | null;
    }) => {
      const nextItem: ReaderAiChangeSetDecisionItem = {
        id: createReaderAiTranscriptId('change-set'),
        kind: 'change_set_decision',
        action: options.action,
        changes: options.changes,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(typeof options.iteration === 'number' ? { iteration: options.iteration } : {}),
        ...(options.selectedChangeIds && options.selectedChangeIds.length > 0
          ? { selectedChangeIds: options.selectedChangeIds }
          : {}),
        ...(options.selectedHunkIdsByChangeId && Object.keys(options.selectedHunkIdsByChangeId).length > 0
          ? { selectedHunkIdsByChangeId: options.selectedHunkIdsByChangeId }
          : {}),
        ...(options.stagedFileContents && Object.keys(options.stagedFileContents).length > 0
          ? { stagedFileContents: options.stagedFileContents }
          : {}),
        ...(typeof options.documentEditedContent === 'string' || options.documentEditedContent === null
          ? { documentEditedContent: options.documentEditedContent }
          : {}),
      };
      setReaderAiTranscript((current) => {
        if (nextItem.action !== 'discarded') return [...current, nextItem];
        const previousDiscardedItem = [...current]
          .reverse()
          .find(
            (item): item is ReaderAiChangeSetDecisionItem =>
              item.kind === 'change_set_decision' && item.action === 'discarded',
          );
        if (previousDiscardedItem && areReaderAiChangeSetDecisionsEquivalent(previousDiscardedItem, nextItem)) {
          return current;
        }
        return [...current, nextItem];
      });
    },
    [],
  );

  const updateReaderAiRun = useCallback((runId: string, updater: (run: ReaderAiRunRecord) => ReaderAiRunRecord) => {
    setReaderAiRuns((current) =>
      current.map((run) => {
        if (run.id !== runId) return run;
        const next = updater(run);
        return {
          ...next,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  }, []);

  const updateReaderAiActiveChangeSet = useCallback(
    (updater: (changeSet: ReaderAiChangeSetRecord) => ReaderAiChangeSetRecord | null) => {
      setReaderAiChangeSets((current) => {
        const activeChangeSetId = readerAiActiveChangeSetId;
        if (!activeChangeSetId) return current;
        return current.flatMap((changeSet) => {
          if (changeSet.id !== activeChangeSetId) return [changeSet];
          const updated = updater(changeSet);
          if (!updated) return [];
          return [
            {
              ...updated,
              updatedAt: new Date().toISOString(),
            },
          ];
        });
      });
    },
    [readerAiActiveChangeSetId],
  );

  const markReaderAiPriorChangeSetsSuperseded = useCallback((nextActiveChangeSetId: string) => {
    setReaderAiChangeSets((current) =>
      current.map((changeSet) =>
        changeSet.id === nextActiveChangeSetId || changeSet.status === 'applied' || changeSet.status === 'superseded'
          ? changeSet
          : {
              ...changeSet,
              status: 'superseded',
              updatedAt: new Date().toISOString(),
            },
      ),
    );
  }, []);

  const ensureReaderAiActiveChangeSet = useCallback(
    (runId: string, updater: (changeSet: ReaderAiChangeSetRecord) => ReaderAiChangeSetRecord) => {
      let nextId: string | null = null;
      setReaderAiChangeSets((current) => {
        const existing =
          current.find((changeSet) => changeSet.id === readerAiActiveChangeSetId && changeSet.runId === runId) ??
          current.find((changeSet) => changeSet.runId === runId) ??
          null;
        const now = new Date().toISOString();
        if (existing) {
          nextId = existing.id;
          return current.map((changeSet) =>
            changeSet.id !== existing.id
              ? changeSet
              : {
                  ...updater(changeSet),
                  updatedAt: now,
                },
          );
        }
        const created = updater(
          createReaderAiChangeSetRecord({
            runId,
            files: [],
          }),
        );
        nextId = created.id;
        return [...current, { ...created, updatedAt: now }];
      });
      if (nextId) {
        setReaderAiActiveChangeSetId(nextId);
        markReaderAiPriorChangeSetsSuperseded(nextId);
      }
    },
    [markReaderAiPriorChangeSetsSuperseded, readerAiActiveChangeSetId],
  );

  const applyReaderAiSessionSnapshot = useCallback((snapshot: ReaderAiSessionSnapshot) => {
    setReaderAiMessages(snapshot.messages);
    setReaderAiQueuedCommands(snapshot.queuedCommands);
    setReaderAiSummary(snapshot.summary);
    setReaderAiConversationScope(snapshot.scope);
    setReaderAiHasEligibleSelection(snapshot.hasEligibleSelection);
    setReaderAiSending(snapshot.sending);
    setReaderAiApplyingChanges(snapshot.applyingChanges);
    setReaderAiToolStatus(snapshot.toolStatus);
    setReaderAiTranscript(snapshot.transcript);
    setReaderAiToolLog(snapshot.toolLog);
    setReaderAiEditProposals(snapshot.editProposals);
    setReaderAiProposalStatusesByToolCallId(snapshot.proposalStatusesByToolCallId);
    setReaderAiStagedChanges(snapshot.stagedChanges);
    setReaderAiSelectedChangeIds(snapshot.selectedChangeIds);
    setReaderAiSelectedHunkIdsByChangeId(snapshot.selectedHunkIdsByChangeId);
    setReaderAiAppliedChanges(snapshot.appliedChanges);
    setReaderAiEditorCheckpoints(snapshot.editorCheckpoints);
    setReaderAiActiveEditorCheckpointId(snapshot.activeEditorCheckpointId);
    setReaderAiStagedChangesInvalid(snapshot.stagedChangesInvalid);
    setReaderAiStagedFileContents(snapshot.stagedFileContents);
    setReaderAiDocumentEditedContent(snapshot.documentEditedContent);
    setReaderAiError(snapshot.error);
    setReaderAiRuns(snapshot.runs);
    setReaderAiActiveRunId(snapshot.activeRunId);
    setReaderAiChangeSets(snapshot.changeSets);
    setReaderAiActiveChangeSetId(snapshot.activeChangeSetId);
    readerAiCurrentRunIdRef.current = snapshot.activeRunId;
    readerAiSummaryRef.current = snapshot.summary;
    readerAiConversationScopeRef.current = snapshot.scope;
    readerAiStagedChangesRef.current = snapshot.stagedChanges;
    readerAiEditProposalsRef.current = snapshot.editProposals;
    readerAiSelectedChangeIdsRef.current = snapshot.selectedChangeIds;
    readerAiSelectedHunkIdsByChangeIdRef.current = snapshot.selectedHunkIdsByChangeId;
    readerAiStagedFileContentsRef.current = snapshot.stagedFileContents;
    readerAiDocumentEditedContentRef.current = snapshot.documentEditedContent;
  }, []);

  useEffect(() => {
    readerAiSummaryRef.current = readerAiSummary;
  }, [readerAiSummary]);

  useEffect(() => {
    readerAiConversationScopeRef.current = readerAiConversationScope;
  }, [readerAiConversationScope]);

  useEffect(() => {
    readerAiStagedChangesRef.current = readerAiStagedChanges;
  }, [readerAiStagedChanges]);

  useEffect(() => {
    readerAiEditProposalsRef.current = readerAiEditProposals;
  }, [readerAiEditProposals]);

  useEffect(() => {
    readerAiSelectedChangeIdsRef.current = readerAiSelectedChangeIds;
  }, [readerAiSelectedChangeIds]);

  useEffect(() => {
    readerAiSelectedHunkIdsByChangeIdRef.current = readerAiSelectedHunkIdsByChangeId;
  }, [readerAiSelectedHunkIdsByChangeId]);

  useEffect(() => {
    readerAiStagedFileContentsRef.current = readerAiStagedFileContents;
  }, [readerAiStagedFileContents]);

  useEffect(() => {
    readerAiDocumentEditedContentRef.current = readerAiDocumentEditedContent;
  }, [readerAiDocumentEditedContent]);

  useEffect(() => {
    if (!readerAiActiveChangeSetId) return;
    setReaderAiChangeSets((current) =>
      current.map((changeSet) =>
        changeSet.id !== readerAiActiveChangeSetId
          ? changeSet
          : {
              ...changeSet,
              updatedAt: new Date().toISOString(),
              editProposals: readerAiEditProposals,
              proposalStatusesByToolCallId: readerAiProposalStatusesByToolCallId,
              stagedChanges: readerAiStagedChanges,
              stagedFileContents: readerAiStagedFileContents,
              documentEditedContent: readerAiDocumentEditedContent,
              files: buildReaderAiChangeSetFileRecords({
                stagedChanges: readerAiStagedChanges,
                stagedFileContents: readerAiStagedFileContents,
              }),
              status:
                changeSet.status === 'applying' ||
                changeSet.status === 'partial' ||
                changeSet.status === 'failed' ||
                changeSet.status === 'conflicted' ||
                changeSet.status === 'applied' ||
                changeSet.status === 'superseded'
                  ? changeSet.status
                  : readerAiStagedChanges.length > 0
                    ? 'ready'
                    : 'draft',
            },
      ),
    );
  }, [
    readerAiActiveChangeSetId,
    readerAiDocumentEditedContent,
    readerAiEditProposals,
    readerAiProposalStatusesByToolCallId,
    readerAiStagedChanges,
    readerAiStagedFileContents,
  ]);

  useEffect(() => {
    if (!readerAiActiveRunId) return;
    setReaderAiRuns((current) =>
      current.map((run) =>
        run.id !== readerAiActiveRunId
          ? run
          : {
              ...run,
              updatedAt: new Date().toISOString(),
              summary: readerAiSummary || undefined,
              toolLog: readerAiToolLog,
              response:
                readerAiMessages.length > 0 && readerAiMessages[readerAiMessages.length - 1]?.role === 'assistant'
                  ? readerAiMessages[readerAiMessages.length - 1]?.content
                  : run.response,
            },
      ),
    );
  }, [readerAiActiveRunId, readerAiMessages, readerAiSummary, readerAiToolLog]);

  const persistedReaderAiHistoryEntry = useMemo(
    () =>
      createReaderAiHistoryEntryFromSessionSnapshot({
        messages: readerAiMessages,
        queuedCommands: readerAiQueuedCommands,
        summary: readerAiSummary,
        scope: readerAiConversationScope,
        transcript: readerAiTranscript,
        toolLog: readerAiToolLog,
        editProposals: readerAiEditProposals,
        proposalStatusesByToolCallId: readerAiProposalStatusesByToolCallId,
        stagedChanges: readerAiStagedChanges,
        stagedChangesInvalid: readerAiStagedChangesInvalid,
        stagedFileContents: readerAiStagedFileContents,
        appliedChanges: readerAiAppliedChanges,
        editorCheckpoints: readerAiEditorCheckpoints,
        activeEditorCheckpointId: readerAiActiveEditorCheckpointId,
        runs: readerAiRuns,
        activeRunId: readerAiActiveRunId,
        changeSets: readerAiChangeSets,
        activeChangeSetId: readerAiActiveChangeSetId,
      }),
    [
      readerAiActiveChangeSetId,
      readerAiActiveEditorCheckpointId,
      readerAiActiveRunId,
      readerAiAppliedChanges,
      readerAiChangeSets,
      readerAiConversationScope,
      readerAiEditProposals,
      readerAiMessages,
      readerAiQueuedCommands,
      readerAiEditorCheckpoints,
      readerAiProposalStatusesByToolCallId,
      readerAiRuns,
      readerAiTranscript,
      readerAiStagedChanges,
      readerAiStagedChangesInvalid,
      readerAiStagedFileContents,
      readerAiSummary,
      readerAiToolLog,
    ],
  );

  useEffect(() => {
    const prevHistoryKey = readerAiPrevHistoryKeyRef.current;
    if (historyEligible && historyDocumentKey) {
      if (prevHistoryKey !== historyDocumentKey) {
        if (prevHistoryKey) flushPersistedReaderAiHistoryEntry(prevHistoryKey);
        readerAiSkipPersistHistoryKeyRef.current = historyDocumentKey;
        readerAiAbortRef.current?.abort();
        readerAiAbortRef.current = null;
        inlinePromptAbortRef.current?.abort();
        inlinePromptAbortRef.current = null;
        resetInlinePromptState();
        const loaded = loadReaderAiHistoryEntry(historyDocumentKey);
        const loadedSelectionState = createReaderAiSelectionStateFromHistoryEntry(loaded);
        applyReaderAiSessionSnapshot(
          createReaderAiSessionSnapshotFromHistory({
            loaded,
            proposalStatusesByToolCallId: getReaderAiProposalStatusesFromHistoryEntry(loaded),
            selectedChangeIds: loadedSelectionState.selectedChangeIds,
            selectedHunkIdsByChangeId: loadedSelectionState.selectedHunkIdsByChangeId,
          }),
        );
      }
      readerAiPrevHistoryKeyRef.current = historyDocumentKey;
      return;
    }
    if (prevHistoryKey) flushPersistedReaderAiHistoryEntry(prevHistoryKey);
    readerAiPrevHistoryKeyRef.current = null;
    readerAiAbortRef.current?.abort();
    readerAiAbortRef.current = null;
    inlinePromptAbortRef.current?.abort();
    inlinePromptAbortRef.current = null;
    resetInlinePromptState();
    applyReaderAiSessionSnapshot(createEmptyReaderAiSessionSnapshot());
  }, [applyReaderAiSessionSnapshot, historyDocumentKey, historyEligible, inlinePromptAbortRef, resetInlinePromptState]);

  useEffect(() => {
    if (!historyEligible || !historyDocumentKey) return;
    if (readerAiSkipPersistHistoryKeyRef.current === historyDocumentKey) {
      readerAiSkipPersistHistoryKeyRef.current = null;
      return;
    }
    schedulePersistReaderAiHistoryEntry(historyDocumentKey, persistedReaderAiHistoryEntry);
  }, [historyDocumentKey, historyEligible, persistedReaderAiHistoryEntry]);

  useEffect(() => {
    if (!historyEligible || !historyDocumentKey) return;
    if (readerAiSending || readerAiApplyingChanges) return;
    flushPersistedReaderAiHistoryEntry(historyDocumentKey);
  }, [historyDocumentKey, historyEligible, readerAiApplyingChanges, readerAiSending]);

  useEffect(() => {
    return () => {
      if (historyDocumentKey) flushPersistedReaderAiHistoryEntry(historyDocumentKey);
      readerAiAbortRef.current?.abort();
      readerAiAbortRef.current = null;
      inlinePromptAbortRef.current?.abort();
      inlinePromptAbortRef.current = null;
    };
  }, [historyDocumentKey, inlinePromptAbortRef]);

  const stopReaderAi = useCallback(() => {
    const activeRunId = readerAiCurrentRunIdRef.current;
    if (activeRunId) {
      updateReaderAiRun(activeRunId, (run) => ({
        ...run,
        status: 'aborted',
        completedAt: new Date().toISOString(),
      }));
    }
    readerAiAbortRef.current?.abort();
    readerAiAbortRef.current = null;
    readerAiCurrentRunIdRef.current = null;
    setReaderAiTranscript((current) => {
      const lastIndex = current.length - 1;
      if (lastIndex < 0) return current;
      const last = current[lastIndex];
      if (last.kind !== 'assistant_turn' || last.status !== 'streaming') return current;
      if (!last.content.trim()) return current.slice(0, -1);
      const next = [...current];
      next[lastIndex] = { ...last, status: 'aborted' };
      return next;
    });
    setReaderAiSending(false);
    setReaderAiToolStatus(null);
  }, [updateReaderAiRun]);

  const clearReaderAi = useCallback(() => {
    if (historyDocumentKey) clearPersistedReaderAiHistoryEntry(historyDocumentKey);
    readerAiAbortRef.current?.abort();
    readerAiAbortRef.current = null;
    inlinePromptAbortRef.current?.abort();
    inlinePromptAbortRef.current = null;
    resetInlinePromptState();
    applyReaderAiSessionSnapshot(createEmptyReaderAiSessionSnapshot());
  }, [applyReaderAiSessionSnapshot, historyDocumentKey, inlinePromptAbortRef, resetInlinePromptState]);

  const rewindReaderAiConversation = useCallback(
    (messages: ReaderAiMessage[]) => {
      readerAiAbortRef.current?.abort();
      readerAiAbortRef.current = null;
      inlinePromptAbortRef.current?.abort();
      inlinePromptAbortRef.current = null;
      readerAiSummaryRef.current = '';
      readerAiConversationScopeRef.current = null;
      readerAiEditProposalsRef.current = [];
      readerAiSelectedChangeIdsRef.current = new Set();
      readerAiSelectedHunkIdsByChangeIdRef.current = {};
      readerAiStagedChangesRef.current = [];
      readerAiStagedFileContentsRef.current = {};
      readerAiDocumentEditedContentRef.current = null;
      resetInlinePromptState();
      setReaderAiMessages(messages);
      setReaderAiTranscript((current) => reconcileReaderAiTranscriptWithMessages(current, messages));
      setReaderAiQueuedCommands([]);
      setReaderAiSummary('');
      setReaderAiConversationScope(null);
      setReaderAiSending(false);
      setReaderAiToolStatus(null);
      setReaderAiToolLog([]);
      setReaderAiError(null);
      setReaderAiEditProposals([]);
      setReaderAiProposalStatusesByToolCallId({});
      setReaderAiStagedChanges([]);
      setReaderAiSelectedChangeIds(new Set());
      setReaderAiSelectedHunkIdsByChangeId({});
      setReaderAiStagedChangesInvalid(false);
      setReaderAiStagedFileContents({});
      setReaderAiDocumentEditedContent(null);
      setReaderAiApplyingChanges(false);
      setReaderAiRuns([]);
      setReaderAiActiveRunId(null);
      setReaderAiChangeSets([]);
      setReaderAiActiveChangeSetId(null);
      readerAiCurrentRunIdRef.current = null;
    },
    [inlinePromptAbortRef, resetInlinePromptState],
  );

  const enqueueReaderAiQueuedCommand = useCallback((command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return false;
    let added = false;
    setReaderAiQueuedCommands((current) => {
      if (current.length >= 10) return current;
      added = true;
      return [...current, trimmed];
    });
    return added;
  }, []);

  const removeReaderAiQueuedCommand = useCallback((index: number) => {
    setReaderAiQueuedCommands((current) => current.filter((_, commandIndex) => commandIndex !== index));
  }, []);

  const clearReaderAiQueuedCommands = useCallback(() => {
    setReaderAiQueuedCommands([]);
  }, []);

  const prependReaderAiQueuedCommands = useCallback((commands: string[]) => {
    const normalized = commands.map((command) => command.trim()).filter(Boolean);
    if (normalized.length === 0) return;
    setReaderAiQueuedCommands((current) => [...normalized, ...current].slice(0, 10));
  }, []);

  const createReaderAiEditorRestorePoint = useCallback(
    (options: {
      path: string;
      content: string;
      appliedContent?: string | null;
      revision: number;
      selection?: { anchor: number; head: number } | null;
      scrollTop?: number | null;
      changeSetId?: string | null;
    }) => {
      const checkpoint = createReaderAiEditorCheckpoint(options);
      setReaderAiEditorCheckpoints((current) => appendReaderAiEditorCheckpoint(current, checkpoint));
      setReaderAiActiveEditorCheckpointId(checkpoint.id);
      return checkpoint;
    },
    [],
  );

  const activateReaderAiEditorRestorePoint = useCallback((checkpointId: string) => {
    setReaderAiEditorCheckpoints((current) => activateReaderAiEditorCheckpoint(current, checkpointId));
    setReaderAiActiveEditorCheckpointId(checkpointId);
  }, []);

  const clearReaderAiUndoState = useCallback(
    (status: ReaderAiEditorCheckpoint['status'] = 'discarded') => {
      if (!readerAiActiveEditorCheckpointId) return;
      setReaderAiEditorCheckpoints((current) =>
        updateReaderAiEditorCheckpointStatus(current, readerAiActiveEditorCheckpointId, status),
      );
      setReaderAiActiveEditorCheckpointId(null);
    },
    [readerAiActiveEditorCheckpointId],
  );

  const markReaderAiActiveChangeSetApplying = useCallback(() => {
    updateReaderAiActiveChangeSet((changeSet) => ({
      ...changeSet,
      status: 'applying',
      failedPaths: [],
    }));
  }, [updateReaderAiActiveChangeSet]);

  const finalizeReaderAiActiveChangeSet = useCallback(
    (options: {
      appliedPaths?: string[];
      failedPaths?: ReaderAiChangeSetFailure[];
      conflict?: boolean;
      clearActive?: boolean;
      stalePaths?: string[];
    }) => {
      const appliedPaths = options.appliedPaths ?? [];
      const failedPaths = options.failedPaths ?? [];
      updateReaderAiActiveChangeSet((changeSet) => ({
        ...markReaderAiChangeSetFileStatuses(changeSet, {
          appliedPaths,
          failedPaths,
          stalePaths: options.stalePaths,
          ...(options.conflict
            ? {
                conflictPaths:
                  changeSet.files.length > 0
                    ? changeSet.files.map((file) => file.path)
                    : changeSet.stagedChanges.map((change) => change.path),
              }
            : {}),
        }),
        status: options.conflict
          ? 'conflicted'
          : (options.stalePaths?.length ?? 0) > 0
            ? 'conflicted'
            : failedPaths.length > 0 && appliedPaths.length > 0
              ? 'partial'
              : failedPaths.length > 0
                ? 'failed'
                : 'applied',
        appliedPaths: Array.from(new Set([...changeSet.appliedPaths, ...appliedPaths])),
        failedPaths,
      }));
      if (options.clearActive && failedPaths.length === 0 && !options.conflict) {
        setReaderAiActiveChangeSetId(null);
      }
    },
    [updateReaderAiActiveChangeSet],
  );

  const buildReaderAiRetryRequest = useCallback((): ReaderAiRetryRequest | null => {
    return buildReaderAiRetryRequestFromRuns(readerAiRuns);
  }, [readerAiRuns]);

  const recordReaderAiAppliedChanges = useCallback(
    (paths: string[], changeTypeByPath: ReadonlyMap<string, 'edit' | 'create' | 'delete'>) => {
      if (paths.length === 0) return;
      const appliedAt = new Date().toISOString();
      setReaderAiAppliedChanges((current) => {
        const next = [
          ...current,
          ...paths.map((path) => ({
            path,
            type: changeTypeByPath.get(path) ?? 'edit',
            appliedAt,
          })),
        ];
        return next.slice(-100);
      });
    },
    [],
  );

  const resetReaderAiStagedState = useCallback(
    (options?: { clearError?: boolean; preserveEditorCheckpoint?: boolean }) => {
      readerAiEditProposalsRef.current = [];
      readerAiSelectedChangeIdsRef.current = new Set();
      readerAiSelectedHunkIdsByChangeIdRef.current = {};
      readerAiStagedChangesRef.current = [];
      readerAiStagedFileContentsRef.current = {};
      readerAiDocumentEditedContentRef.current = null;
      setReaderAiEditProposals([]);
      setReaderAiProposalStatusesByToolCallId({});
      setReaderAiStagedChanges([]);
      setReaderAiSelectedChangeIds(new Set());
      setReaderAiSelectedHunkIdsByChangeId({});
      setReaderAiStagedChangesInvalid(false);
      setReaderAiStagedFileContents({});
      setReaderAiDocumentEditedContent(null);
      setReaderAiActiveChangeSetId(null);
      if (!options?.preserveEditorCheckpoint) {
        if (readerAiActiveEditorCheckpointId) {
          setReaderAiEditorCheckpoints((current) =>
            updateReaderAiEditorCheckpointStatus(current, readerAiActiveEditorCheckpointId, 'discarded'),
          );
        }
        setReaderAiActiveEditorCheckpointId(null);
      }
      if (options?.clearError) setReaderAiError(null);
    },
    [readerAiActiveEditorCheckpointId],
  );

  const resetReaderAiProposalsForRetry = useCallback(() => {
    const activeChangeSetId = readerAiActiveChangeSetId;
    readerAiEditProposalsRef.current = [];
    readerAiSelectedChangeIdsRef.current = new Set();
    readerAiSelectedHunkIdsByChangeIdRef.current = {};
    readerAiStagedChangesRef.current = [];
    readerAiStagedFileContentsRef.current = {};
    readerAiDocumentEditedContentRef.current = null;
    setReaderAiEditProposals([]);
    setReaderAiProposalStatusesByToolCallId({});
    setReaderAiStagedChanges([]);
    setReaderAiSelectedChangeIds(new Set());
    setReaderAiSelectedHunkIdsByChangeId({});
    setReaderAiStagedChangesInvalid(false);
    setReaderAiStagedFileContents({});
    setReaderAiDocumentEditedContent(null);
    if (activeChangeSetId) {
      setReaderAiChangeSets((current) =>
        current.map((changeSet) =>
          changeSet.id !== activeChangeSetId
            ? changeSet
            : {
                ...changeSet,
                updatedAt: new Date().toISOString(),
                status: 'superseded',
                editProposals: [],
                proposalStatusesByToolCallId: {},
                stagedChanges: [],
                stagedFileContents: {},
                documentEditedContent: null,
                files: [],
                failedPaths: [],
              },
        ),
      );
    }
    setReaderAiActiveChangeSetId(null);
    setReaderAiError(null);
  }, [readerAiActiveChangeSetId]);

  const pruneAppliedReaderAiPaths = useCallback(
    (appliedPaths: string[], options?: PruneAppliedReaderAiPathsOptions) => {
      if (appliedPaths.length === 0) return;
      const appliedPathSet = new Set(appliedPaths);
      const remainingStagedChanges = readerAiStagedChangesRef.current.filter(
        (change) => !appliedPathSet.has(change.path),
      );
      const appliedChangeIds = new Set(
        readerAiStagedChangesRef.current
          .filter((change) => change.id && appliedPathSet.has(change.path))
          .map((change) => change.id as string),
      );
      setReaderAiEditProposals((current) => current.filter((proposal) => !appliedPathSet.has(proposal.change.path)));
      setReaderAiStagedChanges((current) => current.filter((change) => !appliedPathSet.has(change.path)));
      setReaderAiSelectedChangeIds((current) => {
        const next = new Set(current);
        for (const changeId of appliedChangeIds) next.delete(changeId);
        return next;
      });
      setReaderAiSelectedHunkIdsByChangeId((current) => {
        const next = { ...current };
        for (const changeId of appliedChangeIds) delete next[changeId];
        return next;
      });
      setReaderAiStagedFileContents((current) => {
        const next = { ...current };
        for (const path of appliedPathSet) delete next[path];
        return next;
      });
      if (options?.clearDocumentEditedContentPath && appliedPathSet.has(options.clearDocumentEditedContentPath)) {
        setReaderAiDocumentEditedContent(null);
      }
      updateReaderAiActiveChangeSet((changeSet) => ({
        ...markReaderAiChangeSetFileStatuses(changeSet, { appliedPaths }),
        status: remainingStagedChanges.length > 0 ? 'partial' : 'applied',
        editProposals: changeSet.editProposals.filter((proposal) => !appliedPathSet.has(proposal.change.path)),
        stagedChanges: changeSet.stagedChanges.filter((change) => !appliedPathSet.has(change.path)),
        stagedFileContents: Object.fromEntries(
          Object.entries(changeSet.stagedFileContents).filter(([path]) => !appliedPathSet.has(path)),
        ),
        documentEditedContent:
          options?.clearDocumentEditedContentPath && appliedPathSet.has(options.clearDocumentEditedContentPath)
            ? null
            : changeSet.documentEditedContent,
        appliedPaths: Array.from(new Set([...changeSet.appliedPaths, ...appliedPaths])),
      }));
    },
    [updateReaderAiActiveChangeSet],
  );

  const repairReaderAiRemoteConflictPath = useCallback(
    (options: { path: string; currentContent: string | null }) => {
      if (options.currentContent === null) return false;
      const targetChange = readerAiStagedChangesRef.current.find((change) => change.path === options.path) ?? null;
      if (!targetChange) return false;
      const repairedChange = rebaseReaderAiChangeAgainstContent(targetChange, options.currentContent) ?? {
        ...targetChange,
        originalContent: options.currentContent,
      };
      const nextModifiedContent =
        repairedChange.type === 'delete'
          ? null
          : typeof repairedChange.modifiedContent === 'string'
            ? repairedChange.modifiedContent
            : (targetChange.modifiedContent ?? null);
      setReaderAiStagedChanges((current) =>
        current.map((change) =>
          change.path !== options.path
            ? change
            : {
                ...repairedChange,
                originalContent: options.currentContent,
                ...(nextModifiedContent !== null ? { modifiedContent: nextModifiedContent } : {}),
              },
        ),
      );
      if (nextModifiedContent !== null) {
        setReaderAiStagedFileContents((current) => ({
          ...current,
          [options.path]: nextModifiedContent,
        }));
      }
      updateReaderAiActiveChangeSet((changeSet) => ({
        ...markReaderAiChangeSetFileStatuses(changeSet, { stalePaths: [options.path] }),
        status: 'conflicted',
        stagedChanges: changeSet.stagedChanges.map((change) =>
          change.path !== options.path
            ? change
            : {
                ...repairedChange,
                originalContent: options.currentContent,
                ...(nextModifiedContent !== null ? { modifiedContent: nextModifiedContent } : {}),
              },
        ),
        stagedFileContents:
          nextModifiedContent !== null
            ? {
                ...changeSet.stagedFileContents,
                [options.path]: nextModifiedContent,
              }
            : changeSet.stagedFileContents,
      }));
      return true;
    },
    [updateReaderAiActiveChangeSet],
  );

  const ignoreAllReaderAiChanges = useCallback(() => {
    if (readerAiStagedChangesRef.current.length > 0) {
      appendReaderAiChangeSetDecision({
        action: 'discarded',
        changes: readerAiStagedChangesRef.current,
        selectedChangeIds: Array.from(readerAiSelectedChangeIdsRef.current),
        selectedHunkIdsByChangeId: Object.fromEntries(
          Object.entries(readerAiSelectedHunkIdsByChangeIdRef.current).map(([changeId, hunkIds]) => [
            changeId,
            Array.from(hunkIds),
          ]),
        ),
        stagedFileContents: readerAiStagedFileContentsRef.current,
        documentEditedContent: readerAiDocumentEditedContentRef.current,
      });
    }
    const toolCallIds = new Set(
      readerAiEditProposals
        .map((proposal) => proposal.toolCallId)
        .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
    );
    if (toolCallIds.size > 0) {
      setReaderAiProposalStatusesByToolCallId((currentStatuses) => {
        const nextStatuses = { ...currentStatuses };
        for (const toolCallId of toolCallIds) nextStatuses[toolCallId] = 'ignored';
        return nextStatuses;
      });
    }
    resetReaderAiStagedState({ clearError: true });
  }, [appendReaderAiChangeSetDecision, readerAiEditProposals, resetReaderAiStagedState]);

  const restoreReaderAiTranscriptChangeSet = useCallback(
    (item: Extract<ReaderAiTranscriptItem, { kind: 'change_set_decision' }>) => {
      const selectedChangeIds = new Set(item.selectedChangeIds ?? []);
      const selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId = Object.fromEntries(
        Object.entries(item.selectedHunkIdsByChangeId ?? {}).map(([changeId, hunkIds]) => [changeId, new Set(hunkIds)]),
      );
      const stagedFileContents =
        item.stagedFileContents && Object.keys(item.stagedFileContents).length > 0
          ? item.stagedFileContents
          : Object.fromEntries(
              item.changes
                .filter((change) => change.type !== 'delete' && typeof change.modifiedContent === 'string')
                .map((change) => [change.path, change.modifiedContent as string]),
            );
      const nextChangeSet = createReaderAiChangeSetRecord({
        runId: createReaderAiLedgerId('run'),
        stagedChanges: item.changes,
        stagedFileContents,
        documentEditedContent:
          typeof item.documentEditedContent === 'string' || item.documentEditedContent === null
            ? item.documentEditedContent
            : null,
        files: buildReaderAiChangeSetFileRecords({
          stagedChanges: item.changes,
          stagedFileContents,
        }),
      });
      setReaderAiEditProposals([]);
      setReaderAiProposalStatusesByToolCallId({});
      setReaderAiStagedChanges(item.changes);
      setReaderAiSelectedChangeIds(selectedChangeIds);
      setReaderAiSelectedHunkIdsByChangeId(selectedHunkIdsByChangeId);
      setReaderAiStagedChangesInvalid(false);
      setReaderAiStagedFileContents(stagedFileContents);
      setReaderAiDocumentEditedContent(nextChangeSet.documentEditedContent);
      setReaderAiError(null);
      setReaderAiActiveChangeSetId(nextChangeSet.id);
      setReaderAiChangeSets((current) => [...current, nextChangeSet]);
      markReaderAiPriorChangeSetsSuperseded(nextChangeSet.id);
    },
    [markReaderAiPriorChangeSetsSuperseded],
  );

  const toggleReaderAiChangeSelection = useCallback((changeId: string, selected: boolean) => {
    setReaderAiSelectedChangeIds((current) => {
      const next = new Set(current);
      if (selected) next.add(changeId);
      else next.delete(changeId);
      return next;
    });
  }, []);

  const toggleReaderAiHunkSelection = useCallback((changeId: string, hunkId: string, selected: boolean) => {
    setReaderAiSelectedHunkIdsByChangeId((current) => {
      const next = { ...current };
      const selectedHunks = new Set(next[changeId] ?? []);
      if (selected) selectedHunks.add(hunkId);
      else selectedHunks.delete(hunkId);
      next[changeId] = selectedHunks;
      return next;
    });
  }, []);

  const rejectReaderAiChange = useCallback((changeId: string) => {
    setReaderAiSelectedChangeIds((current) => {
      const next = new Set(current);
      next.delete(changeId);
      return next;
    });
    setReaderAiStagedChanges((current) => current.filter((change) => change.id !== changeId));
    setReaderAiSelectedHunkIdsByChangeId((current) => {
      const next = { ...current };
      delete next[changeId];
      return next;
    });
  }, []);

  const rejectReaderAiHunk = useCallback((changeId: string, hunkId: string) => {
    setReaderAiSelectedHunkIdsByChangeId((current) => {
      const next = { ...current };
      const selectedHunks = new Set(next[changeId] ?? []);
      selectedHunks.delete(hunkId);
      next[changeId] = selectedHunks;
      return next;
    });
  }, []);

  const resolveReaderAiStagedHunk = useCallback(
    (
      changeId: string,
      hunkId: string,
      options?: { markPathApplied?: boolean; syncDocumentEditedContent?: boolean },
    ) => {
      const localNext = resolveReaderAiStagedHunkState({
        stagedChanges: readerAiStagedChangesRef.current,
        selectedChangeIds: readerAiSelectedChangeIdsRef.current,
        selectedHunkIdsByChangeId: readerAiSelectedHunkIdsByChangeIdRef.current,
        stagedFileContents: readerAiStagedFileContentsRef.current,
        documentEditedContent: readerAiDocumentEditedContent,
        changeId,
        hunkId,
        syncDocumentEditedContent: options?.syncDocumentEditedContent,
      });
      if (!localNext.resolvedPath) return null;

      setReaderAiStagedChanges(localNext.stagedChanges);
      setReaderAiSelectedChangeIds(localNext.selectedChangeIds);
      setReaderAiSelectedHunkIdsByChangeId(localNext.selectedHunkIdsByChangeId);
      setReaderAiStagedFileContents(localNext.stagedFileContents);
      if (options?.syncDocumentEditedContent) {
        setReaderAiDocumentEditedContent(localNext.documentEditedContent);
      }

      updateReaderAiActiveChangeSet((changeSet) => {
        const changeSetNext = resolveReaderAiStagedHunkState({
          stagedChanges: changeSet.stagedChanges,
          selectedChangeIds: readerAiSelectedChangeIdsRef.current,
          selectedHunkIdsByChangeId: readerAiSelectedHunkIdsByChangeIdRef.current,
          stagedFileContents: changeSet.stagedFileContents,
          documentEditedContent: changeSet.documentEditedContent,
          changeId,
          hunkId,
          syncDocumentEditedContent: options?.syncDocumentEditedContent,
        });
        if (!changeSetNext.resolvedPath) return changeSet;

        const nextAppliedPaths =
          options?.markPathApplied && changeSetNext.remainingChange === null
            ? Array.from(new Set([...changeSet.appliedPaths, changeSetNext.resolvedPath]))
            : changeSet.appliedPaths;
        const nextFiles = buildReaderAiChangeSetFileRecords({
          stagedChanges: changeSetNext.stagedChanges,
          stagedFileContents: changeSetNext.stagedFileContents,
        });
        if (options?.markPathApplied && changeSetNext.remainingChange === null) {
          const previousFile = changeSet.files.find((file) => file.path === changeSetNext.resolvedPath) ?? null;
          nextFiles.push({
            ...(previousFile ?? {
              path: changeSetNext.resolvedPath,
              hasCompleteContent: true,
            }),
            path: changeSetNext.resolvedPath,
            status: 'applied',
            hasCompleteContent: previousFile?.hasCompleteContent ?? true,
          });
        }
        return {
          ...changeSet,
          status:
            changeSetNext.stagedChanges.length > 0
              ? nextAppliedPaths.length > 0
                ? 'partial'
                : 'ready'
              : nextAppliedPaths.length > 0
                ? 'applied'
                : 'draft',
          stagedChanges: changeSetNext.stagedChanges,
          stagedFileContents: changeSetNext.stagedFileContents,
          documentEditedContent: changeSetNext.documentEditedContent,
          files: nextFiles,
          failedPaths: changeSet.failedPaths.filter((entry) => entry.path !== changeSetNext.resolvedPath),
          appliedPaths: nextAppliedPaths,
        };
      });

      return {
        path: localNext.resolvedPath,
        fullyResolved: localNext.remainingChange === null,
        remainingChange: localNext.remainingChange,
      };
    },
    [readerAiDocumentEditedContent, updateReaderAiActiveChangeSet],
  );

  const startReaderAiStream = useCallback(
    async ({
      allowDocumentEdits,
      baseMessages,
      currentDocPath,
      documentSource,
      edited,
      modelId,
      parentRunId,
      retryStepId,
      selectedModel,
      selectionSource,
      showWarningToast,
    }: StartReaderAiStreamOptions) => {
      const assistantEdited = edited === true;
      const hasPendingDocumentProposal =
        allowDocumentEdits &&
        readerAiStagedChangesRef.current.length > 0 &&
        typeof readerAiDocumentEditedContentRef.current === 'string';
      const fallbackConversationScope = (() => {
        if (!allowDocumentEdits) return { kind: 'document' } as ReaderAiConversationScope;
        if (!selectionSource) return { kind: 'document' } as ReaderAiConversationScope;
        const sanitizedSelection = stripCriticMarkupComments(selectionSource);
        if (!sanitizedSelection.trim()) return { kind: 'document' } as ReaderAiConversationScope;
        return {
          kind: 'selection',
          source: sanitizedSelection,
        } satisfies ReaderAiConversationScope;
      })();
      const nextConversationScope = hasPendingDocumentProposal
        ? ({ kind: 'document' } as ReaderAiConversationScope)
        : (readerAiConversationScopeRef.current ?? fallbackConversationScope);
      const source = nextConversationScope.kind === 'selection' ? nextConversationScope.source : documentSource;
      if (!source.trim()) {
        showWarningToast('Reader AI needs document content before it can answer.');
        return false;
      }
      if (parentRunId && retryStepId) {
        updateReaderAiRun(parentRunId, (run) => markReaderAiRunStepRetryAttempt(run, retryStepId));
      }

      readerAiAbortRef.current?.abort();
      const controller = new AbortController();
      readerAiAbortRef.current = controller;
      const currentRun = createReaderAiRunRecord({
        modelId,
        baseMessages,
        scope: nextConversationScope,
        ...(parentRunId ? { parentRunId } : {}),
      });
      const initialAssistantTurnId = createReaderAiTranscriptId('assistant');
      readerAiCurrentRunIdRef.current = currentRun.id;
      setReaderAiRuns((current) => [...current, currentRun].slice(-12));
      setReaderAiActiveRunId(currentRun.id);
      if (readerAiConversationScopeRef.current === null || hasPendingDocumentProposal) {
        setReaderAiConversationScope(nextConversationScope);
      }
      setReaderAiMessages([
        ...baseMessages,
        assistantEdited ? { role: 'assistant', content: '', edited: true } : { role: 'assistant', content: '' },
      ]);
      setReaderAiTranscript((current) => [
        ...reconcileReaderAiTranscriptWithMessages(current, baseMessages),
        {
          id: initialAssistantTurnId,
          kind: 'assistant_turn',
          runId: currentRun.id,
          iteration: 0,
          content: '',
          ...(assistantEdited ? { edited: true } : {}),
          status: 'streaming',
        },
      ]);
      setReaderAiSending(true);
      setReaderAiToolStatus(null);
      setReaderAiToolLog([]);
      setReaderAiError(null);

      let received = false;
      let receivedStagedChanges = false;
      let currentAssistantTurnId: string | null = initialAssistantTurnId;
      let currentIteration = 0;
      let separateNextTurnOutput = false;
      let streamErrorMessage: string | null = null;
      let streamedResponseChars = 0;
      let activatedRunChangeSet = false;
      const sanitizedMessages = baseMessages.map((message) => ({
        role: message.role,
        content: stripCriticMarkupComments(message.content),
      }));
      const streamContextLog = buildReaderAiContextLogPayload({
        model: selectedModel,
        source,
        messages: sanitizedMessages,
        summary: readerAiSummaryRef.current || undefined,
        mode: 'default',
        currentDocPath,
      });
      let loggedReceiveStart = false;
      const logReceiveStart = (trigger: string) => {
        if (loggedReceiveStart) return;
        loggedReceiveStart = true;
        console.log('[reader-ai-context] stream started', { ...streamContextLog, trigger });
      };
      console.log('[reader-ai-context] sending request', streamContextLog);

      try {
        await askReaderAiStream(
          modelId,
          source,
          sanitizedMessages,
          {
            signal: controller.signal,
            allowDocumentEdits,
            onSummary: (summary) => setReaderAiSummary(summary),
            onToolCall: (event) => {
              logReceiveStart('tool_call');
              const labels: Record<string, string> = {
                read_document: 'Reading document…',
                search_document: 'Searching document…',
                propose_replace_region: 'Proposing region replacement…',
                propose_replace_matches: 'Proposing match replacement…',
                task: 'Running subagent…',
              };
              setReaderAiToolStatus(labels[event.name] ?? `Running ${event.name}…`);
              const argsObj = typeof event.arguments === 'object' ? event.arguments : undefined;
              const toolArguments =
                typeof event.arguments === 'string' ? event.arguments : argsObj ? JSON.stringify(argsObj) : undefined;
              const detail = (() => {
                if (!argsObj) return undefined;
                const argsRecord = argsObj as Record<string, unknown>;
                if (event.name === 'read_document') {
                  const startLine = typeof argsRecord.start_line === 'number' ? argsRecord.start_line : undefined;
                  const endLine = typeof argsRecord.end_line === 'number' ? argsRecord.end_line : undefined;
                  if (typeof startLine === 'number' && typeof endLine === 'number') {
                    return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
                  }
                  if (typeof startLine === 'number') return `from line ${startLine}`;
                  if (typeof endLine === 'number') return `through line ${endLine}`;
                  return undefined;
                }
                return (argsRecord.path as string | undefined) ?? (argsRecord.query as string | undefined);
              })();
              appendReaderAiTranscriptItem({
                id: createReaderAiTranscriptId('tool-call'),
                kind: 'tool_call',
                runId: currentRun.id,
                iteration: currentIteration,
                toolCallId: event.id ?? createReaderAiTranscriptId('tool'),
                name: event.name,
                ...(toolArguments ? { argumentsJson: toolArguments } : {}),
                ...(typeof detail === 'string' ? { detail } : {}),
                ...(event.name === 'task' && event.id ? { taskId: event.id } : {}),
              });
              setReaderAiToolLog((log) => [
                ...log,
                {
                  type: 'call',
                  id: event.id,
                  name: event.name,
                  detail: typeof detail === 'string' ? detail : undefined,
                  toolArguments,
                  taskId: event.name === 'task' ? event.id : undefined,
                },
              ]);
              updateReaderAiRun(currentRun.id, (run) => ({
                ...run,
                steps: [
                  ...run.steps.filter((step) => step.toolCallId !== event.id || step.status !== 'running'),
                  {
                    id: createReaderAiLedgerId('step'),
                    kind: event.name === 'task' ? 'task' : 'tool',
                    toolCallId: event.id,
                    taskId: event.name === 'task' ? event.id : undefined,
                    name: event.name,
                    status: 'running',
                    detail: typeof detail === 'string' ? detail : undefined,
                    args: toolArguments,
                    startedAt: new Date().toISOString(),
                    retryCount: 0,
                    maxRetries: 0,
                    retryable: false,
                    retryState: 'none',
                  },
                ],
              }));
            },
            onToolResult: (event) => {
              logReceiveStart('tool_result');
              setReaderAiToolStatus(null);
              const resultDetail = event.error
                ? event.preview && event.preview !== event.error
                  ? `${event.error} — ${event.preview}`
                  : event.error
                : event.preview;
              appendReaderAiTranscriptItem({
                id: createReaderAiTranscriptId('tool-result'),
                kind: 'tool_result',
                runId: currentRun.id,
                iteration: currentIteration,
                toolCallId: event.id ?? createReaderAiTranscriptId('tool'),
                name: event.name,
                ...(resultDetail ? { preview: resultDetail } : {}),
                ...(event.error ? { error: event.error } : {}),
                ...(event.errorCode ? { errorCode: event.errorCode } : {}),
                ...(event.name === 'task' && event.id ? { taskId: event.id } : {}),
              });
              const callStatus: ReaderAiToolLogEntry['callStatus'] = event.error ? 'rejected' : 'succeeded';
              setReaderAiToolLog((log) => [
                ...log.map((entry) =>
                  entry.type === 'call' && entry.id === event.id ? { ...entry, callStatus } : entry,
                ),
                {
                  type: 'result',
                  id: event.id,
                  name: event.name,
                  detail: resultDetail,
                  taskId: event.name === 'task' ? event.id : undefined,
                  taskStatus: event.error ? 'error' : event.name === 'task' ? 'completed' : undefined,
                  tone: event.error ? 'warning' : 'success',
                },
              ]);
              updateReaderAiRun(currentRun.id, (run) => ({
                ...run,
                steps: run.steps.map((step) =>
                  step.toolCallId !== event.id || step.status !== 'running'
                    ? step
                    : {
                        ...step,
                        ...classifyReaderAiStepRetryPolicy(step, {
                          error: event.error,
                          errorCode: event.errorCode,
                        }),
                        status: event.error ? 'failed' : 'completed',
                        detail: resultDetail,
                        error: event.error,
                        errorCode: event.errorCode,
                        finishedAt: new Date().toISOString(),
                      },
                ),
              }));
            },
            onEditProposal: (proposal) => {
              logReceiveStart('edit_proposal');
              if (!activatedRunChangeSet) {
                activatedRunChangeSet = true;
                setReaderAiEditProposals([]);
                setReaderAiProposalStatusesByToolCallId({});
                setReaderAiStagedChanges([]);
                setReaderAiSelectedChangeIds(new Set());
                setReaderAiSelectedHunkIdsByChangeId({});
                setReaderAiStagedChangesInvalid(false);
                setReaderAiStagedFileContents({});
                setReaderAiDocumentEditedContent(null);
              }
              ensureReaderAiActiveChangeSet(currentRun.id, (changeSet) => ({
                ...changeSet,
                status: changeSet.stagedChanges.length > 0 ? 'ready' : 'draft',
              }));
              setReaderAiEditProposals((current) => {
                const existing = current.find((entry) => entry.id === proposal.id);
                const finalStatus = existing?.status ?? proposal.status;
                if (proposal.toolCallId && (finalStatus === 'accepted' || finalStatus === 'rejected')) {
                  setReaderAiProposalStatusesByToolCallId((currentStatuses) =>
                    currentStatuses[proposal.toolCallId!]
                      ? currentStatuses
                      : {
                          ...currentStatuses,
                          [proposal.toolCallId!]: finalStatus,
                        },
                  );
                }
                const nextProposal: ReaderAiEditProposal = existing
                  ? {
                      ...proposal,
                      status: finalStatus,
                    }
                  : proposal;
                appendReaderAiTranscriptItem({
                  id: createReaderAiTranscriptId('proposal'),
                  kind: 'edit_proposal',
                  runId: currentRun.id,
                  iteration: currentIteration,
                  proposal: nextProposal,
                });
                return [...current.filter((entry) => entry.id !== proposal.id), nextProposal];
              });
            },
            onTaskProgress: (event) => {
              logReceiveStart('task_progress');
              const phaseLabel =
                event.phase === 'started'
                  ? 'Started'
                  : event.phase === 'iteration_start'
                    ? `Iteration ${event.iteration ?? '?'}`
                    : event.phase === 'tool_call'
                      ? 'Running tool'
                      : event.phase === 'tool_result'
                        ? 'Tool finished'
                        : event.phase === 'completed'
                          ? 'Completed'
                          : 'Error';
              const detail = event.detail ? `${phaseLabel}: ${event.detail}` : phaseLabel;
              setReaderAiToolStatus(detail);
              if (event.id) {
                appendReaderAiTranscriptItem({
                  id: createReaderAiTranscriptId('task-progress'),
                  kind: 'task_progress',
                  runId: currentRun.id,
                  iteration: currentIteration,
                  taskId: event.id,
                  phase: event.phase,
                  detail,
                });
              }
              setReaderAiToolLog((log) => [...log, { type: 'progress', name: 'task', detail, taskId: event.id }]);
              updateReaderAiRun(currentRun.id, (run) => ({
                ...run,
                steps:
                  event.id && (event.phase === 'completed' || event.phase === 'error')
                    ? run.steps.map((step) =>
                        step.taskId !== event.id || step.status !== 'running'
                          ? step
                          : {
                              ...step,
                              ...classifyReaderAiStepRetryPolicy(
                                step,
                                event.phase === 'error'
                                  ? {
                                      error: event.detail,
                                      errorCode: event.errorCode,
                                    }
                                  : undefined,
                              ),
                              status: event.phase === 'error' ? 'failed' : 'completed',
                              detail,
                              error: event.phase === 'error' ? event.detail : step.error,
                              errorCode: event.phase === 'error' ? event.errorCode : step.errorCode,
                              finishedAt: new Date().toISOString(),
                            },
                      )
                    : run.steps,
              }));
            },
            onStagedChanges: (changes, _suggestedCommitMessage, documentContent, fileContents) => {
              logReceiveStart('staged_changes');
              if (!activatedRunChangeSet) {
                activatedRunChangeSet = true;
                setReaderAiEditProposals([]);
                setReaderAiProposalStatusesByToolCallId({});
                setReaderAiSelectedChangeIds(new Set());
                setReaderAiSelectedHunkIdsByChangeId({});
              }
              receivedStagedChanges = changes.length > 0;
              const previousChangeIds = new Set(
                readerAiStagedChangesRef.current
                  .map((change) => change.id)
                  .filter((id): id is string => typeof id === 'string'),
              );
              const previousHunkIdsByChangeId = Object.fromEntries(
                readerAiStagedChangesRef.current
                  .filter((change) => change.id && Array.isArray(change.hunks))
                  .map((change) => [
                    change.id as string,
                    new Set(
                      (change.hunks ?? []).map((hunk) => hunk.id).filter((id): id is string => typeof id === 'string'),
                    ),
                  ]),
              );
              setReaderAiStagedChanges(changes);
              setReaderAiSelectedChangeIds(() => {
                const latestSelectedChangeIds = readerAiSelectedChangeIdsRef.current;
                const next = new Set<string>();
                for (const change of changes) {
                  if (!change.id) continue;
                  if (!previousChangeIds.has(change.id) || latestSelectedChangeIds.has(change.id)) next.add(change.id);
                }
                return next;
              });
              setReaderAiSelectedHunkIdsByChangeId(() => {
                const latestSelectedHunkIdsByChangeId = readerAiSelectedHunkIdsByChangeIdRef.current;
                const next: Record<string, Set<string>> = {};
                for (const change of changes) {
                  if (!change.id || !Array.isArray(change.hunks) || change.hunks.length === 0) continue;
                  const previousHunkIds = previousHunkIdsByChangeId[change.id] ?? new Set<string>();
                  const previousSelectedHunkIds = latestSelectedHunkIdsByChangeId[change.id] ?? new Set<string>();
                  next[change.id] = new Set(
                    change.hunks
                      .map((hunk) => hunk.id)
                      .filter((hunkId) => !previousHunkIds.has(hunkId) || previousSelectedHunkIds.has(hunkId)),
                  );
                }
                return next;
              });
              setReaderAiStagedChangesInvalid(false);
              setReaderAiStagedFileContents(() => {
                const next: Record<string, string> = {};
                const nextFileContents = fileContents ?? {};
                for (const change of changes) {
                  if (change.type === 'delete') continue;
                  const content = nextFileContents[change.path];
                  if (typeof content === 'string') next[change.path] = content;
                }
                return next;
              });
              setReaderAiDocumentEditedContent(typeof documentContent === 'string' ? documentContent : null);
              appendReaderAiTranscriptItem({
                id: createReaderAiTranscriptId('staged'),
                kind: 'staged_changes_snapshot',
                runId: currentRun.id,
                iteration: currentIteration,
                changes,
              });
              ensureReaderAiActiveChangeSet(currentRun.id, (changeSet) => ({
                ...changeSet,
                status: changes.length > 0 ? 'ready' : changeSet.status,
              }));
            },
            onTurnStart: (iteration) => {
              logReceiveStart('turn_start');
              currentIteration = iteration;
              if (iteration <= 0) return;
              currentAssistantTurnId = createReaderAiTranscriptId('assistant');
              appendReaderAiTranscriptItem({
                id: currentAssistantTurnId,
                kind: 'assistant_turn',
                runId: currentRun.id,
                iteration,
                content: '',
                ...(assistantEdited ? { edited: true } : {}),
                status: 'streaming',
              });
              if (!separateNextTurnOutput) return;
              setReaderAiMessages((current) => {
                if (current.length === 0) return current;
                const updated = [...current];
                const lastIndex = updated.length - 1;
                const last = updated[lastIndex];
                if (last.role !== 'assistant' || !last.content.trim()) return current;
                if (last.content.endsWith('\n\n')) return current;
                updated[lastIndex] = { ...last, content: `${last.content}\n\n` };
                return updated;
              });
              separateNextTurnOutput = false;
            },
            onTurnEnd: (iteration, reason) => {
              currentIteration = iteration;
              updateReaderAiTranscriptItem(currentAssistantTurnId, (item) =>
                item.kind !== 'assistant_turn'
                  ? item
                  : { ...item, status: reason === 'timeout' ? 'failed' : 'completed' },
              );
              if (reason === 'tool_calls') separateNextTurnOutput = true;
            },
            onStreamError: (message) => {
              logReceiveStart('stream_error');
              streamErrorMessage = message;
              setReaderAiError(message);
              appendReaderAiTranscriptItem({
                id: createReaderAiTranscriptId('error'),
                kind: 'error',
                runId: currentRun.id,
                iteration: currentIteration,
                message,
              });
            },
            onDelta: (delta) => {
              if (!delta) return;
              logReceiveStart('delta');
              received = true;
              streamedResponseChars += delta.length;
              if (!currentAssistantTurnId) {
                currentAssistantTurnId = createReaderAiTranscriptId('assistant');
                appendReaderAiTranscriptItem({
                  id: currentAssistantTurnId,
                  kind: 'assistant_turn',
                  runId: currentRun.id,
                  iteration: currentIteration,
                  content: '',
                  ...(assistantEdited ? { edited: true } : {}),
                  status: 'streaming',
                });
              }
              updateReaderAiTranscriptItem(currentAssistantTurnId, (item) =>
                item.kind !== 'assistant_turn' ? item : { ...item, content: `${item.content}${delta}` },
              );
              setReaderAiMessages((current) => {
                if (current.length === 0) {
                  return assistantEdited
                    ? [{ role: 'assistant', content: delta, edited: true }]
                    : [{ role: 'assistant', content: delta }];
                }
                const updated = [...current];
                const lastIndex = updated.length - 1;
                const last = updated[lastIndex];
                if (last.role !== 'assistant') {
                  updated.push(
                    assistantEdited
                      ? { role: 'assistant', content: delta, edited: true }
                      : { role: 'assistant', content: delta },
                  );
                  return updated;
                }
                updated[lastIndex] = { ...last, content: `${last.content}${delta}` };
                return updated;
              });
            },
          },
          readerAiSummary || undefined,
          currentDocPath,
          allowDocumentEdits,
        );
        console.log('[reader-ai-context] stream finished', {
          ...streamContextLog,
          status: 'completed',
          receivedResponseChars: streamedResponseChars,
          hadStagedChanges: receivedStagedChanges,
        });
        if (!received) {
          const fallback = streamErrorMessage
            ? streamErrorMessage
            : receivedStagedChanges
              ? 'Done — see the proposed changes above.'
              : modelId.trim().toLowerCase().endsWith(':free')
                ? 'No response. Using a free endpoint, consider trying a different model.'
                : 'No response.';
          updateReaderAiTranscriptItem(currentAssistantTurnId, (item) =>
            item.kind !== 'assistant_turn'
              ? item
              : {
                  ...item,
                  content: item.content.trim() ? item.content : fallback,
                  status: 'completed',
                },
          );
          setReaderAiMessages((current) => {
            if (current.length === 0) {
              return assistantEdited
                ? [{ role: 'assistant', content: fallback, edited: true }]
                : [{ role: 'assistant', content: fallback }];
            }
            const updated = [...current];
            const lastIndex = updated.length - 1;
            const last = updated[lastIndex];
            if (last.role !== 'assistant') {
              updated.push(
                assistantEdited
                  ? { role: 'assistant', content: fallback, edited: true }
                  : { role: 'assistant', content: fallback },
              );
              return updated;
            }
            if (!last.content.trim()) updated[lastIndex] = { ...last, content: fallback };
            return updated;
          });
        }
        updateReaderAiTranscriptItem(currentAssistantTurnId, (item) =>
          item.kind !== 'assistant_turn' || item.status !== 'streaming' ? item : { ...item, status: 'completed' },
        );

        updateReaderAiRun(currentRun.id, (run) => ({
          ...run,
          status: 'completed',
          completedAt: new Date().toISOString(),
          error: undefined,
        }));
        if (parentRunId && retryStepId) {
          updateReaderAiRun(parentRunId, (run) => completeReaderAiRunStepRetry(run, retryStepId, true));
        }

        return true;
      } catch (err) {
        console.log('[reader-ai-context] stream finished', {
          ...streamContextLog,
          status: err instanceof DOMException && err.name === 'AbortError' ? 'aborted' : 'errored',
          error: err instanceof Error ? err.message : String(err),
          receivedResponseChars: streamedResponseChars,
        });
        setReaderAiMessages((current) => {
          if (current.length === 0) return current;
          const last = current[current.length - 1];
          if (last.role === 'assistant' && !last.content.trim()) return current.slice(0, -1);
          return current;
        });
        setReaderAiTranscript((current) => {
          const itemId = currentAssistantTurnId;
          if (!itemId) return current;
          return current.flatMap((item) => {
            if (item.id !== itemId || item.kind !== 'assistant_turn') return [item];
            if (!item.content.trim()) return [];
            return [
              {
                ...item,
                status:
                  err instanceof DOMException && err.name === 'AbortError' ? ('aborted' as const) : ('failed' as const),
              },
            ];
          });
        });
        updateReaderAiRun(currentRun.id, (run) => ({
          ...run,
          status: err instanceof DOMException && err.name === 'AbortError' ? 'aborted' : 'failed',
          completedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : 'Reader AI request failed',
        }));
        if (parentRunId && retryStepId) {
          updateReaderAiRun(parentRunId, (run) => completeReaderAiRunStepRetry(run, retryStepId, false));
        }
        if (err instanceof DOMException && err.name === 'AbortError') return true;
        setReaderAiError(err instanceof Error ? err.message : 'Reader AI request failed');
        return false;
      } finally {
        if (readerAiAbortRef.current === controller) readerAiAbortRef.current = null;
        if (readerAiCurrentRunIdRef.current === currentRun.id) readerAiCurrentRunIdRef.current = null;
        setReaderAiSending(false);
        setReaderAiToolStatus(null);
      }
    },
    [
      appendReaderAiTranscriptItem,
      ensureReaderAiActiveChangeSet,
      readerAiSummary,
      updateReaderAiTranscriptItem,
      updateReaderAiRun,
    ],
  );

  return {
    activateReaderAiEditorRestorePoint,
    buildReaderAiRetryRequest,
    clearReaderAiQueuedCommands,
    clearReaderAi,
    clearReaderAiUndoState,
    createReaderAiEditorRestorePoint,
    effectiveReaderAiStagedChanges,
    effectiveReaderAiStagedFileContents,
    enqueueReaderAiQueuedCommand,
    finalizeReaderAiActiveChangeSet,
    ignoreAllReaderAiChanges,
    markReaderAiActiveChangeSetApplying,
    prependReaderAiQueuedCommands,
    pruneAppliedReaderAiPaths,
    repairReaderAiRemoteConflictPath,
    readerAiActiveChangeSet,
    readerAiActiveRunId,
    readerAiApplyingChanges,
    readerAiConversationScope,
    readerAiChangeSets,
    readerAiDocumentEditedContent,
    readerAiEditorCheckpoints,
    readerAiEditProposals,
    readerAiError,
    readerAiHasEligibleSelection,
    readerAiMessages,
    readerAiQueuedCommands,
    readerAiProposalStatusesByToolCallId,
    readerAiSelectedChangeIds,
    readerAiSelectedHunkIdsByChangeId,
    readerAiSending,
    readerAiStagedChangesInvalid,
    readerAiStagedChangesStreaming,
    readerAiRuns,
    readerAiTranscript,
    readerAiToolLog,
    readerAiToolStatus,
    readerAiActiveEditorCheckpoint,
    rejectReaderAiChange,
    rejectReaderAiHunk,
    removeReaderAiQueuedCommand,
    recordReaderAiAppliedChanges,
    readerAiStagedChanges,
    resetReaderAiProposalsForRetry,
    rewindReaderAiConversation,
    restoreReaderAiTranscriptChangeSet,
    resetReaderAiStagedState,
    resolveReaderAiStagedHunk,
    setReaderAiAppliedChanges,
    setReaderAiApplyingChanges,
    setReaderAiDocumentEditedContent,
    setReaderAiEditProposals,
    setReaderAiError,
    setReaderAiHasEligibleSelection,
    setReaderAiSelectedChangeIds,
    setReaderAiSelectedHunkIdsByChangeId,
    setReaderAiStagedChanges,
    setReaderAiStagedFileContents,
    startReaderAiStream,
    stopReaderAi,
    toggleReaderAiChangeSelection,
    toggleReaderAiHunkSelection,
  };
}
