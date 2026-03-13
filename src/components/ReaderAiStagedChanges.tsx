import { ChevronDown, ChevronRight, Maximize2 } from 'lucide-react';
import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { ReaderAiStagedChange } from '../reader_ai';
import { SideBySideDiffView, UnifiedDiffView } from './DiffViewer';

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
  defaultCommitMessage,
  applying,
  canApplyWithoutSaving,
  canApplyAndCommit,
  disabledHint,
  onApplyWithoutSaving,
  onApplyAndCommit,
}: {
  changes: ReaderAiStagedChange[];
  defaultCommitMessage: string;
  applying: boolean;
  canApplyWithoutSaving?: boolean;
  canApplyAndCommit?: boolean;
  disabledHint?: string;
  onApplyWithoutSaving?: () => void;
  onApplyAndCommit?: (commitMessage?: string) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(changes.map((change) => change.path)));
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const canApply = canApplyWithoutSaving || canApplyAndCommit;

  useEffect(() => {
    setExpandedPaths(new Set(changes.map((change) => change.path)));
  }, [changes]);

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

  return (
    <div class="reader-ai-staged-changes">
      <div class="reader-ai-staged-changes-header">
        <span>
          Staged changes ({changes.length} file{changes.length === 1 ? '' : 's'})
        </span>
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
        <div key={change.path} class="reader-ai-staged-change">
          <button type="button" class="reader-ai-staged-change-header" onClick={() => togglePath(change.path)}>
            {expandedPaths.has(change.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span class={`reader-ai-staged-change-type reader-ai-staged-change-type--${change.type}`}>
              {typeLabel(change.type)}
            </span>
            <span class="reader-ai-staged-change-path">{change.path}</span>
          </button>
          {expandedPaths.has(change.path) ? <UnifiedDiffView diff={change.diff} /> : null}
        </div>
      ))}
      {canApply ? (
        <div class="reader-ai-staged-changes-footer">
          {canApplyAndCommit ? (
            <input
              type="text"
              class="reader-ai-staged-changes-commit-input"
              placeholder="Commit message (optional)"
              value={commitMessage}
              onInput={(e) => setCommitMessage(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !applying) {
                  e.preventDefault();
                  onApplyAndCommit?.(commitMessage.trim() || undefined);
                }
              }}
              disabled={applying}
            />
          ) : null}
          {canApplyWithoutSaving || canApplyAndCommit ? (
            <div class="reader-ai-staged-changes-actions">
              {canApplyWithoutSaving ? (
                <button
                  type="button"
                  class="reader-ai-staged-changes-apply"
                  onClick={() => onApplyWithoutSaving?.()}
                  disabled={applying}
                >
                  {applying && !canApplyAndCommit ? 'Applying…' : 'Apply without saving'}
                </button>
              ) : null}
              {canApplyAndCommit ? (
                <button
                  type="button"
                  class="reader-ai-staged-changes-apply"
                  onClick={() => onApplyAndCommit?.(commitMessage.trim() || undefined)}
                  disabled={applying}
                >
                  {applying ? 'Committing…' : 'Apply and commit'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div class="reader-ai-staged-changes-footer reader-ai-staged-changes-footer--readonly">
          {disabledHint ?? 'Read-only — no write access'}
        </div>
      )}
      {popoutOpen ? <SideBySideDiffModal changes={changes} onClose={() => setPopoutOpen(false)} /> : null}
    </div>
  );
}
