import { CheckSquare2, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { useState } from 'preact/hooks';
import type { ReaderAiEditProposal, ReaderAiStagedHunk } from '../reader_ai';
import { UnifiedDiffView } from './DiffViewer';
import { buildUnifiedDiffFromHunk } from './diff_viewer_utils.ts';

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
  onToggleHunkSelection,
}: {
  proposal: ReaderAiEditProposal;
  onAccept?: (proposalId: string) => void;
  onReject?: (proposalId: string) => void;
  onToggleHunkSelection?: (proposalId: string, hunkId: string, selected: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rejected = proposal.status === 'rejected';
  const selectedHunkIds = new Set(proposal.selectedHunkIds ?? proposal.change.hunks?.map((hunk) => hunk.id) ?? []);

  return (
    <div class={`reader-ai-edit-proposal${rejected ? ' reader-ai-edit-proposal--rejected' : ''}`}>
      <div class="reader-ai-edit-proposal-header-row">
        <a
          href="#"
          class="reader-ai-edit-proposal-header"
          onClick={(event) => {
            event.preventDefault();
            setExpanded((current) => !current);
          }}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span class={`reader-ai-staged-change-type reader-ai-staged-change-type--${proposal.change.type}`}>
            {typeLabel(proposal.change.type)}
          </span>
          <span class="reader-ai-staged-change-path">{proposal.change.path}</span>
        </a>
        <div class="reader-ai-edit-proposal-actions">
          {rejected ? (
            <button type="button" class="reader-ai-edit-proposal-action" onClick={() => onAccept?.(proposal.id)}>
              Undo reject
            </button>
          ) : (
            <button type="button" class="reader-ai-edit-proposal-action" onClick={() => onReject?.(proposal.id)}>
              Reject
            </button>
          )}
        </div>
      </div>
      {expanded ? (
        <>
          {proposal.change.hunks && proposal.change.hunks.length > 0 ? (
            <div class="reader-ai-staged-hunks">
              {proposal.change.hunks.map((hunk) => {
                const hunkSelected = !rejected && selectedHunkIds.has(hunk.id);
                return (
                  <div
                    key={hunk.id}
                    class={`reader-ai-staged-hunk${hunkSelected ? '' : ' reader-ai-staged-hunk--off'}`}
                  >
                    <div class="reader-ai-staged-hunk-row">
                      <button
                        type="button"
                        class={`reader-ai-staged-toggle-btn${hunkSelected ? '' : ' reader-ai-staged-toggle-btn--off'}`}
                        onClick={() => onToggleHunkSelection?.(proposal.id, hunk.id, !hunkSelected)}
                        title={
                          hunkSelected
                            ? 'Exclude this hunk from the proposal'
                            : 'Accept this hunk back into the proposal'
                        }
                        disabled={rejected}
                      >
                        {renderSelectionToggle(hunkSelected, 'Toggle proposal hunk selection')}
                      </button>
                      <div class="reader-ai-staged-hunk-copy">
                        <div class="reader-ai-staged-hunk-header">{hunk.header}</div>
                        <div class="reader-ai-staged-hunk-summary">{hunkSummary(hunk)}</div>
                      </div>
                    </div>
                    <UnifiedDiffView diff={buildUnifiedDiffFromHunk(hunk)} />
                  </div>
                );
              })}
            </div>
          ) : null}
          {!proposal.change.hunks || proposal.change.hunks.length === 0 ? (
            <UnifiedDiffView diff={proposal.change.diff} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
