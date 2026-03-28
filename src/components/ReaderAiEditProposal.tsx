import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useMemo, useState } from 'preact/hooks';
import type { ReaderAiEditProposal } from '../reader_ai';
import { UnifiedDiffView } from './DiffViewer';

const COLLAPSE_THRESHOLD = 20;

function countDiffChangedLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function EditProposalCard({
  proposal,
  onAccept,
  onReject,
  disabled = false,
}: {
  proposal: ReaderAiEditProposal;
  onAccept: () => void;
  onReject: () => void;
  disabled?: boolean;
}) {
  const stats = useMemo(() => countDiffChangedLines(proposal.diff), [proposal.diff]);
  const totalChangedLines = stats.added + stats.removed;
  const isLong = totalChangedLines > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);

  const statusClass =
    proposal.status === 'accepted'
      ? ' reader-ai-edit-proposal--accepted'
      : proposal.status === 'rejected'
        ? ' reader-ai-edit-proposal--rejected'
        : '';

  const typeLabel = proposal.type === 'create' ? 'new' : proposal.type === 'delete' ? 'del' : 'edit';

  return (
    <div class={`reader-ai-edit-proposal${statusClass}`}>
      <div class="reader-ai-edit-proposal-header">
        <button
          type="button"
          class="reader-ai-edit-proposal-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span class={`reader-ai-staged-change-type reader-ai-staged-change-type--${proposal.type}`}>{typeLabel}</span>
          <span class="reader-ai-edit-proposal-path">{proposal.path}</span>
          <span class="reader-ai-staged-change-stats">
            {stats.added > 0 ? <span class="reader-ai-staged-change-stat--add">+{stats.added}</span> : null}
            {stats.added > 0 && stats.removed > 0 ? ' ' : null}
            {stats.removed > 0 ? <span class="reader-ai-staged-change-stat--del">-{stats.removed}</span> : null}
          </span>
        </button>
        <div class="reader-ai-edit-proposal-actions">
          {proposal.status === 'pending' ? (
            <>
              <button
                type="button"
                class="reader-ai-edit-proposal-btn reader-ai-edit-proposal-btn--accept"
                onClick={onAccept}
                disabled={disabled}
                title="Accept this change"
                aria-label="Accept"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                class="reader-ai-edit-proposal-btn reader-ai-edit-proposal-btn--reject"
                onClick={onReject}
                disabled={disabled}
                title="Reject this change"
                aria-label="Reject"
              >
                <X size={13} />
              </button>
            </>
          ) : (
            <span class="reader-ai-edit-proposal-status-label">
              {proposal.status === 'accepted' ? 'Accepted' : 'Rejected'}
            </span>
          )}
        </div>
      </div>
      {expanded ? (
        <div class="reader-ai-edit-proposal-diff">
          <UnifiedDiffView diff={proposal.diff} />
        </div>
      ) : null}
    </div>
  );
}
