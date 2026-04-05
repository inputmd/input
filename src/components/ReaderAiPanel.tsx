import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeft, ArrowRight, CircleStop, MoreHorizontal, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils';
import { parseMarkdownToHtml } from '../markdown';
import type { ReaderAiEditProposal, ReaderAiStagedChange } from '../reader_ai';
import type { ReaderAiRunRecord } from '../reader_ai_ledger';
import { ReaderAiRunHistorySection } from './ReaderAiRunHistory';
import { StagedChangesSection } from './ReaderAiStagedChanges';
import { type ReaderAiToolLogEntry, ToolLogSection } from './ReaderAiToolLog';

export type { ReaderAiToolLogEntry } from './ReaderAiToolLog';

type ReaderAiPanelView = 'chat' | 'history';

export interface ReaderAiMessage {
  role: 'user' | 'assistant';
  content: string;
  edited?: boolean;
}

interface ReaderAiPanelProps {
  className?: string;
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModel: string;
  messages: ReaderAiMessage[];
  runs: ReaderAiRunRecord[];
  activeRunId?: string | null;
  queuedCommands: string[];
  sending: boolean;
  toolStatus: string | null;
  toolLog: ReaderAiToolLogEntry[];
  editProposals: ReaderAiEditProposal[];
  proposalStatusesByToolCallId?: Record<string, 'accepted' | 'rejected' | 'ignored'>;
  stagedChanges: ReaderAiStagedChange[];
  stagedChangesStreaming?: boolean;
  applyingChanges: boolean;
  canApplyWithoutSaving: boolean;
  applyDisabledReasonLabel?: string | null;
  editorProposalMode?: boolean;
  canUndoEditorApply?: boolean;
  onApplyWithoutSaving: () => void;
  onUndoEditorApply?: () => void;
  onIgnoreAll?: () => void;
  onAcceptProposal?: (proposalId: string) => void;
  onRejectProposal?: (proposalId: string) => void;
  onToggleProposalHunkSelection?: (proposalId: string, hunkId: string, selected: boolean) => void;
  onToggleChangeSelection?: (changeId: string, selected: boolean) => void;
  onToggleHunkSelection?: (changeId: string, hunkId: string, selected: boolean) => void;
  selectedChangeIds?: Set<string>;
  selectedHunkIds?: Record<string, Set<string>>;
  onRejectChange?: (changeId: string) => void;
  onRejectHunk?: (changeId: string, hunkId: string) => void;
  currentEditorPath?: string | null;
  activeReviewTarget?: { changeId: string; hunkId?: string } | null;
  activeReviewTargetRevealToken?: number;
  onRevealChange?: (changeId: string) => void;
  onRevealHunk?: (changeId: string, hunkId: string) => void;
  error: string | null;
  onEnqueueCommand: (command: string) => boolean;
  onRemoveQueuedCommand: (index: number) => void;
  onPrependQueuedCommands: (commands: string[]) => void;
  onClearQueuedCommands: () => void;
  onSend: (prompt: string) => Promise<boolean>;
  onEditMessage: (index: number, content: string) => Promise<boolean>;
  onResetToMessage?: (index: number) => Promise<string | undefined>;
  onRetryLastUserMessage: () => Promise<void>;
  onRetryRunStep?: (target: { runId: string; stepId: string }) => Promise<void>;
  onStop: () => void;
  onClear: () => void;
  selectionModeEnabled?: boolean;
}

