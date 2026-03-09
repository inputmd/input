import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowRight, ChevronDown, CircleAlert, CircleStop, MoreHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseMarkdownToHtml } from '../markdown';
import { type ReaderAiModel, type ReaderAiStagedChange, readerAiModelPriorityRank } from '../reader_ai';
import { StagedChangesSection } from './ReaderAiStagedChanges';
import { type ReaderAiToolLogEntry, ToolLogSection } from './ReaderAiToolLog';

export type { ReaderAiToolLogEntry } from './ReaderAiToolLog';

export interface ReaderAiMessage {
  role: 'user' | 'assistant';
  content: string;
  edited?: boolean;
}

interface ReaderAiPanelProps {
  authenticated: boolean;
  models: ReaderAiModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
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
  repoModeLoading: boolean;
  repoModeFileCount: number;
  repoModeDisabledReason: string | null;
  suggestProjectMode?: boolean;
  onToggleRepoMode: (enabled: boolean) => void;
}

function displayModelName(name: string): string {
  return name.replace(/\s+\(free\)\s*$/i, '');
}

function isPublicDatasetModel(model: ReaderAiModel): boolean {
  const id = model.id.trim().toLowerCase();
  return id.includes('gpt-oss-120b') || id.includes('gpt-oss-20b');
}

export function ReaderAiPanel({
  authenticated,
  models,
  modelsLoading,
  modelsError,
  selectedModel,
  onSelectModel,
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
  const canSend = authenticated && draft.trim().length > 0 && !sending && Boolean(selectedModel);
  const hasMessages = messageCount > 0;
  const composerAtTop = !hasMessages;
  const modelSelectDisabled = modelsLoading || models.length === 0 || sending;
  const selectedModelName = displayModelName(models.find((model) => model.id === selectedModel)?.name ?? '');
  const modelTriggerLabel = selectedModelName || (modelsLoading ? 'Loading models...' : 'No models');
  const featuredModels = models.filter((model) => readerAiModelPriorityRank(model) !== -1);
  const nonFeaturedModels = models.filter((model) => readerAiModelPriorityRank(model) === -1);
  const publicDatasetModels = nonFeaturedModels.filter((model) => isPublicDatasetModel(model));
  const unverifiedModels = nonFeaturedModels.filter((model) => !isPublicDatasetModel(model));
  const hasDefaultSection = featuredModels.length > 0;
  const statusText = useMemo(() => {
    if (modelsLoading) return 'Loading free models...';
    if (modelsError) return modelsError;
    if (!selectedModel) return 'No free model available.';
    return null;
  }, [modelsLoading, modelsError, selectedModel]);
  const composerInputDisabled = sending || !selectedModel || !authenticated;
  let lastUserMessageIndex = -1;
  for (let i = messageCount - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMessageIndex = i;
      break;
    }
  }
  const composerPlaceholder = !authenticated
    ? 'Sign in to enable chat'
    : repoModeEnabled
      ? 'Ask about this project...'
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
      <DropdownMenu.Root>
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
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            class="reader-ai-model-trigger reader-ai-model-trigger--composer"
            aria-label="Reader AI model"
            disabled={modelSelectDisabled}
          >
            <span class="reader-ai-model-trigger-label">{modelTriggerLabel}</span>
            <ChevronDown size={14} class="reader-ai-model-trigger-icon" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="reader-ai-model-menu" sideOffset={6} align="start">
            <DropdownMenu.RadioGroup value={selectedModel} onValueChange={handleSelectModel}>
              {hasDefaultSection ? (
                <>
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Recommended free models
                  </DropdownMenu.Item>
                  {featuredModels.map((model) => (
                    <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                      {displayModelName(model.name)}
                    </DropdownMenu.RadioItem>
                  ))}
                </>
              ) : null}

              {unverifiedModels.length > 0 ? (
                <>
                  {hasDefaultSection ? <DropdownMenu.Separator class="reader-ai-model-menu-separator" /> : null}
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    Unverified free providers
                  </DropdownMenu.Item>
                  {unverifiedModels.map((model) => (
                    <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                      {displayModelName(model.name)}
                    </DropdownMenu.RadioItem>
                  ))}
                </>
              ) : null}

              {publicDatasetModels.length > 0 ? (
                <>
                  {hasDefaultSection || unverifiedModels.length > 0 ? (
                    <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  ) : null}
                  <DropdownMenu.Item class="reader-ai-model-menu-heading" disabled>
                    May publish to public datasets
                  </DropdownMenu.Item>
                  {publicDatasetModels.map((model) => (
                    <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                      {displayModelName(model.name)}
                    </DropdownMenu.RadioItem>
                  ))}
                </>
              ) : null}
            </DropdownMenu.RadioGroup>
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
          if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
            event.preventDefault();
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
                  onClick={() => void onSend('Summarize this document.')}
                >
                  Summarize
                </button>
                <button
                  type="button"
                  class="reader-ai-summarize-btn"
                  disabled={composerInputDisabled}
                  onClick={() => void onSend('Identify any questions raised by this document.')}
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
                  <div
                    class="reader-ai-message-content rendered-markdown"
                    dangerouslySetInnerHTML={{
                      __html: parseMarkdownToHtml(message.content),
                    }}
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
