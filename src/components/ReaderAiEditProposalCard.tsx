import { CheckSquare2, ChevronDown, ChevronRight, Pencil, Square } from 'lucide-react';
import { useState } from 'preact/hooks';
import type { ReaderAiEditProposal, ReaderAiStagedHunk } from '../reader_ai';
import { UnifiedDiffView } from './DiffViewer';

const DEFAULT_EXPANDED_CHANGE_LINE_LIMIT = 80;

function shouldExpandChangeByDefault(proposal: ReaderAiEditProposal): boolean {
  return proposal.change.diff.split('\n').length <= DEFAULT_EXPANDED_CHANGE_LINE_LIMIT;
}

function typeLabel(type: string): string {
  if (type === 'create') return 'new';
  if (type === 'delete') return 'del';
  return 'edit';
}

function hunkSummary(hunk: ReaderAiStagedHunk): string {
  const additions = hunk.lines.filter((line) => line.type === 'add').length;
  const deletions = hunk.lines.filter((line) => line.type === 'del').length;
  return `${additions} add${additions === 1 ? '' : 's'} / ${deletions} del${deletions === 1 ? '' : 's'}`;
}

function renderSelectionToggle(selected: boolean, label: string) {
  return selected ? <CheckSquare2 size={13} aria-label={label} /> : <Square size={13} aria-label={label} />;
}

export function ReaderAiEditProposalCard({
  proposal,
  onAccept,
  onReject,
  onEdit,
  onToggleHunkSelection,
}: {
  proposal: ReaderAiEditProposal;
  onAccept?: (proposalId: string) => void;
  onReject?: (proposalId: string) => void;
  onEdit?: (proposalId: string) => void;
  onToggleHunkSelection?: (proposalId: string, hunkId: string, selected: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(() => shouldExpandChangeByDefault(proposal));
  const accepted = proposal.status !== 'rejected';
  const selectedHunkIds = new Set(proposal.selectedHunkIds ?? proposal.change.hunks?.map((hunk) => hunk.id) ?? []);

  return (
    <div class={`reader-ai-edit-proposal${accepted ? '' : ' reader-ai-edit-proposal--rejected'}`}>
      <div class="reader-ai-edit-proposal-header-row">
        <button
          type="button"
          class="reader-ai-edit-proposal-header"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span class={`reader-ai-staged-change-type reader-ai-staged-change-type--${proposal.change.type}`}>
            {typeLabel(proposal.change.type)}
          </span>
          <span class="reader-ai-staged-change-path">{proposal.change.path}</span>
        </button>
        <div class="reader-ai-edit-proposal-actions">
          {proposal.change.type !== 'delete' ? (
            <button
              type="button"
              class="reader-ai-edit-proposal-action"
              onClick={() => onEdit?.(proposal.id)}
              title="Open this file in the editor"
            >
              <Pencil size={13} aria-hidden="true" />
              Edit
            </button>
          ) : null}
          <button
            type="button"
            class={`reader-ai-edit-proposal-action${accepted ? ' reader-ai-edit-proposal-action--active' : ''}`}
            onClick={() => onAccept?.(proposal.id)}
          >
            Accept
          </button>
          <button
            type="button"
            class={`reader-ai-edit-proposal-action${accepted ? '' : ' reader-ai-edit-proposal-action--danger'}`}
            onClick={() => onReject?.(proposal.id)}
          >
            Reject
          </button>
        </div>
      </div>
      {expanded ? (
        <>
          {proposal.change.hunks && proposal.change.hunks.length > 0 ? (
            <div class="reader-ai-staged-hunks">
              {proposal.change.hunks.map((hunk) => {
                const hunkSelected = accepted && selectedHunkIds.has(hunk.id);
                return (
                  <div key={hunk.id} class="reader-ai-staged-hunk-row">
                    <button
                      type="button"
                      class={`reader-ai-staged-toggle-btn${hunkSelected ? '' : ' reader-ai-staged-toggle-btn--off'}`}
                      onClick={() => onToggleHunkSelection?.(proposal.id, hunk.id, !hunkSelected)}
                      title={
                        hunkSelected ? 'Exclude this hunk from the proposal' : 'Accept this hunk back into the proposal'
                      }
                      disabled={!accepted}
                    >
                      {renderSelectionToggle(hunkSelected, 'Toggle proposal hunk selection')}
                    </button>
                    <div class="reader-ai-staged-hunk-copy">
                      <div class="reader-ai-staged-hunk-header">{hunk.header}</div>
                      <div class="reader-ai-staged-hunk-summary">{hunkSummary(hunk)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          <UnifiedDiffView diff={proposal.change.diff} />
        </>
      ) : null}
      <div class="reader-ai-edit-proposal-status">{accepted ? 'Accepted for apply' : 'Rejected'}</div>
    </div>
  );
}
