import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowRight, ChevronDown, ChevronRight, CircleAlert, CircleStop, MoreHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseMarkdownToHtml } from '../markdown';
import { type ReaderAiModel, type ReaderAiStagedChange, readerAiModelPriorityRank } from '../reader_ai';

export interface ReaderAiMessage {
  role: 'user' | 'assistant';
  content: string;
  edited?: boolean;
}

export interface ReaderAiToolLogEntry {
  type: 'call' | 'result';
  name: string;
  detail?: string;
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
  canApplyChanges: boolean;
  applyToEditor?: boolean;
  onApplyChanges: (commitMessage?: string) => void;
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

const TOOL_LABELS: Record<string, string> = {
  read_document: 'Read document',
  search_document: 'Search document',
  read_file: 'Read file',
  search_files: 'Search files',
  list_files: 'List files',
  edit_file: 'Edit file',
  create_file: 'Create file',
  delete_file: 'Delete file',
  task: 'Subagent',
};

function ToolLogSection({ entries, live }: { entries: ReaderAiToolLogEntry[]; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  const callEntries = entries.filter((e) => e.type === 'call');
  const callCount = callEntries.length;
  const summary = live
    ? `${callCount} tool call${callCount === 1 ? '' : 's'}…`
    : `${callCount} tool call${callCount === 1 ? '' : 's'}`;

  // Auto-expand while live
  const isExpanded = live || expanded;

  return (
    <div class="reader-ai-tool-log">
      <button type="button" class="reader-ai-tool-log-toggle" onClick={() => setExpanded(!expanded)}>
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{summary}</span>
      </button>
      {isExpanded ? (
        <div class="reader-ai-tool-log-entries">
          {callEntries.map((entry, i) => (
            <div key={i} class="reader-ai-tool-log-entry">
              <span class="reader-ai-tool-log-name">{TOOL_LABELS[entry.name] ?? entry.name}</span>
              {entry.detail ? (
                <span class="reader-ai-tool-log-detail">
                  {entry.detail.length > 60 ? `${entry.detail.slice(0, 60)}…` : entry.detail}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre class="reader-ai-diff">
      {lines.map((line, i) => {
        let cls = 'reader-ai-diff-line';
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' reader-ai-diff-line--header';
        else if (line.startsWith('@@')) cls += ' reader-ai-diff-line--hunk';
        else if (line.startsWith('+')) cls += ' reader-ai-diff-line--add';
        else if (line.startsWith('-')) cls += ' reader-ai-diff-line--del';
        return (
          <div key={i} class={cls}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

function StagedChangesSection({
  changes,
  defaultCommitMessage,
  applying,
  canApply,
  applyToEditor,
  onApply,
}: {
  changes: ReaderAiStagedChange[];
  defaultCommitMessage: string;
  applying: boolean;
  canApply: boolean;
  applyToEditor?: boolean;
  onApply: (commitMessage?: string) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  if (changes.length === 0) return null;

  const togglePath = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const typeLabel = (type: string) => {
    if (type === 'create') return 'new';
    if (type === 'delete') return 'del';
    return 'mod';
  };

  return (
    <div class="reader-ai-staged-changes">
      <div class="reader-ai-staged-changes-header">
        <span>
          Staged changes ({changes.length} file{changes.length === 1 ? '' : 's'})
        </span>
      </div>
      {changes.map((change) => (
        <div key={change.path} class="reader-ai-staged-change">
          <button type="button" class="reader-ai-staged-change-header" onClick={() => togglePath(change.path)}>
            {expandedPaths.has(change.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span class={`reader-ai-staged-change-type reader-ai-staged-change-type--${change.type}`}>
              {typeLabel(change.type)}
            </span>
            <span class="reader-ai-staged-change-path">{change.path}</span>
          </button>
          {expandedPaths.has(change.path) ? <DiffView diff={change.diff} /> : null}
        </div>
      ))}
      {canApply ? (
        <div class="reader-ai-staged-changes-footer">
          {applyToEditor ? null : (
            <input
              type="text"
              class="reader-ai-staged-changes-commit-input"
              placeholder="Commit message (optional)"
              value={commitMessage}
              onInput={(e) => setCommitMessage(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !applying) {
                  e.preventDefault();
                  onApply(commitMessage.trim() || undefined);
                }
              }}
              disabled={applying}
            />
          )}
          <button
            type="button"
            class="reader-ai-staged-changes-apply"
            onClick={() => onApply(applyToEditor ? undefined : commitMessage.trim() || undefined)}
            disabled={applying}
          >
            {applying ? 'Applying…' : applyToEditor ? 'Apply to editor' : 'Apply'}
          </button>
        </div>
      ) : (
        <div class="reader-ai-staged-changes-footer reader-ai-staged-changes-footer--readonly">
          Read-only — no write access
        </div>
      )}
    </div>
  );
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
  canApplyChanges,
  applyToEditor,
  onApplyChanges,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: toolLog.length triggers scroll on new tool activity
  useEffect(() => {
    const root = messagesRef.current;
    if (!root || (messageCount === 0 && !sending)) return;
    root.scrollTop = root.scrollHeight;
  }, [messageCount, sending, toolLog.length]);

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
            <DropdownMenu.Item class="reader-ai-composer-menu-item" onSelect={clearChat}>
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
                    <span>AI</span>
                    {message.edited ? <span class="reader-ai-message-edited">Edited</span> : null}
                  </>
                )}
              </div>
              {message.role === 'assistant' ? (
                sending && index === messageCount - 1 && !message.content.trim() ? (
                  <div class="reader-ai-thinking">
                    <span class="reader-ai-thinking-spinner" aria-hidden="true" />
                    <span>Thinking...</span>
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
            canApply={canApplyChanges}
            applyToEditor={applyToEditor}
            onApply={onApplyChanges}
          />
        ) : null}
        {error ? <div class="reader-ai-error reader-ai-error--inline">{error}</div> : null}
        {composerAtTop ? null : composer}
      </div>
      {statusText ? <div class="reader-ai-status">{statusText}</div> : null}
    </aside>
  );
}
