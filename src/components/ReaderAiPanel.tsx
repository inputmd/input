import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeft, ArrowRight, CircleStop, MoreHorizontal, Pencil, X } from 'lucide-react';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils';
import { matchesPrimaryShortcut } from '../keyboard_shortcuts';
import { parseMarkdownToHtml } from '../markdown';
import type { ReaderAiEditProposal, ReaderAiStagedChange } from '../reader_ai';
import type { ReaderAiRunRecord } from '../reader_ai_ledger';
import type { ReaderAiProposalToolCallStatus } from '../reader_ai_state';
import type { ReaderAiTranscriptItem } from '../reader_ai_transcript';
import { copyTextToClipboard } from '../util';
import { ReaderAiRunHistorySection } from './ReaderAiRunHistory';
import { StagedChangesSection } from './ReaderAiStagedChanges';
import type { ReaderAiToolLogEntry } from './ReaderAiToolLog';

export type { ReaderAiToolLogEntry } from './ReaderAiToolLog';

type ReaderAiPanelView = 'chat' | 'history';

interface ReaderAiEditorCheckpointWidget {
  status: 'active' | 'restored';
  canRestore: boolean;
  canReapply: boolean;
}

export interface ReaderAiMessage {
  role: 'user' | 'assistant';
  content: string;
  edited?: boolean;
}

interface ReaderAiPanelProps {
  className?: string;
  visible?: boolean;
  activationRequestKey?: number;
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModel: string;
  messages: ReaderAiMessage[];
  transcript: ReaderAiTranscriptItem[];
  runs: ReaderAiRunRecord[];
  queuedCommands: string[];
  sending: boolean;
  toolStatus: string | null;
  toolLog: ReaderAiToolLogEntry[];
  proposalStatusesByToolCallId: Record<string, ReaderAiProposalToolCallStatus>;
  editProposals: ReaderAiEditProposal[];
  stagedChanges: ReaderAiStagedChange[];
  stagedChangesStreaming?: boolean;
  applyingChanges: boolean;
  canApplyWithoutSaving: boolean;
  applyDisabledReasonLabel?: string | null;
  editorProposalMode?: boolean;
  canUndoEditorApply?: boolean;
  editorCheckpoint?: ReaderAiEditorCheckpointWidget | null;
  onApplyWithoutSaving: () => void;
  onUndoEditorApply?: () => void;
  onReapplyEditorApply?: () => void;
  onRestoreTranscriptChangeSet?: (item: Extract<ReaderAiTranscriptItem, { kind: 'change_set_decision' }>) => void;
  onIgnoreAll?: () => void;
  onToggleChangeSelection?: (changeId: string, selected: boolean) => void;
  onToggleHunkSelection?: (changeId: string, hunkId: string, selected: boolean) => void;
  selectedChangeIds?: Set<string>;
  selectedHunkIds?: Record<string, Set<string>>;
  onRejectChange?: (changeId: string) => void;
  onRejectHunk?: (changeId: string, hunkId: string) => void;
  currentEditorPath?: string | null;
  activeReviewTarget?: { changeId: string; hunkId?: string } | null;
  activeReviewTargetRevealToken?: number;
  onRevealHunk?: (changeId: string, hunkId: string) => void;
  error: string | null;
  onEnqueueCommand: (command: string) => boolean;
  onRemoveQueuedCommand: (index: number) => void;
  onPrependQueuedCommands: (commands: string[]) => void;
  onClearQueuedCommands: () => void;
  onSend: (prompt: string) => Promise<boolean>;
  onEditMessage: (index: number, content: string) => Promise<boolean>;
  onResetToMessage?: (index: number) => Promise<string | undefined>;
  onRetryUserMessage: (index: number) => Promise<void>;
  onRetryRunStep?: (target: { runId: string; stepId: string }) => Promise<void>;
  onStop: () => void;
  onClear: () => void;
  selectionModeEnabled?: boolean;
}

const INLINE_SPINNER_HOST_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH']);
const READER_AI_BOTTOM_BUFFER_PX = 12;
const READER_AI_TOOL_LABELS: Record<string, string> = {
  read_document: 'Read document',
  search_document: 'Searched document',
  propose_replace_region: 'Proposed region replacement',
  propose_replace_matches: 'Proposed match replacement',
  task: 'Ran subagent',
};

function getLastMeaningfulNode(root: ParentNode): ChildNode | null {
  for (let node = root.lastChild; node; node = node.previousSibling) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
    return node;
  }
  return null;
}

function findInlineSpinnerHost(root: HTMLElement): HTMLElement {
  let current: ChildNode | null = getLastMeaningfulNode(root);

  while (current) {
    if (current.nodeType === Node.TEXT_NODE) return root;
    if (!(current instanceof HTMLElement)) return root;
    if (INLINE_SPINNER_HOST_TAGS.has(current.tagName)) {
      const nested = getLastMeaningfulNode(current);
      if (!nested) return current;
      current = nested;
      continue;
    }
    const nested = getLastMeaningfulNode(current);
    if (!nested) return root;
    current = nested;
  }

  return root;
}

