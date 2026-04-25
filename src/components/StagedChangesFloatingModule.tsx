import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoWorkspaceChangedFileDetail } from '../repo_workspace/commit';

type StagedChangeSummaryKind = 'added' | 'deleted' | 'changed';

interface StagedChangeSummaryPart {
  kind: StagedChangeSummaryKind;
  text: string;
}

interface StagedChangeSummaryLine {
  key: string;
  parts: StagedChangeSummaryPart[];
}

interface StagedChangesFloatingModuleProps {
  stagedChangeCount: number;
  stagedChangeFiles: RepoWorkspaceChangedFileDetail[] | null;
  saveTarget?: 'repo' | 'gist';
  saving?: boolean;
  onSave?: () => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
  onRevertFile?: (file: RepoWorkspaceChangedFileDetail) => void | Promise<void>;
}

function pluralizeFiles(count: number, verb: string): string {
  return `${count} file${count === 1 ? '' : 's'} ${verb}`;
}

function pluralizeChangedItems(count: number, noun: string | null, verb: string): string {
  const itemLabel = noun ? ` ${noun}${count === 1 ? '' : 's'}` : '';
  return `${count}${itemLabel} ${verb}`;
}

function isInputChange(file: RepoWorkspaceChangedFileDetail): boolean {
  return file.label.split(' -> ').some((path) => path.startsWith('.input/'));
}

function summarizeChangedFileGroup(files: RepoWorkspaceChangedFileDetail[], noun: string): StagedChangeSummaryPart[] {
  const added = files.filter((file) => file.changeType === 'create').length;
  const deleted = files.filter((file) => file.changeType === 'delete').length;
  const changed = files.length - added - deleted;
  const counts = [
    { kind: 'added' as const, count: added, verb: 'added' },
    { kind: 'deleted' as const, count: deleted, verb: 'deleted' },
    { kind: 'changed' as const, count: changed, verb: 'changed' },
  ].filter((part) => part.count > 0);
  return counts.map((part, index) => ({
    kind: part.kind,
    text: pluralizeChangedItems(part.count, index === 0 ? noun : null, part.verb),
  }));
}

function summarizeStagedChanges(
  count: number,
  files: RepoWorkspaceChangedFileDetail[] | null,
): StagedChangeSummaryLine[] {
  if (files && files.length > 0) {
    const sessionFiles = files.filter(isInputChange);
    const workspaceFiles = files.filter((file) => !isInputChange(file));
    return [
      ...(sessionFiles.length > 0
        ? [{ key: 'sessions', parts: summarizeChangedFileGroup(sessionFiles, 'session file') }]
        : []),
      ...(workspaceFiles.length > 0
        ? [{ key: 'files', parts: summarizeChangedFileGroup(workspaceFiles, 'file') }]
        : []),
    ];
  }
  return count > 0 ? [{ key: 'files', parts: [{ kind: 'changed', text: pluralizeFiles(count, 'changed') }] }] : [];
}

function stagedFileStatParts(file: RepoWorkspaceChangedFileDetail): Array<{ className: string; text: string }> {
  if (file.added > 0 && file.removed === 0) {
    return [{ className: 'toolbar-save-status-tooltip-added', text: `+${file.added}` }];
  }
  if (file.removed > 0 && file.added === 0) {
    return [{ className: 'toolbar-save-status-tooltip-removed', text: `-${file.removed}` }];
  }
  return [
    { className: 'toolbar-save-status-tooltip-added', text: `+${file.added}` },
    { className: 'toolbar-save-status-tooltip-removed', text: `-${file.removed}` },
  ];
}

