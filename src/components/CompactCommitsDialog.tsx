import * as DialogPrimitive from '@radix-ui/react-dialog';
import { RefreshCw } from 'lucide-react';
import type { RecentRepoCommit } from '../github_app';

function formatCommitTimestamp(value: string | null): string {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function isHeadPrefixSelection(commits: RecentRepoCommit[], selectedShas: Set<string>): boolean {
  if (selectedShas.size < 2) return false;
  const headSha = commits[0]?.sha;
  if (!headSha || !selectedShas.has(headSha)) return false;

  let prefixLength = 0;
  while (prefixLength < commits.length && selectedShas.has(commits[prefixLength]!.sha)) {
    prefixLength += 1;
  }
  for (let i = prefixLength; i < commits.length; i += 1) {
    if (selectedShas.has(commits[i]!.sha)) return false;
  }
  for (let i = 0; i < prefixLength; i += 1) {
    if (commits[i]!.parentCount !== 1) return false;
  }
  return true;
}

function compactableHeadPrefixLength(commits: RecentRepoCommit[]): number {
  let prefixLength = 0;
  while (prefixLength < commits.length && commits[prefixLength]!.parentCount === 1) {
    prefixLength += 1;
  }
  return prefixLength;
}

interface CompactCommitsDialogProps {
  open: boolean;
  branch: string | null;
  commits: RecentRepoCommit[];
  hasMore: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  selectedShas: Set<string>;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onToggleCommit: (sha: string, checked: boolean) => void;
  onToggleAllCommits: () => void;
  onReload: () => void;
  onClose: () => void;
  onSubmit: () => void;
}

export function CompactCommitsDialog({
  open,
  branch,
  commits,
  hasMore,
  loading,
  submitting,
  error,
  selectedShas,
  commitMessage,
  onCommitMessageChange,
  onToggleCommit,
  onToggleAllCommits,
  onReload,
  onClose,
  onSubmit,
}: CompactCommitsDialogProps) {
  const selectionValid = isHeadPrefixSelection(commits, selectedShas);
  const selectedCount = selectedShas.size;
  const hasAnySelected = selectedCount > 0;
  const compactablePrefixLength = compactableHeadPrefixLength(commits);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen: boolean) => (!nextOpen ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay class="dialog-overlay" />
        <DialogPrimitive.Content class="dialog-content dialog-content--diff compact-commits-dialog">
          <DialogPrimitive.Title class="dialog-title">Compact recent commits</DialogPrimitive.Title>
          <div class="compact-commits-toolbar">
            <div class="compact-commits-toolbar-copy">
              <span>
                This rewrites <strong>{branch ? branch : 'Default branch'}</strong> and force pushes a replacement
                commit for the selected range.
              </span>
            </div>
            <div class="compact-commits-toolbar-actions">
              <button
                type="button"
                onClick={onToggleAllCommits}
                disabled={loading || submitting || commits.length === 0}
              >
                <span class="compact-commits-toolbar-button-label">
                  {hasAnySelected ? 'Deselect All' : 'Select All'}
                </span>
              </button>
              <button
                type="button"
                class="compact-commits-reload-button"
                onClick={onReload}
                disabled={loading || submitting}
                aria-label="Reload recent commits"
                title="Reload recent commits"
              >
                <RefreshCw size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
          <div class="compact-commits-list" role="list" aria-label="Recent commits">
            {loading ? <div class="compact-commits-state">Loading recent commits…</div> : null}
            {!loading && error ? <div class="compact-commits-state compact-commits-state--error">{error}</div> : null}
            {!loading && !error && commits.length === 0 ? (
              <div class="compact-commits-state">No recent commits were returned.</div>
            ) : null}
            {!loading && !error
              ? commits.map((commit, index) => {
                  const checked = selectedShas.has(commit.sha);
                  const disabled = submitting || index >= compactablePrefixLength;
                  return (
                    <label
                      key={commit.sha}
                      class={`compact-commits-item${checked ? ' compact-commits-item--selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={(event) => {
                          onToggleCommit(commit.sha, event.currentTarget.checked);
                        }}
                      />
                      <div class="compact-commits-item-body">
                        <div class="compact-commits-item-topline">
                          <span class="compact-commits-item-summary">{commit.summary || '(no commit message)'}</span>
                          <span class="compact-commits-item-sha">{commit.shortSha}</span>
                        </div>
                        <div class="compact-commits-item-meta">
                          <span>{commit.authorName || 'Unknown author'}</span>
                          <span>{formatCommitTimestamp(commit.committedAt ?? commit.authoredAt)}</span>
                          {commit.isHead ? <span class="compact-commits-badge">HEAD</span> : null}
                          {commit.parentCount !== 1 ? <span class="compact-commits-badge">Merge/root</span> : null}
                        </div>
                      </div>
                    </label>
                  );
                })
              : null}
          </div>
          <div class="compact-commits-footer">
            <label class="compact-commits-message-field">
              <span>New commit message</span>
              <input
                class="dialog-input compact-commits-message-input"
                type="text"
                value={commitMessage}
                onInput={(event) => onCommitMessageChange(event.currentTarget.value)}
                disabled={loading || submitting}
                placeholder="Compact recent commits"
              />
            </label>
            <div class="compact-commits-selection-note">
              {selectedCount === 0
                ? 'Select at least two recent commits.'
                : `${selectedCount} commit${selectedCount === 1 ? '' : 's'} selected.`}
              {!selectionValid && selectedCount > 0
                ? ' Selection must be a contiguous, non-merge range starting at HEAD.'
                : ''}
              {hasMore ? ' Older commits exist, but only this first page is loaded.' : ''}
            </div>
          </div>
          <div class="dialog-actions">
            <DialogPrimitive.Close asChild>
              <button type="button" disabled={submitting}>
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button
              type="button"
              class="dialog-action-danger"
              onClick={onSubmit}
              disabled={loading || submitting || !selectionValid || commitMessage.trim().length === 0}
            >
              {submitting ? 'Compacting…' : 'Compact and force push'}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