function buildReaderAiTranscript(options: {
  selectedModel: string;
  messages: ReaderAiMessage[];
  transcript: ReaderAiTranscriptItem[];
  runs: ReaderAiRunRecord[];
  toolLog: ReaderAiToolLogEntry[];
  editProposals: ReaderAiEditProposal[];
  stagedChanges: ReaderAiStagedChange[];
  queuedCommands: string[];
  toolStatus: string | null;
  sending: boolean;
}): string {
  return JSON.stringify(
    {
      type: 'reader_ai_transcript',
      version: 1,
      exportedAt: new Date().toISOString(),
      selectedModel: options.selectedModel,
      sending: options.sending,
      toolStatus: options.toolStatus,
      queuedCommands: options.queuedCommands,
      messages: options.messages,
      transcript: options.transcript,
      toolLog: options.toolLog,
      runs: options.runs,
      editProposals: options.editProposals,
      stagedChanges: options.stagedChanges,
    },
    null,
    2,
  );
}

function readerAiToolLabel(name: string): string {
  return READER_AI_TOOL_LABELS[name] ?? name;
}

function readerAiTranscriptIterationKey(item: { runId?: string; iteration?: number }): string {
  return `${item.runId ?? 'unknown-run'}:${typeof item.iteration === 'number' ? item.iteration : -1}`;
}

type ReaderAiInlineActivity =
  | {
      id: string;
      kind: 'tool';
      toolCallId: string;
      name: string;
      detail?: string;
      error?: string;
      pending: boolean;
    }
  | {
      id: string;
      kind: 'task_progress';
      detail: string;
    }
  | {
      id: string;
      kind: 'error';
      message: string;
    };

type ReaderAiTranscriptBlock =
  | {
      id: string;
      kind: 'user';
      item: Extract<ReaderAiTranscriptItem, { kind: 'user_message' }>;
    }
  | {
      id: string;
      kind: 'assistant';
      runId?: string;
      edited?: boolean;
      status: Extract<ReaderAiTranscriptItem, { kind: 'assistant_turn' }>['status'];
      entries: Array<
        | {
            id: string;
            kind: 'content';
            content: string;
          }
        | {
            id: string;
            kind: 'activity';
            activity: ReaderAiInlineActivity;
          }
      >;
    }
  | {
      id: string;
      kind: 'change_set';
      item: Extract<ReaderAiTranscriptItem, { kind: 'change_set_decision' }>;
    };

function ReaderAiTranscriptCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <div class="reader-ai-transcript-card">
      <div class="reader-ai-transcript-card-header">
        <div class="reader-ai-transcript-card-copy">
          <span class="reader-ai-transcript-card-title">{title}</span>
        </div>
        {action ? <div class="reader-ai-transcript-card-action">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

function appendReaderAiAssistantContent(current: string, next: string): string {
  if (!current.trim()) return next;
  if (!next.trim()) return current;
  return `${current}\n\n${next}`;
}

function buildReaderAiInlineActivity(
  item: Exclude<ReaderAiTranscriptItem, Extract<ReaderAiTranscriptItem, { kind: 'user_message' | 'assistant_turn' }>>,
): ReaderAiInlineActivity | null {
  if (item.kind === 'tool_call') {
    return {
      id: item.id,
      kind: 'tool',
      toolCallId: item.toolCallId,
      name: item.name,
      ...(item.detail ? { detail: item.detail } : {}),
      pending: true,
    };
  }
  if (item.kind === 'tool_result') {
    return {
      id: item.id,
      kind: 'tool',
      toolCallId: item.toolCallId,
      name: item.name,
      ...(item.error ? { error: item.error } : {}),
      pending: false,
    };
  }
  if (item.kind === 'task_progress') {
    return {
      id: item.id,
      kind: 'task_progress',
      detail: item.detail ?? 'Subagent update',
    };
  }
  if (
    item.kind === 'edit_proposal' ||
    item.kind === 'staged_changes_snapshot' ||
    item.kind === 'change_set_decision' ||
    item.kind === 'editor_checkpoint_event'
  ) {
    return null;
  }
  return {
    id: item.id,
    kind: 'error',
    message: item.message,
  };
}

function replaceReaderAiInlineToolActivity(
  entries: Extract<ReaderAiTranscriptBlock, { kind: 'assistant' }>['entries'],
  nextActivity: Extract<ReaderAiInlineActivity, { kind: 'tool' }>,
): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'activity') continue;
    const candidate = entry.activity;
    if (candidate.kind !== 'tool' || candidate.toolCallId !== nextActivity.toolCallId) continue;
    entries[index] = {
      ...entry,
      activity: {
        ...nextActivity,
        ...(candidate.detail ? { detail: candidate.detail } : {}),
      },
    };
    return;
  }
  entries.push({
    id: nextActivity.id,
    kind: 'activity',
    activity: nextActivity,
  });
}

function readerAiInlineActivityPresentation(activity: ReaderAiInlineActivity): {
  text: string;
  tone: 'default' | 'error';
  pending?: boolean;
} {
  if (activity.kind === 'tool') {
    const label = readerAiToolLabel(activity.name);
    const text = activity.detail ? `${label}: ${activity.detail}` : label;
    if (activity.pending) {
      return {
        text,
        tone: 'default',
        pending: true,
      };
    }
    return {
      text,
      tone: activity.error ? 'error' : 'default',
    };
  }
  if (activity.kind === 'task_progress') {
    return {
      text: `Subagent: ${activity.detail}`,
      tone: 'default',
    };
  }
  return {
    text: activity.message,
    tone: 'error',
  };
}