const INLINE_SPINNER_HOST_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH']);

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
  modelsLoading,
  modelsError,
  selectedModel,
  messages,
  runs,
  activeRunId = null,
  queuedCommands,
  sending,
  toolStatus,
  toolLog,
  editProposals,
  proposalStatusesByToolCallId,
  stagedChanges,
  stagedChangesStreaming = false,
  applyingChanges,
  canApplyWithoutSaving,
  applyDisabledReasonLabel = null,
  editorProposalMode = false,
  canUndoEditorApply = false,
  onApplyWithoutSaving,
  onUndoEditorApply,
  onIgnoreAll,
  onAcceptProposal,
  onRejectProposal,
  onToggleProposalHunkSelection,
  onToggleChangeSelection,
  onToggleHunkSelection,
  selectedChangeIds,
  selectedHunkIds,
  onRejectChange,
  onRejectHunk,
  currentEditorPath = null,
  activeReviewTarget = null,
  activeReviewTargetRevealToken = 0,
  onRevealChange,
  onRevealHunk,
  error,
  onEnqueueCommand,
  onRemoveQueuedCommand,
  onPrependQueuedCommands,
  onClearQueuedCommands,
  onSend,
  onEditMessage,
  onResetToMessage,
  onRetryLastUserMessage,
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
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const queueDrainInFlightRef = useRef(false);
  const pendingScrollToBottomOnSendRef = useRef(false);
  const thinkingStartedAtRef = useRef<number | null>(null);
  const pendingFocusAfterClearRef = useRef(false);
  const pendingSelectDraftRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
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
  let lastUserMessageIndex = -1;
  for (let i = messageCount - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMessageIndex = i;
      break;
    }
  }
  const composerPlaceholder = selectionModeEnabled ? 'Ask about this selection...' : 'Ask about this document...';
  const isAssistantThinking =
    sending &&
    messageCount > 0 &&
    messages[messageCount - 1].role === 'assistant' &&
    messages[messageCount - 1].content.trim().length === 0;

  const getActionErrorMessage = useCallback((value: unknown, fallback: string) => {
    return value instanceof Error && value.message.trim().length > 0 ? value.message : fallback;
  }, []);

  const isNearMessagesBottom = useCallback((root: HTMLDivElement) => {
    const distanceFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
    return distanceFromBottom <= 24;
  }, []);

  const scrollMessagesToBottom = useCallback(() => {
    const root = messagesRef.current;
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    pinnedToBottomRef.current = true;
  }, []);

  const scheduleScrollMessagesToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollMessagesToBottom();
      requestAnimationFrame(() => scrollMessagesToBottom());
    });
  }, [scrollMessagesToBottom]);

  const maybeScrollMessagesToBottom = useCallback(() => {
    const root = messagesRef.current;
    if (!root) return;
    if (!pinnedToBottomRef.current && !isNearMessagesBottom(root)) return;
    root.scrollTop = root.scrollHeight;
  }, [isNearMessagesBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: toolLog.length and editProposals.length trigger scroll on new activity
  useEffect(() => {
    const root = messagesRef.current;
    if (!root || (messageCount === 0 && !sending)) return;
    if (!pinnedToBottomRef.current && !isNearMessagesBottom(root)) return;
    root.scrollTop = root.scrollHeight;
  }, [editProposals.length, isNearMessagesBottom, messageCount, sending, toolLog.length]);

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
      pinnedToBottomRef.current = isNearMessagesBottom(activeMessages);
      event.preventDefault();
    };

    const onScroll = () => {
      if (!messagesRef.current) return;
      pinnedToBottomRef.current = isNearMessagesBottom(messagesRef.current);
    };

    panel.addEventListener('wheel', onWheel, { passive: false });
    messages.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      panel.removeEventListener('wheel', onWheel);
      messages.removeEventListener('scroll', onScroll);
    };
  }, [isNearMessagesBottom]);

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

  const retryLastUserMessage = useCallback(async () => {
    try {
      setActionError(null);
      await onRetryLastUserMessage();
    } catch (error) {
      setActionError(getActionErrorMessage(error, 'Failed to retry Reader AI message.'));
    }
  }, [getActionErrorMessage, onRetryLastUserMessage]);

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

  const composer = (
    <div
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
            if (
              (event.metaKey || event.ctrlKey) &&
              !event.altKey &&
              !event.shiftKey &&
              event.key.toLowerCase() === 'k'
            ) {
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
            <button type="button" class="reader-ai-history-back-btn" onClick={returnToChatView}>
              <ArrowLeft size={14} aria-hidden="true" />
              <span>Back to chat</span>
            </button>
            <div class="reader-ai-history-view-title-group">
              <div class="reader-ai-history-view-title">History</div>
              <div class="reader-ai-history-view-subtitle">
                {runs.length === 0 ? 'No runs yet' : `${runs.length} run${runs.length === 1 ? '' : 's'} recorded`}
              </div>
            </div>
          </div>
          <div class="reader-ai-history-view-body">
            {runs.length > 0 ? (
              <ReaderAiRunHistorySection runs={runs} activeRunId={activeRunId} onRetryStep={retryRunStep} />
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
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`}>
                <div class={`reader-ai-message reader-ai-message--${message.role}`}>
                  <div class="reader-ai-message-role">
                    {message.role === 'user' ? (
                      <>
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
                                    disabled={sending || !selectedModel || index !== lastUserMessageIndex}
                                    onSelect={() => {
                                      void retryLastUserMessage();
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
                      </>
                    ) : (
                      <>
                        <span>Reader AI</span>
                        {message.edited ? <span class="reader-ai-message-edited">Edited</span> : null}
                      </>
                    )}
                  </div>
                  {message.role === 'assistant' ? (
                    sending && index === messageCount - 1 && !message.content.trim() ? (
                      <div class="reader-ai-thinking">
                        <span class="reader-ai-thinking-spinner" aria-hidden="true" />
                        <span>{thinkingSeconds >= 5 ? `Thinking... (${thinkingSeconds} seconds)` : 'Thinking...'}</span>
                      </div>
                    ) : (
                      <ReaderAiAssistantMessage
                        content={message.content}
                        streaming={sending && index === messageCount - 1}
                        onRendered={sending && index === messageCount - 1 ? maybeScrollMessagesToBottom : undefined}
                      />
                    )
                  ) : editingIndex === index ? (
                    <div class="reader-ai-inline-edit">
                      <textarea
                        ref={editInputRef}
                        class="reader-ai-inline-edit-input"
                        value={editingDraft}
                        onInput={(event) => setEditingDraft(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            !event.shiftKey &&
                            !event.altKey &&
                            !event.metaKey &&
                            !event.ctrlKey
                          ) {
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
                {index === lastUserMessageIndex ? (
                  <>
                    {toolLog.length > 0 ? (
                      <ToolLogSection
                        entries={toolLog}
                        live={sending}
                        proposals={editProposals}
                        proposalStatusesByToolCallId={proposalStatusesByToolCallId}
                        onAcceptProposal={onAcceptProposal}
                        onRejectProposal={onRejectProposal}
                        onToggleProposalHunkSelection={onToggleProposalHunkSelection}
                      />
                    ) : null}
                    {sending && toolStatus && toolLog.length === 0 ? (
                      <div class="reader-ai-tool-status">{toolStatus}</div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ))}
            {lastUserMessageIndex === -1 ? (
              <>
                {toolLog.length > 0 ? (
                  <ToolLogSection
                    entries={toolLog}
                    live={sending}
                    proposals={editProposals}
                    proposalStatusesByToolCallId={proposalStatusesByToolCallId}
                    onAcceptProposal={onAcceptProposal}
                    onRejectProposal={onRejectProposal}
                    onToggleProposalHunkSelection={onToggleProposalHunkSelection}
                  />
                ) : null}
                {sending && toolStatus && toolLog.length === 0 ? (
                  <div class="reader-ai-tool-status">{toolStatus}</div>
                ) : null}
              </>
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
                onRevealChange={onRevealChange}
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
            {composerAtTop ? null : <div class="reader-ai-messages-bottom-spacer" aria-hidden="true" />}
            {composerAtTop ? null : composer}
          </div>
          {statusText ? <div class="reader-ai-status">{statusText}</div> : null}
        </>
      )}
    </aside>
  );
}
