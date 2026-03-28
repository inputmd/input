import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowRight, CircleAlert, CircleStop, MoreHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseMarkdownToHtml } from '../markdown';
import type { ReaderAiModel, ReaderAiStagedChange } from '../reader_ai';
import { ReaderAiModelSelector } from './ReaderAiModelSelector';
import { StagedChangesSection } from './ReaderAiStagedChanges';
import { type ReaderAiToolLogEntry, ToolLogSection } from './ReaderAiToolLog';
import { blurOnClose } from '../dom_utils';

export type { ReaderAiToolLogEntry } from './ReaderAiToolLog';

export interface ReaderAiMessage {
  role: 'user' | 'assistant';
  content: string;
  edited?: boolean;
}

interface ReaderAiPanelProps {
  models: ReaderAiModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  localCodexEnabled?: boolean;
  onEnableLocalCodex?: () => void;
  showLoginForMoreModels?: boolean;
  messages: ReaderAiMessage[];
  sending: boolean;
  toolStatus: string | null;
  toolLog: ReaderAiToolLogEntry[];
  stagedChanges: ReaderAiStagedChange[];
  suggestedCommitMessage: string;
  applyingChanges: boolean;
  stagedChangesDisabledHint?: string;
  canApplyWithoutSaving: boolean;
  canApplyAndCommit: boolean;
  onApplyWithoutSaving: () => void;
  onApplyAndCommit: (commitMessage?: string) => void;
  error: string | null;
  onSend: (prompt: string) => Promise<boolean>;
  onEditMessage: (index: number, content: string) => Promise<void>;
  onRetryLastUserMessage: () => Promise<void>;
  onStop: () => void;
  onClear: () => void;
  repoModeAvailable: boolean;
  repoModeEnabled: boolean;
  selectionModeEnabled?: boolean;
  repoModeLoading: boolean;
  repoModeFileCount: number;
  repoModeDisabledReason: string | null;
  suggestProjectMode?: boolean;
  onToggleRepoMode: (enabled: boolean) => void;
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

function ReaderAiAssistantMessage({ content, streaming }: { content: string; streaming: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    root.innerHTML = parseMarkdownToHtml(content);
    if (!streaming) return;

    const spinner = document.createElement('span');
    spinner.className = 'reader-ai-thinking-spinner reader-ai-thinking-spinner--inline';
    spinner.setAttribute('aria-hidden', 'true');

    const host = findInlineSpinnerHost(root);
    host.append(' ', spinner);
  }, [content, streaming]);

  return <div ref={contentRef} class="reader-ai-message-content rendered-markdown" />;
}

