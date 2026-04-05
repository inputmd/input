import { CheckSquare2, ChevronDown, ChevronRight, LocateFixed, Maximize2, Square, X } from 'lucide-react';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ReaderAiStagedChange, ReaderAiStagedHunk } from '../reader_ai';
import { SideBySideDiffView, UnifiedDiffView } from './DiffViewer';
import { buildUnifiedDiffFromHunk } from './diff_viewer_utils.ts';

const DEFAULT_EXPANDED_CHANGE_LINE_LIMIT = 80;

function shouldExpandChangeByDefault(change: ReaderAiStagedChange): boolean {
  const diffLines = change.diff.split('\n');
  if (change.type !== 'edit') return diffLines.length <= DEFAULT_EXPANDED_CHANGE_LINE_LIMIT;
  return diffLines.length <= DEFAULT_EXPANDED_CHANGE_LINE_LIMIT;
}

function SideBySideDiffModal({ changes, onClose }: { changes: ReaderAiStagedChange[]; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div class="reader-ai-diff-popout-overlay" role="dialog" aria-modal="true" aria-label="Staged changes side by side">
      <div class="reader-ai-diff-popout-backdrop" onClick={onClose} />
      <div class="reader-ai-diff-popout">
        <div class="reader-ai-diff-popout-header">
          <div class="reader-ai-diff-popout-title">
            Staged changes ({changes.length} file{changes.length === 1 ? '' : 's'})
          </div>
          <button type="button" class="reader-ai-diff-popout-close" onClick={onClose}>
            Close
          </button>
        </div>
        <SideBySideDiffView changes={changes} />
      </div>
    </div>,
    document.body,
  );
}

