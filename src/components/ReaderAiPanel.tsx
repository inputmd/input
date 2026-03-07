import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowRight, ChevronDown, CircleStop, MoreHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseMarkdownToHtml } from '../markdown';
import { type ReaderAiModel, readerAiModelPriorityRank } from '../reader_ai';

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
  error: string | null;
  onSend: (prompt: string) => Promise<boolean>;
  onEditMessage: (index: number, content: string) => Promise<void>;
  canRetryLastUserMessage: boolean;
  onRetryLastUserMessage: () => Promise<void>;
  onStop: () => void;
  onClear: () => void;
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
  error,
  onSend,
  onEditMessage,
  canRetryLastUserMessage,
  onRetryLastUserMessage,
  onStop,
  onClear,
}: ReaderAiPanelProps) {
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
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
  const composerPlaceholder = authenticated ? 'Ask AI...' : 'Sign in to enable chat';

  useEffect(() => {
    const root = messagesRef.current;
    if (!root || (messageCount === 0 && !sending)) return;
    root.scrollTop = root.scrollHeight;
  }, [messageCount, sending]);

  useEffect(() => {
    if (editingIndex === null) return;
    const input = editInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editingIndex]);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (!hasMessages || sending) return;
      onClear();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasMessages, onClear, sending]);

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

  const clearChat = () => {
    if (!hasMessages) return;
    onClear();
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
            <DropdownMenu.Item class="reader-ai-composer-menu-item" onSelect={clearChat}>
              Clear chat
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
            <DropdownMenu.RadioGroup value={selectedModel} onValueChange={onSelectModel}>
              {featuredModels.map((model) => (
                <DropdownMenu.RadioItem key={model.id} class="reader-ai-model-menu-item" value={model.id}>
                  {displayModelName(model.name)}
                </DropdownMenu.RadioItem>
              ))}

              {publicDatasetModels.length > 0 ? (
                <>
                  {hasDefaultSection ? <DropdownMenu.Separator class="reader-ai-model-menu-separator" /> : null}
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

              {unverifiedModels.length > 0 ? (
                <>
                  {hasDefaultSection || publicDatasetModels.length > 0 ? (
                    <DropdownMenu.Separator class="reader-ai-model-menu-separator" />
                  ) : null}
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
      <div class="reader-ai-messages" ref={messagesRef}>
        {composerAtTop ? composer : null}
        {!hasMessages ? <div class="reader-ai-empty"></div> : null}
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} class={`reader-ai-message reader-ai-message--${message.role}`}>
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
                      {canRetryLastUserMessage && index === messageCount - 1 ? (
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
              <div
                class="reader-ai-message-content rendered-markdown"
                dangerouslySetInnerHTML={{
                  __html:
                    sending && index === messageCount - 1 && !message.content.trim()
                      ? '<p>Thinking...</p>'
                      : parseMarkdownToHtml(message.content),
                }}
              />
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
        ))}
        {error ? <div class="reader-ai-error reader-ai-error--inline">{error}</div> : null}
        {composerAtTop ? null : composer}
      </div>
      {statusText ? <div class="reader-ai-status">{statusText}</div> : null}
    </aside>
  );
}