export function StagedChangesFloatingModule({
  stagedChangeCount,
  stagedChangeFiles,
  saveTarget = 'repo',
  saving = false,
  onSave,
  onDiscard,
  onRevertFile,
}: StagedChangesFloatingModuleProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const hoverRef = useRef({ content: false, trigger: false });
  const summaryLines = useMemo(
    () => summarizeStagedChanges(stagedChangeCount, stagedChangeFiles),
    [stagedChangeCount, stagedChangeFiles],
  );
  const summaryText =
    summaryLines.length > 0
      ? summaryLines.map((line) => line.parts.map((part) => part.text).join(', ')).join('; ')
      : null;
  const saveLabel = saveTarget === 'gist' ? 'Save to gist' : 'Commit changes';

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if ((stagedChangeFiles?.length ?? 0) > 0) return;
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setTooltipOpen(false);
  }, [stagedChangeFiles]);

  if (!summaryText) return null;

  const openTooltip = (): void => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setTooltipOpen(true);
  };

  const closeTooltipSoon = (): void => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
    }
    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null;
      if (hoverRef.current.trigger || hoverRef.current.content) return;
      setTooltipOpen(false);
    }, 120);
  };

  const setTooltipHover = (target: 'trigger' | 'content', hovered: boolean): void => {
    hoverRef.current = { ...hoverRef.current, [target]: hovered };
    if (hovered) {
      openTooltip();
    } else {
      closeTooltipSoon();
    }
  };

  const onTooltipOpenChange = (open: boolean): void => {
    if (open) {
      openTooltip();
    } else {
      closeTooltipSoon();
    }
  };

  const summary = (
    <span class="staged-changes-floating-summary" aria-label="Changed files" role="status" aria-live="polite">
      <span class="staged-changes-floating-summary-text">
        {summaryLines.map((line) => (
          <span key={line.key} class="staged-changes-floating-summary-line">
            {line.parts.map((part, index) => (
              <span key={part.kind}>
                {index > 0 ? ', ' : null}
                <span class={`staged-changes-floating-summary-part staged-changes-floating-summary-part--${part.kind}`}>
                  {part.text}
                </span>
              </span>
            ))}
          </span>
        ))}
      </span>
    </span>
  );

  const actions =
    onSave || onDiscard ? (
      <div class="staged-changes-floating-actions">
        {onDiscard ? (
          <button
            type="button"
            class="staged-changes-floating-action-btn staged-changes-floating-action-btn--discard"
            aria-label={`Discard changes for ${summaryText}`}
            disabled={saving}
            onClick={() => void onDiscard()}
          >
            Discard changes
          </button>
        ) : null}
        {onSave ? (
          <button
            type="button"
            class="staged-changes-floating-action-btn staged-changes-floating-action-btn--save"
            aria-label={`${saveLabel} for ${summaryText}`}
            disabled={saving}
            onClick={() => void onSave()}
          >
            {saving ? 'Saving...' : saveLabel}
          </button>
        ) : null}
      </div>
    ) : null;

  if ((stagedChangeFiles?.length ?? 0) === 0) {
    return (
      <div class="staged-changes-floating-module">
        <section class="staged-changes-floating-card" aria-label="Staged changes">
          {summary}
          {actions}
        </section>
      </div>
    );
  }

  return (
    <div class="staged-changes-floating-module">
      <Tooltip.Provider delayDuration={150}>
        <Tooltip.Root open={tooltipOpen} onOpenChange={onTooltipOpenChange}>
          <Tooltip.Trigger asChild>
            <section
              class="staged-changes-floating-card"
              aria-label="Staged changes"
              onMouseEnter={() => setTooltipHover('trigger', true)}
              onMouseLeave={() => setTooltipHover('trigger', false)}
            >
              {summary}
              {actions}
            </section>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              class="toolbar-save-status-tooltip"
              side="top"
              align="center"
              sideOffset={4}
              collisionPadding={4}
              onMouseEnter={() => setTooltipHover('content', true)}
              onMouseLeave={() => setTooltipHover('content', false)}
              onWheelCapture={openTooltip}
            >
              <div class="toolbar-save-status-tooltip-list" role="list" aria-label="Changed files">
                {[
                  { key: 'sessions', label: 'Sessions', files: stagedChangeFiles!.filter(isInputChange) },
                  {
                    key: 'workspace',
                    label: 'Workspace',
                    files: stagedChangeFiles!.filter((file) => !isInputChange(file)),
                  },
                ]
                  .filter((group) => group.files.length > 0)
                  .map((group) => (
                    <div key={group.key} class="toolbar-save-status-tooltip-group" role="group">
                      <div class="toolbar-save-status-tooltip-group-label">{group.label}</div>
                      {group.files.map((file, index) => (
                        <div
                          key={`${group.key}:${index}:${file.label}`}
                          class="toolbar-save-status-tooltip-item"
                          role="listitem"
                        >
                          <span class="toolbar-save-status-tooltip-path">{file.label}</span>
                          {file.binary ? (
                            <span class="toolbar-save-status-tooltip-binary">binary</span>
                          ) : (
                            <span class="toolbar-save-status-tooltip-stats">
                              {stagedFileStatParts(file).map((part) => (
                                <span key={part.className} class={part.className}>
                                  {part.text}
                                </span>
                              ))}
                            </span>
                          )}
                          {onRevertFile ? (
                            <button
                              type="button"
                              class="toolbar-save-status-tooltip-action"
                              disabled={saving}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void onRevertFile(file);
                              }}
                            >
                              Revert
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
              <Tooltip.Arrow class="toolbar-save-status-tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </div>
  );
}
