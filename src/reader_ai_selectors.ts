import { applyPatch as applyDiffPatch } from 'diff';
import type { ReaderAiEditProposal, ReaderAiStagedChange } from './reader_ai';
import type { ReaderAiSelectedHunkIdsByChangeId } from './reader_ai_state';

function tryApplyReaderAiPatch(original: string, patch: string): string | null {
  try {
    const patched = applyDiffPatch(original, patch);
    return patched === false ? null : patched;
  } catch {
    return null;
  }
}

export function buildReaderAiSelectedChange(
  change: ReaderAiStagedChange,
  selectedHunkIds: Set<string> | undefined,
): ReaderAiStagedChange | null {
  if (!change.hunks || change.hunks.length === 0) return change;
  if (!selectedHunkIds || selectedHunkIds.size === 0) return null;
  const visibleHunks = change.hunks.filter((hunk) => selectedHunkIds.has(hunk.id));
  if (visibleHunks.length === 0) return null;
  if (visibleHunks.length === change.hunks.length) return change;
  const original =
    change.type === 'create'
      ? ''
      : typeof change.originalContent === 'string'
        ? change.originalContent
        : change.originalContent === null
          ? ''
          : null;
  if (original === null) return null;
  const partialDiff = [
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    ...visibleHunks.flatMap((hunk) => [
      hunk.header,
      ...hunk.lines.map((line) => {
        if (line.type === 'add') return `+${line.content}`;
        if (line.type === 'del') return `-${line.content}`;
        return ` ${line.content}`;
      }),
    ]),
  ].join('\n');
  const patched = tryApplyReaderAiPatch(original, partialDiff);
  if (patched === null) return null;
  return {
    ...change,
    diff: partialDiff,
    modifiedContent: change.type === 'delete' ? null : patched,
    hunks: visibleHunks,
  } satisfies ReaderAiStagedChange;
}

export function buildEffectiveReaderAiProposalChange(proposal: ReaderAiEditProposal): ReaderAiStagedChange | null {
  if (proposal.status === 'rejected') return null;
  return buildReaderAiSelectedChange(
    proposal.change,
    Array.isArray(proposal.selectedHunkIds) ? new Set(proposal.selectedHunkIds) : undefined,
  );
}

export function selectEffectiveReaderAiStagedChanges(options: {
  editProposals: ReaderAiEditProposal[];
  stagedChanges: ReaderAiStagedChange[];
  selectedChangeIds: Set<string>;
  selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId;
}): ReaderAiStagedChange[] {
  const { editProposals, stagedChanges, selectedChangeIds, selectedHunkIdsByChangeId } = options;
  if (editProposals.length > 0) {
    const latestAcceptedByPath = new Map<string, ReaderAiStagedChange>();
    for (const proposal of editProposals) {
      const effectiveChange = buildEffectiveReaderAiProposalChange(proposal);
      if (!effectiveChange) continue;
      latestAcceptedByPath.set(effectiveChange.path, effectiveChange);
    }
    return Array.from(latestAcceptedByPath.values());
  }
  return stagedChanges.flatMap((change) => {
    if (change.id && !selectedChangeIds.has(change.id)) return [];
    const effectiveChange = buildReaderAiSelectedChange(
      change,
      change.id ? selectedHunkIdsByChangeId[change.id] : undefined,
    );
    return effectiveChange ? [effectiveChange] : [];
  });
}

export function selectEffectiveReaderAiStagedFileContents(
  effectiveStagedChanges: ReaderAiStagedChange[],
): Record<string, string> {
  return Object.fromEntries(
    effectiveStagedChanges
      .filter((change) => change.type !== 'delete' && typeof change.modifiedContent === 'string')
      .map((change) => [change.path, change.modifiedContent as string]),
  );
}