export function StagedChangesSection({
  changes,
  applying,
  streaming,
  title,
  reviewControls = true,
  editorProposalMode,
  canUndoEditorApply,
  selectedChangeIds,
  selectedHunkIds,
  canApplyWithoutSaving,
  applyDisabledReasonLabel,
  currentEditorPath,
  activeReviewTarget,
  activeReviewTargetRevealToken = 0,
  onIgnoreAll,
  onRevealChange,
  onRevealHunk,
  onToggleChangeSelection,
  onToggleHunkSelection,
  onRejectChange,
  onRejectHunk,
  onApplyWithoutSaving,
  onUndoEditorApply,
}: {
  changes: ReaderAiStagedChange[];
  applying: boolean;
  streaming?: boolean;
  title?: string;
  reviewControls?: boolean;
  editorProposalMode?: boolean;
  canUndoEditorApply?: boolean;
  selectedChangeIds?: Set<string>;
  selectedHunkIds?: Record<string, Set<string>>;
  canApplyWithoutSaving?: boolean;
  applyDisabledReasonLabel?: string | null;
  currentEditorPath?: string | null;
  activeReviewTarget?: { changeId: string; hunkId?: string } | null;
  activeReviewTargetRevealToken?: number;
  onIgnoreAll?: () => void;
  onRevealChange?: (changeId: string) => void;
  onRevealHunk?: (changeId: string, hunkId: string) => void;
  onToggleChangeSelection?: (changeId: string, selected: boolean) => void;
  onToggleHunkSelection?: (changeId: string, hunkId: string, selected: boolean) => void;
  onRejectChange?: (changeId: string) => void;
  onRejectHunk?: (changeId: string, hunkId: string) => void;
  onApplyWithoutSaving?: () => void;
  onUndoEditorApply?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastHandledRevealTokenRef = useRef(0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(changes.filter((change) => shouldExpandChangeByDefault(change)).map((change) => change.path)),
  );
  const [popoutOpen, setPopoutOpen] = useState(false);
  const canApply = canApplyWithoutSaving === true;
  const canDiscard = typeof onIgnoreAll === 'function';
  const applyLabelBase = editorProposalMode ? 'Apply changes' : 'Apply without saving';
  const applyLabel =
    !canApply && applyDisabledReasonLabel ? `${applyLabelBase} (${applyDisabledReasonLabel})` : applyLabelBase;

  useEffect(() => {
    setExpandedPaths((prev) => {
      const next = new Set<string>();
      for (const change of changes) {
        if (prev.has(change.path) || shouldExpandChangeByDefault(change)) next.add(change.path);
      }
      return next;
    });
  }, [changes]);

  useEffect(() => {
    if (!activeReviewTarget) return;
    const targetChange = changes.find((change) => change.id === activeReviewTarget.changeId);
    if (!targetChange) return;
    setExpandedPaths((prev) => {
      if (prev.has(targetChange.path)) return prev;
      const next = new Set(prev);
      next.add(targetChange.path);
      return next;
    });
  }, [activeReviewTarget, changes]);

  useEffect(() => {
    if (!activeReviewTarget) return;
    if (activeReviewTargetRevealToken <= 0 || lastHandledRevealTokenRef.current === activeReviewTargetRevealToken)
      return;
    lastHandledRevealTokenRef.current = activeReviewTargetRevealToken;
    let flashResetId = 0;
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const selector = activeReviewTarget.hunkId
        ? `[data-reader-ai-review-target="hunk:${activeReviewTarget.changeId}:${activeReviewTarget.hunkId}"]`
        : `[data-reader-ai-review-target="change:${activeReviewTarget.changeId}"]`;
      const target = root.querySelector<HTMLElement>(selector);
      if (!target) return;
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      target.classList.remove('reader-ai-staged-review-target-flash');
      void target.offsetWidth;
      target.classList.add('reader-ai-staged-review-target-flash');
      flashResetId = window.setTimeout(() => {
        target.classList.remove('reader-ai-staged-review-target-flash');
      }, 1800);
    });
    return () => {
      if (flashResetId) window.clearTimeout(flashResetId);
    };
  }, [activeReviewTarget, activeReviewTargetRevealToken]);

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
    return 'edit';
  };

  const renderSelectionToggle = (selected: boolean, label: string) =>
    selected ? <CheckSquare2 size={13} aria-label={label} /> : <Square size={13} aria-label={label} />;

  const hunkSummary = (hunk: ReaderAiStagedHunk) => {
    const additions = hunk.lines.filter((line) => line.type === 'add').length;
    const deletions = hunk.lines.filter((line) => line.type === 'del').length;
    return `${additions} add${additions === 1 ? '' : 's'} / ${deletions} del${deletions === 1 ? '' : 's'}`;
  };

  return (
    <div ref={rootRef} class="reader-ai-staged-changes">
      <div class="reader-ai-staged-changes-header">
        <div class="reader-ai-staged-changes-header-copy">
          <span>
            {title ?? (streaming ? 'Proposed changes' : 'Staged changes')} ({changes.length} file
            {changes.length === 1 ? '' : 's'})
          </span>
          {streaming ? (
            <span class="reader-ai-staged-changes-live-pill">
              <span class="reader-ai-staged-changes-live-dot" aria-hidden="true" />
              Streaming
            </span>
          ) : null}
        </div>
        <button
          type="button"
          class="reader-ai-staged-changes-popout"
          onClick={() => setPopoutOpen(true)}
          title="Pop out side-by-side diff"
          aria-label="Pop out side-by-side diff"
        >
          <Maximize2 size={13} />
        </button>
      </div>
      {changes.map((change) => (
        <div key={change.id ?? change.path} class="reader-ai-staged-change">
          <div
            class={`reader-ai-staged-change-header-row${
              activeReviewTarget?.changeId === change.id && !activeReviewTarget?.hunkId
                ? ' reader-ai-staged-review-target'
                : ''
            }`}
            data-reader-ai-review-target={change.id ? `change:${change.id}` : undefined}
          >
            <button
              type="button"
              class="reader-ai-staged-change-header"
              onClick={() => togglePath(change.path)}
              aria-expanded={expandedPaths.has(change.path)}
            >
              {expandedPaths.has(change.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span class={`reader-ai-staged-change-type reader-ai-staged-change-type--${change.type}`}>
                {typeLabel(change.type)}
              </span>
              <span class="reader-ai-staged-change-path">{change.path}</span>
            </button>
            {change.id && currentEditorPath === change.path ? (
              <button
                type="button"
                class="reader-ai-staged-reveal-btn"
                onClick={() => onRevealChange?.(change.id!)}
                title="Reveal this change in the editor"
              >
                <LocateFixed size={13} aria-hidden="true" />
              </button>
            ) : null}
            {!streaming && reviewControls && change.id ? (
              <div class="reader-ai-staged-change-controls">
                <button
                  type="button"
                  class={`reader-ai-staged-toggle-btn${
                    selectedChangeIds?.has(change.id) === false ? ' reader-ai-staged-toggle-btn--off' : ''
                  }`}
                  onClick={() => onToggleChangeSelection?.(change.id!, !(selectedChangeIds?.has(change.id!) === false))}
                  title={
                    selectedChangeIds?.has(change.id) === false
                      ? 'Accept this file back into apply set'
                      : 'Exclude this file from apply set'
                  }
                >
                  {renderSelectionToggle(selectedChangeIds?.has(change.id) !== false, 'Toggle file selection')}
                </button>
                <button
                  type="button"
                  class="reader-ai-staged-reject-btn button-danger"
                  onClick={() => onRejectChange?.(change.id!)}
                  title="Reject this file"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
          {expandedPaths.has(change.path) ? (
            <>
              {change.hunks && change.hunks.length > 0 && !streaming ? (
                <div class="reader-ai-staged-hunks">
                  {change.hunks.map((hunk) => {
                    const hunkSelected = change.id ? selectedHunkIds?.[change.id]?.has(hunk.id) !== false : true;
                    return (
                      <div
                        key={hunk.id}
                        class={`reader-ai-staged-hunk${hunkSelected ? '' : ' reader-ai-staged-hunk--off'}`}
                      >
                        <div
                          class={`reader-ai-staged-hunk-row${
                            activeReviewTarget?.changeId === change.id && activeReviewTarget?.hunkId === hunk.id
                              ? ' reader-ai-staged-review-target'
                              : ''
                          }`}
                          data-reader-ai-review-target={change.id ? `hunk:${change.id}:${hunk.id}` : undefined}
                        >
                          {reviewControls ? (
                            <button
                              type="button"
                              class={`reader-ai-staged-toggle-btn${hunkSelected ? '' : ' reader-ai-staged-toggle-btn--off'}`}
                              onClick={() => change.id && onToggleHunkSelection?.(change.id, hunk.id, !hunkSelected)}
                              title={
                                hunkSelected
                                  ? 'Exclude this hunk from apply set'
                                  : 'Accept this hunk back into apply set'
                              }
                            >
                              {renderSelectionToggle(hunkSelected, 'Toggle hunk selection')}
                            </button>
                          ) : null}
                          <div class="reader-ai-staged-hunk-copy">
                            <div class="reader-ai-staged-hunk-header">{hunk.header}</div>
                            <div class="reader-ai-staged-hunk-summary">{hunkSummary(hunk)}</div>
                          </div>
                          {change.id && currentEditorPath === change.path ? (
                            <button
                              type="button"
                              class="reader-ai-staged-reveal-btn"
                              onClick={() => onRevealHunk?.(change.id!, hunk.id)}
                              title="Reveal this hunk in the editor"
                            >
                              <LocateFixed size={13} aria-hidden="true" />
                            </button>
                          ) : null}
                          {reviewControls ? (
                            <button
                              type="button"
                              class="reader-ai-staged-reject-btn button-danger"
                              onClick={() => change.id && onRejectHunk?.(change.id, hunk.id)}
                              title="Reject this hunk"
                            >
                              <X size={13} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                        <UnifiedDiffView diff={buildUnifiedDiffFromHunk(hunk)} />
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {!change.hunks || change.hunks.length === 0 || streaming ? <UnifiedDiffView diff={change.diff} /> : null}
            </>
          ) : null}
        </div>
      ))}
      {streaming ? (
        <div class="reader-ai-staged-changes-footer reader-ai-staged-changes-footer--readonly">Still working...</div>
      ) : (
        <div class="reader-ai-staged-changes-footer">
          <div class="reader-ai-staged-changes-actions">
            {editorProposalMode && canUndoEditorApply ? (
              <button
                type="button"
                class="reader-ai-staged-changes-secondary"
                onClick={() => onUndoEditorApply?.()}
                disabled={applying}
              >
                Restore
              </button>
            ) : null}
            {canDiscard ? (
              <button
                type="button"
                class="reader-ai-staged-changes-secondary"
                onClick={() => onIgnoreAll?.()}
                disabled={applying}
              >
                Discard all changes
              </button>
            ) : null}
            <button
              type="button"
              class="reader-ai-staged-changes-apply button-success-solid"
              onClick={() => onApplyWithoutSaving?.()}
              disabled={applying || !canApply}
            >
              {applying ? 'Applying…' : applyLabel}
            </button>
          </div>
        </div>
      )}
      {popoutOpen ? <SideBySideDiffModal changes={changes} onClose={() => setPopoutOpen(false)} /> : null}
    </div>
  );
}
