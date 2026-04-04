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
  type ReaderAiUndoState,
} from '../reader_ai_controller';
import {
  buildReaderAiHistoryDocumentKey,
  clearReaderAiHistoryEntry,
  createReaderAiSelectionStateFromHistoryEntry,
  getReaderAiProposalStatusesFromHistoryEntry,
  loadReaderAiHistoryEntry,
  persistReaderAiHistoryEntry,
} from '../reader_ai_history_store';
import {
  selectEffectiveReaderAiStagedChanges,
  selectEffectiveReaderAiStagedFileContents,
} from '../reader_ai_selectors';
import type { ReaderAiProposalToolCallStatus, ReaderAiSelectedHunkIdsByChangeId } from '../reader_ai_state';

export { buildReaderAiHistoryDocumentKey, type ReaderAiConversationScope, type ReaderAiUndoState };

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
  selectedModel: ReaderAiModel | null;
  selectionSource: string | null;
  showFailureToast: (message: string) => void;
}

interface PruneAppliedReaderAiPathsOptions {
  clearDocumentEditedContentPath?: string | null;
}

export function useReaderAiSession({
  historyEligible,
  historyDocumentKey,
  resetInlinePromptState,
  inlinePromptAbortRef,
}: UseReaderAiSessionOptions) {
  const [readerAiMessages, setReaderAiMessages] = useState<ReaderAiMessage[]>([]);
  const [readerAiSummary, setReaderAiSummary] = useState('');
  const [readerAiConversationScope, setReaderAiConversationScope] = useState<ReaderAiConversationScope | null>(null);
  const [readerAiHasEligibleSelection, setReaderAiHasEligibleSelection] = useState(false);
  const [readerAiSending, setReaderAiSending] = useState(false);
  const [readerAiToolStatus, setReaderAiToolStatus] = useState<string | null>(null);
  const [readerAiToolLog, setReaderAiToolLog] = useState<ReaderAiToolLogEntry[]>([]);
  const [readerAiEditProposals, setReaderAiEditProposals] = useState<ReaderAiEditProposal[]>([]);
  const [readerAiProposalStatusesByToolCallId, setReaderAiProposalStatusesByToolCallId] = useState<
    Record<string, ReaderAiProposalToolCallStatus>
  >({});
  const [readerAiStagedChanges, setReaderAiStagedChanges] = useState<ReaderAiStagedChange[]>([]);
  const [readerAiAppliedChanges, setReaderAiAppliedChanges] = useState<
    Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>
  >([]);
  const [readerAiUndoState, setReaderAiUndoState] = useState<ReaderAiUndoState | null>(null);
  const [readerAiStagedChangesInvalid, setReaderAiStagedChangesInvalid] = useState(false);
  const [readerAiStagedFileContents, setReaderAiStagedFileContents] = useState<Record<string, string>>({});
  const [readerAiDocumentEditedContent, setReaderAiDocumentEditedContent] = useState<string | null>(null);
  const [readerAiApplyingChanges, setReaderAiApplyingChanges] = useState(false);
  const [readerAiError, setReaderAiError] = useState<string | null>(null);
  const [readerAiSelectedChangeIds, setReaderAiSelectedChangeIds] = useState<Set<string>>(() => new Set());
  const [readerAiSelectedHunkIdsByChangeId, setReaderAiSelectedHunkIdsByChangeId] =
    useState<ReaderAiSelectedHunkIdsByChangeId>({});

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

  const readerAiAbortRef = useRef<AbortController | null>(null);
  const readerAiStagedChangesRef = useRef<ReaderAiStagedChange[]>(readerAiStagedChanges);
  const readerAiEditProposalsRef = useRef<ReaderAiEditProposal[]>(readerAiEditProposals);
  const readerAiSelectedChangeIdsRef = useRef<Set<string>>(readerAiSelectedChangeIds);
  const readerAiSelectedHunkIdsByChangeIdRef = useRef<ReaderAiSelectedHunkIdsByChangeId>(
    readerAiSelectedHunkIdsByChangeId,
  );
  const readerAiPrevHistoryKeyRef = useRef<string | null>(null);
  const readerAiSkipPersistHistoryKeyRef = useRef<string | null>(null);

  const applyReaderAiSessionSnapshot = useCallback((snapshot: ReaderAiSessionSnapshot) => {
    setReaderAiMessages(snapshot.messages);
    setReaderAiSummary(snapshot.summary);
    setReaderAiConversationScope(snapshot.scope);
    setReaderAiHasEligibleSelection(snapshot.hasEligibleSelection);
    setReaderAiSending(snapshot.sending);
    setReaderAiApplyingChanges(snapshot.applyingChanges);
    setReaderAiToolStatus(snapshot.toolStatus);
    setReaderAiToolLog(snapshot.toolLog);
    setReaderAiEditProposals(snapshot.editProposals);
    setReaderAiProposalStatusesByToolCallId(snapshot.proposalStatusesByToolCallId);
    setReaderAiStagedChanges(snapshot.stagedChanges);
    setReaderAiSelectedChangeIds(snapshot.selectedChangeIds);
    setReaderAiSelectedHunkIdsByChangeId(snapshot.selectedHunkIdsByChangeId);
    setReaderAiAppliedChanges(snapshot.appliedChanges);
    setReaderAiUndoState(snapshot.undoState);
    setReaderAiStagedChangesInvalid(snapshot.stagedChangesInvalid);
    setReaderAiStagedFileContents(snapshot.stagedFileContents);
    setReaderAiDocumentEditedContent(snapshot.documentEditedContent);
    setReaderAiError(snapshot.error);
  }, []);

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
    const prevHistoryKey = readerAiPrevHistoryKeyRef.current;
    if (historyEligible && historyDocumentKey) {
      if (prevHistoryKey !== historyDocumentKey) {
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
    persistReaderAiHistoryEntry(
      historyDocumentKey,
      createReaderAiHistoryEntryFromSessionSnapshot({
        messages: readerAiMessages,
        summary: readerAiSummary,
        scope: readerAiConversationScope,
        toolLog: readerAiToolLog,
        editProposals: readerAiEditProposals,
        proposalStatusesByToolCallId: readerAiProposalStatusesByToolCallId,
        stagedChanges: readerAiStagedChanges,
        stagedChangesInvalid: readerAiStagedChangesInvalid,
        stagedFileContents: readerAiStagedFileContents,
        appliedChanges: readerAiAppliedChanges,
      }),
    );
  }, [
    historyDocumentKey,
    historyEligible,
    readerAiAppliedChanges,
    readerAiConversationScope,
    readerAiEditProposals,
    readerAiMessages,
    readerAiProposalStatusesByToolCallId,
    readerAiStagedChanges,
    readerAiStagedChangesInvalid,
    readerAiStagedFileContents,
    readerAiSummary,
    readerAiToolLog,
  ]);

  useEffect(() => {
    return () => {
      readerAiAbortRef.current?.abort();
      readerAiAbortRef.current = null;
      inlinePromptAbortRef.current?.abort();
      inlinePromptAbortRef.current = null;
    };
  }, [inlinePromptAbortRef]);

  const stopReaderAi = useCallback(() => {
    readerAiAbortRef.current?.abort();
    readerAiAbortRef.current = null;
    setReaderAiSending(false);
    setReaderAiToolStatus(null);
  }, []);

  const clearReaderAi = useCallback(() => {
    if (historyDocumentKey) clearReaderAiHistoryEntry(historyDocumentKey);
    readerAiAbortRef.current?.abort();
    readerAiAbortRef.current = null;
    inlinePromptAbortRef.current?.abort();
    inlinePromptAbortRef.current = null;
    resetInlinePromptState();
    applyReaderAiSessionSnapshot(createEmptyReaderAiSessionSnapshot());
  }, [applyReaderAiSessionSnapshot, historyDocumentKey, inlinePromptAbortRef, resetInlinePromptState]);

  const clearReaderAiUndoState = useCallback(() => {
    setReaderAiUndoState(null);
  }, []);

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

  const resetReaderAiStagedState = useCallback((options?: { clearError?: boolean; preserveUndoState?: boolean }) => {
    setReaderAiEditProposals([]);
    setReaderAiStagedChanges([]);
    setReaderAiSelectedChangeIds(new Set());
    setReaderAiSelectedHunkIdsByChangeId({});
    setReaderAiStagedChangesInvalid(false);
    setReaderAiStagedFileContents({});
    setReaderAiDocumentEditedContent(null);
    if (!options?.preserveUndoState) setReaderAiUndoState(null);
    if (options?.clearError) setReaderAiError(null);
  }, []);

  const pruneAppliedReaderAiPaths = useCallback(
    (appliedPaths: string[], options?: PruneAppliedReaderAiPathsOptions) => {
      if (appliedPaths.length === 0) return;
      const appliedPathSet = new Set(appliedPaths);
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
    },
    [],
  );

  const ignoreAllReaderAiChanges = useCallback(() => {
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
  }, [readerAiEditProposals, resetReaderAiStagedState]);

  const acceptReaderAiProposal = useCallback((proposalId: string) => {
    setReaderAiEditProposals((current) => {
      const targetIndex = current.findIndex((proposal) => proposal.id === proposalId);
      if (targetIndex < 0) return current;
      const target = current[targetIndex];
      const acceptedToolCallIds = new Set(
        current
          .filter((proposal, index) => proposal.change.path === target.change.path && index <= targetIndex)
          .map((proposal) => proposal.toolCallId)
          .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
      );
      if (acceptedToolCallIds.size > 0) {
        setReaderAiProposalStatusesByToolCallId((currentStatuses) => {
          const nextStatuses = { ...currentStatuses };
          for (const toolCallId of acceptedToolCallIds) nextStatuses[toolCallId] = 'accepted';
          return nextStatuses;
        });
      }
      return current.map((proposal, index) =>
        proposal.change.path === target.change.path && index <= targetIndex
          ? { ...proposal, status: 'accepted' as const }
          : proposal,
      );
    });
  }, []);

  const rejectReaderAiProposal = useCallback((proposalId: string) => {
    setReaderAiEditProposals((current) => {
      const targetIndex = current.findIndex((proposal) => proposal.id === proposalId);
      if (targetIndex < 0) return current;
      const target = current[targetIndex];
      const rejectedToolCallIds = new Set(
        current
          .filter((proposal, index) => proposal.change.path === target.change.path && index >= targetIndex)
          .map((proposal) => proposal.toolCallId)
          .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
      );
      if (rejectedToolCallIds.size > 0) {
        setReaderAiProposalStatusesByToolCallId((currentStatuses) => {
          const nextStatuses = { ...currentStatuses };
          for (const toolCallId of rejectedToolCallIds) nextStatuses[toolCallId] = 'rejected';
          return nextStatuses;
        });
      }
      return current.map((proposal, index) =>
        proposal.change.path === target.change.path && index >= targetIndex
          ? { ...proposal, status: 'rejected' as const }
          : proposal,
      );
    });
  }, []);

  const toggleReaderAiProposalHunkSelection = useCallback((proposalId: string, hunkId: string, selected: boolean) => {
    setReaderAiEditProposals((current) =>
      current.map((proposal) => {
        if (proposal.id !== proposalId) return proposal;
        const selectedIds = new Set(proposal.selectedHunkIds ?? proposal.change.hunks?.map((hunk) => hunk.id) ?? []);
        if (selected) selectedIds.add(hunkId);
        else selectedIds.delete(hunkId);
        return { ...proposal, selectedHunkIds: Array.from(selectedIds) };
      }),
    );
  }, []);

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

  const startReaderAiStream = useCallback(
    async ({
      allowDocumentEdits,
      baseMessages,
      currentDocPath,
      documentSource,
      edited,
      modelId,
      selectedModel,
      selectionSource,
      showFailureToast,
    }: StartReaderAiStreamOptions) => {
      const assistantEdited = edited === true;
      const nextConversationScope =
        readerAiConversationScope ??
        (() => {
          if (!allowDocumentEdits) return { kind: 'document' } as ReaderAiConversationScope;
          if (!selectionSource) return { kind: 'document' } as ReaderAiConversationScope;
          const sanitizedSelection = stripCriticMarkupComments(selectionSource);
          if (!sanitizedSelection.trim()) return { kind: 'document' } as ReaderAiConversationScope;
          return {
            kind: 'selection',
            source: sanitizedSelection,
          } satisfies ReaderAiConversationScope;
        })();
      const source = nextConversationScope.kind === 'selection' ? nextConversationScope.source : documentSource;
      if (!source.trim()) {
        showFailureToast('Reader AI needs document content before it can answer.');
        return false;
      }

      readerAiAbortRef.current?.abort();
      const controller = new AbortController();
      readerAiAbortRef.current = controller;
      if (readerAiConversationScope === null) {
        setReaderAiConversationScope(nextConversationScope);
      }
      setReaderAiMessages([
        ...baseMessages,
        assistantEdited ? { role: 'assistant', content: '', edited: true } : { role: 'assistant', content: '' },
      ]);
      setReaderAiSending(true);
      setReaderAiToolStatus(null);
      setReaderAiToolLog([]);
      setReaderAiEditProposals([]);
      setReaderAiProposalStatusesByToolCallId({});
      setReaderAiStagedChanges([]);
      setReaderAiSelectedChangeIds(new Set());
      setReaderAiSelectedHunkIdsByChangeId({});
      setReaderAiUndoState(null);
      setReaderAiStagedChangesInvalid(false);
      setReaderAiStagedFileContents({});
      setReaderAiDocumentEditedContent(null);
      setReaderAiError(null);

      let received = false;
      let receivedStagedChanges = false;
      let separateNextTurnOutput = false;
      let streamErrorMessage: string | null = null;
      let streamedResponseChars = 0;
      const sanitizedMessages = baseMessages.map((message) => ({
        role: message.role,
        content: stripCriticMarkupComments(message.content),
      }));
      const streamContextLog = buildReaderAiContextLogPayload({
        model: selectedModel,
        source,
        messages: sanitizedMessages,
        summary: readerAiSummary || undefined,
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
                propose_edit_document: 'Proposing document edit…',
                task: 'Running subagent…',
              };
              setReaderAiToolStatus(labels[event.name] ?? `Running ${event.name}…`);
              const argsObj = typeof event.arguments === 'object' ? event.arguments : undefined;
              const detail = argsObj
                ? (((argsObj as Record<string, unknown>).path as string | undefined) ??
                  ((argsObj as Record<string, unknown>).query as string | undefined))
                : undefined;
              setReaderAiToolLog((log) => [
                ...log,
                {
                  type: 'call',
                  id: event.id,
                  name: event.name,
                  detail: typeof detail === 'string' ? detail : undefined,
                  taskId: event.name === 'task' ? event.id : undefined,
                },
              ]);
            },
            onToolResult: (event) => {
              logReceiveStart('tool_result');
              setReaderAiToolStatus(null);
              setReaderAiToolLog((log) => [
                ...log,
                {
                  type: 'result',
                  id: event.id,
                  name: event.name,
                  detail: event.error ? `${event.error}${event.preview ? ` — ${event.preview}` : ''}` : event.preview,
                  taskId: event.name === 'task' ? event.id : undefined,
                  taskStatus: event.error ? 'error' : event.name === 'task' ? 'completed' : undefined,
                },
              ]);
            },
            onEditProposal: (proposal) => {
              logReceiveStart('edit_proposal');
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
                      selectedHunkIds: existing.selectedHunkIds ?? proposal.selectedHunkIds,
                    }
                  : proposal;
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
              setReaderAiToolLog((log) => [...log, { type: 'progress', name: 'task', detail, taskId: event.id }]);
            },
            onStagedChanges: (changes, _suggestedCommitMessage, documentContent, fileContents) => {
              logReceiveStart('staged_changes');
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
            },
            onTurnStart: (iteration) => {
              logReceiveStart('turn_start');
              if (iteration <= 0 || !separateNextTurnOutput) return;
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
            onTurnEnd: (_iteration, reason) => {
              if (reason === 'tool_calls') separateNextTurnOutput = true;
            },
            onStreamError: (message) => {
              logReceiveStart('stream_error');
              streamErrorMessage = message;
              setReaderAiError(message);
            },
            onDelta: (delta) => {
              if (!delta) return;
              logReceiveStart('delta');
              received = true;
              streamedResponseChars += delta.length;
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
        if (err instanceof DOMException && err.name === 'AbortError') return true;
        setReaderAiError(err instanceof Error ? err.message : 'Reader AI request failed');
        return false;
      } finally {
        if (readerAiAbortRef.current === controller) readerAiAbortRef.current = null;
        setReaderAiSending(false);
        setReaderAiToolStatus(null);
      }
    },
    [readerAiConversationScope, readerAiSummary],
  );

  return {
    acceptReaderAiProposal,
    clearReaderAi,
    clearReaderAiUndoState,
    effectiveReaderAiStagedChanges,
    effectiveReaderAiStagedFileContents,
    ignoreAllReaderAiChanges,
    pruneAppliedReaderAiPaths,
    readerAiApplyingChanges,
    readerAiConversationScope,
    readerAiDocumentEditedContent,
    readerAiEditProposals,
    readerAiError,
    readerAiHasEligibleSelection,
    readerAiMessages,
    readerAiProposalStatusesByToolCallId,
    readerAiSelectedChangeIds,
    readerAiSelectedHunkIdsByChangeId,
    readerAiSending,
    readerAiStagedChangesInvalid,
    readerAiStagedChangesStreaming,
    readerAiToolLog,
    readerAiToolStatus,
    readerAiUndoState,
    rejectReaderAiChange,
    rejectReaderAiHunk,
    rejectReaderAiProposal,
    recordReaderAiAppliedChanges,
    resetReaderAiStagedState,
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
    setReaderAiUndoState,
    startReaderAiStream,
    stopReaderAi,
    toggleReaderAiChangeSelection,
    toggleReaderAiHunkSelection,
    toggleReaderAiProposalHunkSelection,
  };
}