function ReaderAiAssistantMessage({
  content,
  streaming,
  onRendered,
}: {
  content: string;
  streaming: boolean;
  onRendered?: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    try {
      root.innerHTML = parseMarkdownToHtml(content, { smartQuotes: true });
    } catch {
      root.replaceChildren(document.createTextNode(content));
    }
    const frame = onRendered ? requestAnimationFrame(() => onRendered()) : null;
    if (streaming) {
      const spinner = document.createElement('span');
      spinner.className = 'reader-ai-thinking-spinner reader-ai-thinking-spinner--inline';
      spinner.setAttribute('aria-hidden', 'true');

      const host = findInlineSpinnerHost(root);
      host.append(' ', spinner);
    }
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [content, onRendered, streaming]);

  return <div ref={contentRef} class="reader-ai-message-content rendered-markdown" />;
}

export function ReaderAiPanel({
  className,
  visible = true,
  activationRequestKey = 0,
  modelsLoading,
  modelsError,
  selectedModel,
  messages,
  transcript,
  runs,
  queuedCommands,
  sending,
  toolStatus,
  toolLog,
  proposalStatusesByToolCallId: _proposalStatusesByToolCallId,
  editProposals,
  stagedChanges,
  stagedChangesStreaming = false,
  applyingChanges,
  canApplyWithoutSaving,
  applyDisabledReasonLabel = null,
  editorProposalMode = false,
  canUndoEditorApply = false,
  editorCheckpoint = null,
  onApplyWithoutSaving,
  onUndoEditorApply,
  onReapplyEditorApply,
  onRestoreTranscriptChangeSet,
  onIgnoreAll,
  onToggleChangeSelection,
  onToggleHunkSelection,
  selectedChangeIds,
  selectedHunkIds,
  onRejectChange,
  onRejectHunk,
  currentEditorPath = null,
  activeReviewTarget = null,
  activeReviewTargetRevealToken = 0,
  onRevealHunk,
  error,
  onEnqueueCommand,
  onRemoveQueuedCommand,
  onPrependQueuedCommands,
  onClearQueuedCommands,
  onSend,
  onEditMessage,
  onResetToMessage,
  onRetryUserMessage,
  onRetryRunStep,
  onStop,
  onClear,
  selectionModeEnabled = false,
}: ReaderAiPanelProps) {
  const isMac = typeof navigator !== 'undefined' && /(mac|iphone|ipad|ipod)/i.test(navigator.platform ?? '');
  const clearChatShortcutLabel = isMac ? '⌘K' : 'Ctrl+K';
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [panelView, setPanelView] = useState<ReaderAiPanelView>('chat');
  const panelRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const queueDrainInFlightRef = useRef(false);
  const pendingScrollToBottomOnSendRef = useRef(false);
  const thinkingStartedAtRef = useRef<number | null>(null);
  const pendingFocusAfterClearRef = useRef(false);
  const pendingSelectDraftRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
  const lastHandledActivationRequestRef = useRef(0);
  const [bottomComposerHeight, setBottomComposerHeight] = useState(0);
  const messageCount = messages.length;
  const canSend = draft.trim().length > 0 && !sending && Boolean(selectedModel);
  const hasMessages = messageCount > 0;
  const composerAtTop = !hasMessages;
  const statusText = useMemo(() => {
    if (modelsLoading) return 'Loading free models...';
    if (modelsError) return modelsError;
    if (!selectedModel) return 'No free model available.';
    if (sending && queuedCommands.length > 0) {
      return `${queuedCommands.length} queued ${queuedCommands.length === 1 ? 'message' : 'messages'} will send next.`;
    }
    return null;
  }, [modelsLoading, modelsError, queuedCommands.length, selectedModel, sending]);
  const composerInputDisabled = !selectedModel;
  const composerPlaceholder = selectionModeEnabled ? 'Ask about this selection...' : 'Ask about this document...';
  const isAssistantThinking =
    sending &&
    messageCount > 0 &&
    messages[messageCount - 1].role === 'assistant' &&
    messages[messageCount - 1].content.trim().length === 0;

  const getActionErrorMessage = useCallback((value: unknown, fallback: string) => {
    return value instanceof Error && value.message.trim().length > 0 ? value.message : fallback;
  }, []);

  const getBottomComposerHeight = useCallback(() => {
    if (composerAtTop) return 0;
    return (composerWrapRef.current?.offsetHeight ?? bottomComposerHeight) + READER_AI_BOTTOM_BUFFER_PX;
  }, [bottomComposerHeight, composerAtTop]);

  const getConversationEndScrollTop = useCallback(
    (root: HTMLDivElement) => {
      const anchor = lastMessageRef.current;
      if (!anchor) return Math.max(0, root.scrollHeight - root.clientHeight);
      const rootBounds = root.getBoundingClientRect();
      const anchorBounds = anchor.getBoundingClientRect();
      const anchorBottom = anchorBounds.bottom - rootBounds.top + root.scrollTop;
      const targetScrollTop = anchorBottom - root.clientHeight + getBottomComposerHeight();
      const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
      return Math.max(0, Math.min(maxScrollTop, targetScrollTop));
    },
    [getBottomComposerHeight],
  );

  const isNearConversationEnd = useCallback(
    (root: HTMLDivElement) => {
      return Math.abs(root.scrollTop - getConversationEndScrollTop(root)) <= 24;
    },
    [getConversationEndScrollTop],
  );

  const scrollMessagesToBottom = useCallback(() => {
    const root = messagesRef.current;
    if (!root) return;
    root.scrollTop = getConversationEndScrollTop(root);
    pinnedToBottomRef.current = true;
  }, [getConversationEndScrollTop]);

  const scheduleScrollMessagesToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollMessagesToBottom();
      requestAnimationFrame(() => scrollMessagesToBottom());
    });
  }, [scrollMessagesToBottom]);

  const maybeScrollMessagesToBottom = useCallback(() => {
    const root = messagesRef.current;
    if (!root) return;
    if (!pinnedToBottomRef.current && !isNearConversationEnd(root)) return;
    root.scrollTop = getConversationEndScrollTop(root);
  }, [getConversationEndScrollTop, isNearConversationEnd]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript.length and editProposals.length trigger scroll on new activity
  useEffect(() => {
    const root = messagesRef.current;
    if (!root || (messageCount === 0 && !sending)) return;
    if (!pinnedToBottomRef.current && !isNearConversationEnd(root)) return;
    root.scrollTop = getConversationEndScrollTop(root);
  }, [
    editProposals.length,
    getConversationEndScrollTop,
    isNearConversationEnd,
    messageCount,
    sending,
    transcript.length,
  ]);

  useEffect(() => {
    if (editingIndex === null) return;
    const input = editInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editingIndex]);

  useEffect(() => {
    if (!isAssistantThinking) {
      thinkingStartedAtRef.current = null;
      setThinkingSeconds(0);
      return;
    }
    if (thinkingStartedAtRef.current === null) {
      thinkingStartedAtRef.current = Date.now();
      setThinkingSeconds(0);
    }
    const intervalId = window.setInterval(() => {
      const startedAt = thinkingStartedAtRef.current;
      if (startedAt === null) return;
      setThinkingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(intervalId);
  }, [isAssistantThinking]);

  useLayoutEffect(() => {
    if (!pendingScrollToBottomOnSendRef.current || messageCount === 0) return;
    pendingScrollToBottomOnSendRef.current = false;
    scheduleScrollMessagesToBottom();
  }, [messageCount, scheduleScrollMessagesToBottom]);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  });

  useLayoutEffect(() => {
    const composer = composerWrapRef.current;
    if (!composer || composerAtTop) {
      setBottomComposerHeight(0);
      return;
    }
    const updateComposerHeight = () => {
      setBottomComposerHeight(composer.offsetHeight);
    };
    updateComposerHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      updateComposerHeight();
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [composerAtTop]);

  useEffect(() => {
    if (hasMessages || !pendingFocusAfterClearRef.current) return;
    pendingFocusAfterClearRef.current = false;
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input || input.disabled) return;
      input.focus();
    });
  }, [hasMessages]);

  useEffect(() => {
    const panel = panelRef.current;
    const messages = messagesRef.current;
    if (!panel || !messages) return;

    const onWheel = (event: WheelEvent) => {
      if (!messagesRef.current) return;
      const activeMessages = messagesRef.current;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? activeMessages.clientHeight
            : 1;
      const deltaY = event.deltaY * unit;
      if (deltaY === 0) return;

      const maxScrollTop = Math.max(0, activeMessages.scrollHeight - activeMessages.clientHeight);
      if (maxScrollTop <= 0) {
        event.preventDefault();
        return;
      }

      const next = activeMessages.scrollTop + deltaY;
      const clamped = Math.max(0, Math.min(maxScrollTop, next));
      if (clamped === activeMessages.scrollTop) {
        event.preventDefault();
        return;
      }

      activeMessages.scrollTop = clamped;
      pinnedToBottomRef.current = isNearConversationEnd(activeMessages);
      event.preventDefault();
    };

    const onScroll = () => {
      if (!messagesRef.current) return;
      pinnedToBottomRef.current = isNearConversationEnd(messagesRef.current);
    };

    panel.addEventListener('wheel', onWheel, { passive: false });
    messages.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      panel.removeEventListener('wheel', onWheel);
      messages.removeEventListener('scroll', onScroll);
    };
  }, [isNearConversationEnd]);

  const enqueueDraft = () => {
    const prompt = draft.trim();
    if (!prompt || !selectedModel || queuedCommands.length >= 10) return;
    if (!onEnqueueCommand(prompt)) return;
    setDraft('');
  };

  const removeQueuedCommand = (index: number) => {
    onRemoveQueuedCommand(index);
  };

  const runQueuedCommands = useCallback(
    async (commands: string[], options?: { draftValue?: string; queuedBeforeSubmit?: string[] }) => {
      if (commands.length === 0 || !selectedModel) return;
      queueDrainInFlightRef.current = true;
      const draftValue = options?.draftValue;
      const queuedBeforeSubmit = options?.queuedBeforeSubmit ?? [];
      try {
        scrollMessagesToBottom();
        setActionError(null);
        let failedCommandIndex = -1;
        for (const [index, command] of commands.entries()) {
          let ok = false;
          try {
            ok = await onSend(command);
          } catch (error) {
            setActionError(getActionErrorMessage(error, 'Failed to send queued Reader AI message.'));
            failedCommandIndex = index;
            break;
          }
          if (!ok) {
            failedCommandIndex = index;
            break;
          }
        }
        if (failedCommandIndex >= 0) {
          const failedQueuedCommands = commands.slice(failedCommandIndex, queuedBeforeSubmit.length);
          if (failedQueuedCommands.length > 0) {
            onPrependQueuedCommands(failedQueuedCommands);
          }
          if (typeof draftValue === 'string' && draftValue.trim()) setDraft(draftValue);
        }
      } finally {
        queueDrainInFlightRef.current = false;
      }
    },
    [getActionErrorMessage, onPrependQueuedCommands, onSend, scrollMessagesToBottom, selectedModel],
  );

  const submit = async () => {
    const draftValue = draft;
    const prompt = draftValue.trim();
    const queued = queuedCommands;
    if ((!prompt && queued.length === 0) || !selectedModel) return;
    if (sending) {
      if (prompt) {
        enqueueDraft();
        focusComposerInput();
      }
      return;
    }
    if (!composerAtTop) {
      pendingScrollToBottomOnSendRef.current = true;
      scheduleScrollMessagesToBottom();
    }
    setDraft('');
    onClearQueuedCommands();
    focusComposerInput();
    const commands = prompt ? [...queued, prompt] : queued;
    await runQueuedCommands(commands, { draftValue, queuedBeforeSubmit: queued });
  };

  useEffect(() => {
    if (sending || !selectedModel || queuedCommands.length === 0 || queueDrainInFlightRef.current) return;
    onClearQueuedCommands();
    void runQueuedCommands(queuedCommands, { queuedBeforeSubmit: queuedCommands });
  }, [onClearQueuedCommands, queuedCommands, runQueuedCommands, selectedModel, sending]);

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingDraft('');
  };

  const applyEdit = async () => {
    if (editingIndex === null || sending || !selectedModel) return;
    const nextValue = editingDraft.trim();
    if (!nextValue) return;
    try {
      setActionError(null);
      const accepted = await onEditMessage(editingIndex, nextValue);
      if (accepted) cancelEdit();
    } catch (error) {
      setActionError(getActionErrorMessage(error, 'Failed to edit Reader AI message.'));
    }
  };

  const retryUserMessage = useCallback(
    async (index: number) => {
      try {
        setActionError(null);
        await onRetryUserMessage(index);
      } catch (error) {
        setActionError(getActionErrorMessage(error, 'Failed to retry Reader AI message.'));
      }
    },
    [getActionErrorMessage, onRetryUserMessage],
  );

  const clearChat = (focusComposer: boolean) => {
    if (!hasMessages && queuedCommands.length === 0) return;
    pendingFocusAfterClearRef.current = focusComposer;
    onClearQueuedCommands();
    if (hasMessages) onClear();
  };

  const focusComposerInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input || input.disabled) return;
      input.focus();
      if (pendingSelectDraftRef.current) {
        pendingSelectDraftRef.current = false;
        input.setSelectionRange(0, input.value.length);
      }
    });
  }, []);

  useEffect(() => {
    if (!visible || activationRequestKey === lastHandledActivationRequestRef.current) return;
    lastHandledActivationRequestRef.current = activationRequestKey;
    setPanelView('chat');
    focusComposerInput();
  }, [activationRequestKey, focusComposerInput, visible]);

  const resetToMessage = useCallback(
    async (index: number) => {
      if (!onResetToMessage) return;
      try {
        setActionError(null);
        const restoredPrompt = await onResetToMessage(index);
        if (typeof restoredPrompt === 'string') {
          setDraft(restoredPrompt);
          pendingSelectDraftRef.current = true;
          requestAnimationFrame(() => {
            const input = composerInputRef.current;
            if (!input) return;
            input.style.height = 'auto';
            input.style.height = `${input.scrollHeight}px`;
          });
          focusComposerInput();
        }
      } catch (error) {
        setActionError(getActionErrorMessage(error, 'Failed to reset Reader AI conversation.'));
      }
    },
    [focusComposerInput, getActionErrorMessage, onResetToMessage],
  );

  const sendQuickPrompt = useCallback(
    async (prompt: string) => {
      try {
        setActionError(null);
        await onSend(prompt);
      } catch (error) {
        setActionError(getActionErrorMessage(error, 'Failed to send Reader AI message.'));
      }
      focusComposerInput();
    },
    [focusComposerInput, getActionErrorMessage, onSend],
  );

  const openHistoryView = useCallback(() => {
    setPanelView('history');
  }, []);

  const copyTranscript = useCallback(async () => {
    try {
      setActionError(null);
      await copyTextToClipboard(
        buildReaderAiTranscript({
          selectedModel,
          messages,
          transcript,
          runs,
          toolLog,
          editProposals,
          stagedChanges,
          queuedCommands,
          toolStatus,
          sending,
        }),
      );
    } catch (error) {
      setActionError(getActionErrorMessage(error, 'Failed to copy Reader AI transcript.'));
    }
  }, [
    editProposals,
    getActionErrorMessage,
    messages,
    queuedCommands,
    runs,
    selectedModel,
    sending,
    stagedChanges,
    transcript,
    toolLog,
    toolStatus,
  ]);

  const returnToChatView = useCallback(() => {
    setPanelView('chat');
    focusComposerInput();
  }, [focusComposerInput]);

  const retryRunStep = useCallback(
    async (target: { runId: string; stepId: string }) => {
      if (!onRetryRunStep) return;
      try {
        setActionError(null);
        await onRetryRunStep(target);
      } catch (error) {
        setActionError(getActionErrorMessage(error, 'Failed to retry Reader AI step.'));
      }
    },
    [getActionErrorMessage, onRetryRunStep],
  );

  const transcriptBlocks = useMemo(() => {
    const proposalIterationKeys = new Set(
      transcript
        .filter(
          (item): item is Extract<ReaderAiTranscriptItem, { kind: 'edit_proposal' }> => item.kind === 'edit_proposal',
        )
        .map((item) => readerAiTranscriptIterationKey(item)),
    );

    const transcriptItems = transcript.filter((item) => {
      if (item.kind !== 'staged_changes_snapshot') return true;
      return !proposalIterationKeys.has(readerAiTranscriptIterationKey(item));
    });
    const blocks: ReaderAiTranscriptBlock[] = [];
    let currentAssistantBlock: Extract<ReaderAiTranscriptBlock, { kind: 'assistant' }> | null = null;

    for (const item of transcriptItems) {
      if (item.kind === 'user_message') {
        currentAssistantBlock = null;
        blocks.push({
          id: item.id,
          kind: 'user',
          item,
        });
        continue;
      }
      if (item.kind === 'assistant_turn') {
        if (currentAssistantBlock?.runId && item.runId === currentAssistantBlock.runId) {
          currentAssistantBlock.edited = currentAssistantBlock.edited || item.edited === true;
          currentAssistantBlock.status = item.status;
          if (item.content.trim()) {
            const lastEntry = currentAssistantBlock.entries[currentAssistantBlock.entries.length - 1];
            if (lastEntry?.kind === 'content') {
              lastEntry.content = appendReaderAiAssistantContent(lastEntry.content, item.content);
            } else {
              currentAssistantBlock.entries.push({
                id: item.id,
                kind: 'content',
                content: item.content,
              });
            }
          }
          continue;
        }
        currentAssistantBlock = {
          id: item.id,
          kind: 'assistant',
          ...(item.runId ? { runId: item.runId } : {}),
          ...(item.edited ? { edited: true } : {}),
          status: item.status,
          entries: item.content.trim()
            ? [
                {
                  id: item.id,
                  kind: 'content',
                  content: item.content,
                },
              ]
            : [],
        };
        blocks.push(currentAssistantBlock);
        continue;
      }

      if (item.kind === 'change_set_decision') {
        if (item.action !== 'discarded') continue;
        currentAssistantBlock = null;
        blocks.push({
          id: item.id,
          kind: 'change_set',
          item,
        });
        continue;
      }

      if (!currentAssistantBlock) {
        currentAssistantBlock = {
          id: `assistant-inline:${item.id}`,
          kind: 'assistant',
          ...('runId' in item && typeof item.runId === 'string' ? { runId: item.runId } : {}),
          status: 'completed',
          entries: [],
        };
        blocks.push(currentAssistantBlock);
      }

      const activity = buildReaderAiInlineActivity(item);
      if (!activity) continue;
      if (activity.kind === 'tool' && !activity.pending) {
        replaceReaderAiInlineToolActivity(currentAssistantBlock.entries, activity);
        continue;
      }
      currentAssistantBlock.entries.push({
        id: activity.id,
        kind: 'activity',
        activity,
      });
    }

    return blocks;
  }, [transcript]);

  const renderUserMessageCard = (
    message: ReaderAiMessage,
    index: number,
    options?: { ref?: (node: HTMLDivElement | null) => void },
  ) => (
    <div key={`user:${index}`} ref={options?.ref}>
      <div class="reader-ai-message reader-ai-message--user">
        <div class="reader-ai-message-role">
          <span>You</span>
          {editingIndex === index ? null : (
            <span class="reader-ai-message-actions">
              <button
                type="button"
                class="reader-ai-message-icon-btn"
                onClick={() => {
                  setEditingIndex(index);
                  setEditingDraft(message.content);
                }}
                disabled={sending || !selectedModel}
                aria-label="Edit message"
              >
                <Pencil size={13} aria-hidden="true" />
              </button>
              <DropdownMenu.Root onOpenChange={blurOnClose}>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    class="reader-ai-message-menu-trigger"
                    aria-label="Message actions"
                    disabled={!selectedModel}
                  >
                    <MoreHorizontal size={13} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="reader-ai-composer-menu" sideOffset={6} align="end">
                    <DropdownMenu.Item
                      class="reader-ai-composer-menu-item"
                      disabled={sending || !selectedModel}
                      onSelect={() => {
                        setEditingIndex(index);
                        setEditingDraft(message.content);
                      }}
                    >
                      Edit
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="reader-ai-composer-menu-item"
                      disabled={sending || !selectedModel}
                      onSelect={() => {
                        void retryUserMessage(index);
                      }}
                    >
                      Retry
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="reader-ai-composer-menu-item"
                      disabled={sending || !selectedModel || !onResetToMessage}
                      onSelect={() => {
                        void resetToMessage(index);
                      }}
                    >
                      Reset to here
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </span>
          )}
        </div>
        {editingIndex === index ? (
          <div class="reader-ai-inline-edit">
            <textarea
              ref={editInputRef}
              class="reader-ai-inline-edit-input"
              value={editingDraft}
              onInput={(event) => setEditingDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault();
                  void applyEdit();
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEdit();
                }
              }}
              rows={3}
              disabled={sending || !selectedModel}
            />
            <div class="reader-ai-inline-edit-actions">
              <button
                type="button"
                class="reader-ai-inline-edit-btn reader-ai-inline-edit-btn--secondary"
                onClick={cancelEdit}
                disabled={sending}
              >
                Cancel
              </button>
              <button
                type="button"
                class="reader-ai-inline-edit-btn reader-ai-inline-edit-btn--primary"
                onClick={() => void applyEdit()}
                disabled={sending || !selectedModel || editingDraft.trim().length === 0}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div class="reader-ai-message-content">{message.content}</div>
        )}
      </div>
    </div>
  );

  const renderTranscriptItems = transcriptBlocks.map((block, index) => {
    const isLastItem = index === transcriptBlocks.length - 1;
    const itemRef = isLastItem ? lastMessageRef : undefined;

    if (block.kind === 'user') {
      const message = messages[block.item.messageIndex] ?? { role: 'user' as const, content: block.item.content };
      return renderUserMessageCard(message, block.item.messageIndex, {
        ref: itemRef ? (node) => void (itemRef.current = node) : undefined,
      });
    }

    if (block.kind === 'assistant') {
      const streaming = block.status === 'streaming' && sending && isLastItem;
      return (
        <div key={block.id} ref={itemRef}>
          <div class="reader-ai-message reader-ai-message--assistant">
            <div class="reader-ai-message-role">
              <span>Reader AI</span>
              {block.edited ? <span class="reader-ai-message-edited">Edited</span> : null}
            </div>
            {streaming && block.entries.length === 0 ? (
              <div class="reader-ai-thinking">
                <span class="reader-ai-thinking-spinner" aria-hidden="true" />
                <span>{thinkingSeconds >= 5 ? `Thinking... (${thinkingSeconds} seconds)` : 'Thinking...'}</span>
              </div>
            ) : null}
            {block.entries.length > 0 ? (
              <div class="reader-ai-message-inline-activity-list">
                {block.entries.map((entry, entryIndex) => {
                  if (entry.kind === 'content') {
                    const isLastContentEntry = streaming && entryIndex === block.entries.length - 1;
                    return (
                      <ReaderAiAssistantMessage
                        key={entry.id}
                        content={entry.content}
                        streaming={isLastContentEntry}
                        onRendered={isLastContentEntry ? maybeScrollMessagesToBottom : undefined}
                      />
                    );
                  }

                  const presentation = readerAiInlineActivityPresentation(entry.activity);
                  return (
                    <div
                      key={entry.id}
                      class={`reader-ai-message-inline-activity reader-ai-message-inline-activity--${presentation.tone}`}
                    >
                      {presentation.pending ? (
                        <span
                          class="reader-ai-thinking-spinner reader-ai-thinking-spinner--message-activity"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span>{presentation.text}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (block.kind === 'change_set') {
      const canRestore = typeof onRestoreTranscriptChangeSet === 'function';
      return (
        <div key={block.id} ref={itemRef}>
          <ReaderAiTranscriptCard
            title={`Discarded changes (${block.item.changes.length} file${block.item.changes.length === 1 ? '' : 's'})`}
            action={
              canRestore ? (
                <button
                  type="button"
                  class="reader-ai-checkpoint-card-action"
                  onClick={() => onRestoreTranscriptChangeSet?.(block.item)}
                >
                  Restore to staging
                </button>
              ) : undefined
            }
          >
            <StagedChangesSection
              changes={block.item.changes}
              applying={false}
              title="Discarded changes"
              reviewControls={false}
              showFooter={false}
            />
          </ReaderAiTranscriptCard>
        </div>
      );
    }

    return null;
  });

  const composer = (
    <div
      ref={composerWrapRef}
      class={`reader-ai-input-wrap reader-ai-input-wrap--composer${composerAtTop ? '' : ' reader-ai-input-wrap--composer-bottom'}`}
    >
      {queuedCommands.length > 0 ? (
        <div class="reader-ai-queue" role="group" aria-label="Queued Reader AI commands">
          <div class="reader-ai-queue-header">
            <span class="reader-ai-queue-title">Queued commands</span>
          </div>
          <div class="reader-ai-queue-list">
            {queuedCommands.map((command, index) => (
              <div key={`${index}:${command}`} class="reader-ai-queue-item">
                <span class="reader-ai-queue-item-index">{index + 1}.</span>
                <span class="reader-ai-queue-item-text">{command}</span>
                <button
                  type="button"
                  class="reader-ai-queue-remove"
                  onClick={() => removeQueuedCommand(index)}
                  aria-label={`Remove queued command ${index + 1}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div class="reader-ai-composer-shell">
        <DropdownMenu.Root onOpenChange={blurOnClose}>
          <DropdownMenu.Trigger asChild>
            <button type="button" class="reader-ai-composer-menu-trigger" aria-label="Reader AI chat actions">
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="reader-ai-composer-menu" sideOffset={6} align="end">
              <DropdownMenu.Item class="reader-ai-composer-menu-item" onSelect={() => clearChat(true)}>
                <span>Clear all</span>
                <span class="reader-ai-composer-menu-item-shortcut" aria-hidden="true">
                  {clearChatShortcutLabel}
                </span>
              </DropdownMenu.Item>
              <DropdownMenu.Item class="reader-ai-composer-menu-item" onSelect={openHistoryView}>
                History
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="reader-ai-composer-menu-item"
                onSelect={() => {
                  void copyTranscript();
                }}
              >
                Copy transcript
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <textarea
          ref={composerInputRef}
          class={`reader-ai-input${hasMessages ? ' reader-ai-input--bottom' : ''}`}
          value={draft}
          placeholder={composerPlaceholder}
          onInput={(event) => {
            const input = event.currentTarget;
            setDraft(input.value);
            input.style.height = 'auto';
            input.style.height = `${input.scrollHeight}px`;
          }}
          onKeyDown={(event) => {
            if (matchesPrimaryShortcut(event, 'k')) {
              event.preventDefault();
              const input = event.currentTarget;
              if (draft.length > 0) {
                setDraft('');
                input.style.height = 'auto';
              }
              if (hasMessages && !sending) clearChat(true);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          disabled={composerInputDisabled}
        />
        {sending ? (
          <button type="button" class="reader-ai-send-btn" onClick={onStop} aria-label="Stop response">
            <CircleStop size={13} class="reader-ai-stop-icon" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            class="reader-ai-send-btn"
            disabled={!canSend}
            onClick={() => void submit()}
            aria-label="Send question"
          >
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <aside
      ref={panelRef}
      class={className ? `reader-ai-panel ${className}` : 'reader-ai-panel'}
      aria-label="Reader AI panel"
      aria-hidden={className?.includes('reader-ai-panel--hidden') ? 'true' : undefined}
    >
      {panelView === 'history' ? (
        <div class="reader-ai-history-view">
          <div class="reader-ai-history-view-header">
            <div class="reader-ai-history-view-title-group">
              <div class="reader-ai-history-view-title">History</div>
            </div>
            <div class="reader-ai-history-view-count">
              {runs.length === 0 ? 'No runs yet' : `${runs.length} run${runs.length === 1 ? '' : 's'} recorded`}
            </div>
            <button type="button" class="reader-ai-history-back-btn" onClick={returnToChatView}>
              <ArrowLeft size={14} aria-hidden="true" />
              <span>Back to chat</span>
            </button>
          </div>
          <div class="reader-ai-history-view-body">
            {runs.length > 0 ? (
              <ReaderAiRunHistorySection runs={runs} onRetryStep={retryRunStep} />
            ) : (
              <div class="reader-ai-history-empty">Reader AI history will appear here after you run prompts.</div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div class="reader-ai-messages" ref={messagesRef}>
            {composerAtTop ? composer : null}
            {!hasMessages ? (
              <div class="reader-ai-empty">
                <button
                  type="button"
                  class="reader-ai-summarize-btn"
                  disabled={composerInputDisabled}
                  onClick={() => {
                    void sendQuickPrompt(
                      selectionModeEnabled ? 'Summarize this selection.' : 'Summarize this document.',
                    );
                  }}
                >
                  Summarize
                </button>
                <button
                  type="button"
                  class="reader-ai-summarize-btn"
                  disabled={composerInputDisabled}
                  onClick={() => {
                    void sendQuickPrompt(
                      selectionModeEnabled
                        ? 'Identify any questions raised by this selection.'
                        : 'Identify any questions raised by this document.',
                    );
                  }}
                >
                  Identify questions
                </button>
              </div>
            ) : null}
            {renderTranscriptItems}
            {sending && toolStatus && toolLog.length === 0 && transcriptBlocks.length === 0 ? (
              <div class="reader-ai-tool-status">{toolStatus}</div>
            ) : null}
            {editorCheckpoint ? (
              <div class="reader-ai-checkpoint-card" role="status" aria-live="polite">
                <div class="reader-ai-checkpoint-card-header">
                  <span
                    class={`reader-ai-checkpoint-status${
                      editorCheckpoint.status === 'restored'
                        ? ' reader-ai-checkpoint-status--restored'
                        : ' reader-ai-checkpoint-status--active'
                    }`}
                  >
                    {editorCheckpoint.status === 'restored' ? 'Edits reverted' : 'Edits applied'}
                  </span>
                  {editorCheckpoint.canRestore || editorCheckpoint.status === 'restored' ? (
                    <button
                      type="button"
                      class="reader-ai-checkpoint-card-action"
                      disabled={
                        editorCheckpoint.status === 'restored'
                          ? !editorCheckpoint.canReapply
                          : !editorCheckpoint.canRestore
                      }
                      onClick={() =>
                        editorCheckpoint.status === 'restored' ? onReapplyEditorApply?.() : onUndoEditorApply?.()
                      }
                    >
                      {editorCheckpoint.status === 'restored' ? 'Reapply edits' : 'Undo edits'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {stagedChanges.length > 0 ? (
              <StagedChangesSection
                changes={stagedChanges}
                streaming={stagedChangesStreaming}
                title={editProposals.length > 0 ? 'Proposed changes' : undefined}
                applying={applyingChanges}
                canApplyWithoutSaving={canApplyWithoutSaving}
                applyDisabledReasonLabel={applyDisabledReasonLabel}
                editorProposalMode={editorProposalMode}
                canUndoEditorApply={canUndoEditorApply}
                reviewControls={false}
                currentEditorPath={currentEditorPath}
                activeReviewTarget={activeReviewTarget}
                activeReviewTargetRevealToken={activeReviewTargetRevealToken}
                onApplyWithoutSaving={onApplyWithoutSaving}
                onUndoEditorApply={onUndoEditorApply}
                onIgnoreAll={onIgnoreAll}
                onRevealHunk={onRevealHunk}
                onToggleChangeSelection={onToggleChangeSelection}
                onToggleHunkSelection={onToggleHunkSelection}
                selectedChangeIds={selectedChangeIds}
                selectedHunkIds={selectedHunkIds}
                onRejectChange={onRejectChange}
                onRejectHunk={onRejectHunk}
              />
            ) : null}
            {error || actionError ? (
              <div class="reader-ai-error reader-ai-error--inline">{error ?? actionError}</div>
            ) : null}
            {composerAtTop ? null : (
              <div
                class="reader-ai-messages-bottom-spacer"
                style={bottomComposerHeight > 0 ? { height: `${bottomComposerHeight}px` } : undefined}
                aria-hidden="true"
              />
            )}
            {composerAtTop ? null : composer}
          </div>
          {statusText ? <div class="reader-ai-status">{statusText}</div> : null}
        </>
      )}
    </aside>
  );
}