export function ReaderAiPanel({
  models,
  modelsLoading,
  modelsError,
  selectedModel,
  onSelectModel,
  localCodexEnabled = false,
  onEnableLocalCodex,
  showLoginForMoreModels = false,
  messages,
  sending,
  toolStatus,
  toolLog,
  stagedChanges,
  suggestedCommitMessage,
  applyingChanges,
  stagedChangesDisabledHint,
  canApplyWithoutSaving,
  canApplyAndCommit,
  onApplyWithoutSaving,
  onApplyAndCommit,
  error,
  onSend,
  onEditMessage,
  onRetryLastUserMessage,
  onStop,
  onClear,
  repoModeAvailable,
  repoModeEnabled,
  selectionModeEnabled = false,
  repoModeLoading,
  repoModeFileCount,
  repoModeDisabledReason,
  suggestProjectMode,
  onToggleRepoMode,
}: ReaderAiPanelProps) {
  const isMac = typeof navigator !== 'undefined' && /(mac|iphone|ipad|ipod)/i.test(navigator.platform ?? '');
  const clearChatShortcutLabel = isMac ? '⌘K' : 'Ctrl+K';
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const thinkingStartedAtRef = useRef<number | null>(null);
  const pendingFocusAfterClearRef = useRef(false);
  const messageCount = messages.length;
  const canSend = draft.trim().length > 0 && !sending && Boolean(selectedModel);
  const hasMessages = messageCount > 0;
  const composerAtTop = !hasMessages;
  const statusText = useMemo(() => {
    if (modelsLoading) return 'Loading free models...';
    if (modelsError) return modelsError;
    if (!selectedModel) return 'No free model available.';
    return null;
  }, [modelsLoading, modelsError, selectedModel]);
  const composerInputDisabled = sending || !selectedModel;
  let lastUserMessageIndex = -1;
  for (let i = messageCount - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMessageIndex = i;
      break;
    }
  }
  const composerPlaceholder = repoModeEnabled
    ? 'Ask about this project...'
    : selectionModeEnabled
      ? 'Ask about this selection...'
      : 'Ask about this document...';
  const isAssistantThinking =
    sending &&
    messageCount > 0 &&
    messages[messageCount - 1].role === 'assistant' &&
    messages[messageCount - 1].content.trim().length === 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: toolLog.length triggers scroll on new tool activity
  useEffect(() => {
    const root = messagesRef.current;
    if (!root || (messageCount === 0 && !sending)) return;
    // Only auto-scroll if the user is already near the bottom (within 80px).
    // This prevents yanking the viewport away when the user scrolled up to read.
    const distanceFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
    if (distanceFromBottom > 80) return;
    root.scrollTop = root.scrollHeight;
  }, [messageCount, sending, toolLog.length]);

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
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  });

  useEffect(() => {
    if (hasMessages || !pendingFocusAfterClearRef.current) return;
    pendingFocusAfterClearRef.current = false;
    const input = composerInputRef.current;
    if (!input || input.disabled) return;
    requestAnimationFrame(() => input.focus());
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
      event.preventDefault();
    };

    panel.addEventListener('wheel', onWheel, { passive: false });
    return () => panel.removeEventListener('wheel', onWheel);
  }, []);

  const submit = async () => {
    const draftValue = draft;
    const prompt = draftValue.trim();
    if (!prompt || !canSend) return;
    setDraft('');
    const ok = await onSend(prompt);
    if (!ok) setDraft(draftValue);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingDraft('');
  };

  const applyEdit = async () => {
    if (editingIndex === null || sending || !selectedModel) return;
    const nextValue = editingDraft.trim();
    if (!nextValue) return;
    await onEditMessage(editingIndex, nextValue);
    cancelEdit();
  };

  const clearChat = (focusComposer: boolean) => {
    if (!hasMessages) return;
    pendingFocusAfterClearRef.current = focusComposer;
    onClear();
  };

  const handleSelectModel = (modelId: string) => {
    onSelectModel(modelId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const input = composerInputRef.current;
        if (!input || input.disabled) return;
        input.focus();
      });
    });
  };

  const composer = (
    <div
      class={`reader-ai-input-wrap reader-ai-input-wrap--composer${composerAtTop ? '' : ' reader-ai-input-wrap--composer-bottom'}`}
    >
      <DropdownMenu.Root onOpenChange={blurOnClose}>
        <DropdownMenu.Trigger asChild>
          <button type="button" class="reader-ai-composer-menu-trigger" aria-label="Reader AI chat actions">
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="reader-ai-composer-menu" sideOffset={6} align="end">
            <DropdownMenu.Item class="reader-ai-composer-menu-item" onSelect={() => clearChat(true)}>
              <span>Clear chat</span>
              <span class="reader-ai-composer-menu-item-shortcut" aria-hidden="true">
                {clearChatShortcutLabel}
              </span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ReaderAiModelSelector
        models={models}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        selectedModel={selectedModel}
        onSelectModel={handleSelectModel}
        localCodexEnabled={localCodexEnabled}
        onEnableLocalCodex={onEnableLocalCodex}
        disabled={sending}
        triggerClassName="reader-ai-model-trigger reader-ai-model-trigger--composer"
        showLoginForMoreModels={showLoginForMoreModels}
      />
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
          if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
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
  );

  return (
    <aside ref={panelRef} class="reader-ai-panel" aria-label="Reader AI panel">
      {repoModeAvailable ? (
        <div
          class="reader-ai-repo-mode"
          title={repoModeDisabledReason ?? (repoModeEnabled ? 'Disable repo-wide context' : 'Enable repo-wide context')}
        >
          <label class="reader-ai-toggle">
            <input
              type="checkbox"
              checked={repoModeEnabled}
              disabled={sending || repoModeLoading || Boolean(repoModeDisabledReason)}
              onChange={(e) => onToggleRepoMode(e.currentTarget.checked)}
            />
            <span class="reader-ai-toggle-track">
              <span class="reader-ai-toggle-thumb" />
            </span>
          </label>
          <span
            class={`reader-ai-repo-mode-label${repoModeDisabledReason ? ' reader-ai-repo-mode-label--disabled' : ''}`}
          >
            {repoModeEnabled ? `Project mode on (${repoModeFileCount} files)` : 'Project mode off'}
          </span>
        </div>
      ) : null}
      <div class="reader-ai-messages" ref={messagesRef}>
        {composerAtTop ? composer : null}
        {!hasMessages ? (
          <div class="reader-ai-empty">
            {repoModeEnabled ? (
              <>
                <button
                  type="button"
                  class="reader-ai-summarize-btn"
                  disabled={composerInputDisabled}
                  onClick={() =>
                    void onSend('Explain this project, including its purpose, structure, and key entry points.')
                  }
                >
                  Explain project
                </button>
                <button
                  type="button"
                  class="reader-ai-summarize-btn"
                  disabled={composerInputDisabled}
                  onClick={() => void onSend('Review the code for potential bugs, issues, or improvements.')}
                >
                  Review code
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  class="reader-ai-summarize-btn"
                  disabled={composerInputDisabled}
                  onClick={() =>
                    void onSend(selectionModeEnabled ? 'Summarize this selection.' : 'Summarize this document.')
                  }
                >
                  Summarize
                </button>
                <button
                  type="button"
                  class="reader-ai-summarize-btn"
                  disabled={composerInputDisabled}
                  onClick={() =>
                    void onSend(
                      selectionModeEnabled
                        ? 'Identify any questions raised by this selection.'
                        : 'Identify any questions raised by this document.',
                    )
                  }
                >
                  Identify questions
                </button>
              </>
            )}
          </div>
        ) : null}
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`}>
            <div class={`reader-ai-message reader-ai-message--${message.role}`}>
              <div class="reader-ai-message-role">
                {message.role === 'user' ? (
                  <>
                    <span>You</span>
                    {editingIndex === index ? (
                      <span class="reader-ai-message-actions">
                        <button
                          type="button"
                          class="reader-ai-message-action-btn"
                          onClick={cancelEdit}
                          disabled={sending}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          class="reader-ai-message-action-btn"
                          onClick={() => void applyEdit()}
                          disabled={sending || !selectedModel || editingDraft.trim().length === 0}
                        >
                          Save
                        </button>
                      </span>
                    ) : (
                      <span class="reader-ai-message-actions">
                        {!sending && index === lastUserMessageIndex ? (
                          <button
                            type="button"
                            class="reader-ai-message-action-btn"
                            onClick={() => void onRetryLastUserMessage()}
                            disabled={sending || !selectedModel}
                          >
                            Retry
                          </button>
                        ) : null}
                        <button
                          type="button"
                          class="reader-ai-message-action-btn"
                          onClick={() => {
                            setEditingIndex(index);
                            setEditingDraft(message.content);
                          }}
                          disabled={sending || !selectedModel}
                        >
                          Edit
                        </button>
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
                  />
                )
              ) : editingIndex === index ? (
                <textarea
                  ref={editInputRef}
                  class="reader-ai-inline-edit-input"
                  value={editingDraft}
                  onInput={(event) => setEditingDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void applyEdit();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                  rows={3}
                  disabled={sending || !selectedModel}
                />
              ) : (
                <div class="reader-ai-message-content">{message.content}</div>
              )}
            </div>
            {index === lastUserMessageIndex ? (
              <>
                {toolLog.length > 0 ? <ToolLogSection entries={toolLog} live={sending} /> : null}
                {sending && toolStatus && toolLog.length === 0 ? (
                  <div class="reader-ai-tool-status">{toolStatus}</div>
                ) : null}
              </>
            ) : null}
          </div>
        ))}
        {lastUserMessageIndex === -1 ? (
          <>
            {toolLog.length > 0 ? <ToolLogSection entries={toolLog} live={sending} /> : null}
            {sending && toolStatus && toolLog.length === 0 ? (
              <div class="reader-ai-tool-status">{toolStatus}</div>
            ) : null}
          </>
        ) : null}
        {!sending && suggestProjectMode ? (
          <div class="reader-ai-suggest-project-mode" role="status" aria-live="polite">
            <div class="reader-ai-suggest-project-mode-copy">
              <span class="reader-ai-suggest-project-mode-icon" aria-hidden="true">
                <CircleAlert size={14} />
              </span>
              <span class="reader-ai-suggest-project-mode-text">
                <span>This question may need access to other files in the project.</span>
              </span>
            </div>
            <button
              type="button"
              class="reader-ai-suggest-project-mode-btn"
              onClick={() => onToggleRepoMode(true)}
              disabled={repoModeLoading}
            >
              {repoModeLoading ? 'Loading...' : 'Enable project mode'}
            </button>
          </div>
        ) : null}
        {!sending && stagedChanges.length > 0 ? (
          <StagedChangesSection
            changes={stagedChanges}
            defaultCommitMessage={suggestedCommitMessage}
            applying={applyingChanges}
            canApplyWithoutSaving={canApplyWithoutSaving}
            canApplyAndCommit={canApplyAndCommit}
            disabledHint={stagedChangesDisabledHint}
            onApplyWithoutSaving={onApplyWithoutSaving}
            onApplyAndCommit={onApplyAndCommit}
          />
        ) : null}
        {error ? <div class="reader-ai-error reader-ai-error--inline">{error}</div> : null}
        {composerAtTop ? null : <div class="reader-ai-messages-bottom-spacer" aria-hidden="true" />}
        {composerAtTop ? null : composer}
      </div>
      {statusText ? <div class="reader-ai-status">{statusText}</div> : null}
    </aside>
  );
}
