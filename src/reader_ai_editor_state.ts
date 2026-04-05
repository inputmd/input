import { buildEditorChangeMarkers, type EditorChangeMarker } from './components/codemirror_change_markers.ts';
import {
  buildDiffPreviewBlocksFromContent,
  buildDiffPreviewBlocksFromHunks,
  type EditorDiffPreview,
  type EditorDiffPreviewAction,
  type EditorDiffPreviewBlock,
} from './components/codemirror_diff_preview.ts';
import type { ReaderAiStagedChange, ReaderAiStagedHunk } from './reader_ai';
import type { ReaderAiEditorCheckpoint } from './reader_ai_editor_checkpoints';
import type {
  ReaderAiChangeSetFailure,
  ReaderAiChangeSetFileRecord,
  ReaderAiChangeSetRecord,
  ReaderAiChangeSetStatus,
  ReaderAiRunRecord,
} from './reader_ai_ledger';
import type { ReaderAiSelectedHunkIdsByChangeId } from './reader_ai_state';

export type ReaderAiEditorFileStatus =
  | 'idle'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'partial'
  | 'conflicted'
  | 'stale'
  | 'superseded'
  | 'failed';

export type ReaderAiEditorHunkStatus = 'pending' | 'accepted' | 'rejected' | 'applied' | 'conflicted' | 'stale';

export type ReaderAiEditorConflictReason =
  | 'stale_context'
  | 'overlapping_local_edits'
  | 'missing_base'
  | 'remote_conflict'
  | 'apply_failed';

export interface ReaderAiEditorCheckpointSummary {
  id: string;
  status: 'active' | 'restored' | 'discarded';
}

export interface ReaderAiEditorProvenance {
  runId: string;
  changeSetId: string;
  modelId: string | null;
  sourceLabel: string;
}

export interface ReaderAiEditorConflict {
  changeId: string | null;
  hunkId: string | null;
  path: string;
  title: string;
  reason: ReaderAiEditorConflictReason;
  message: string;
  selected: boolean;
  currentText: string | null;
  proposedText: string | null;
  baseText: string | null;
}

export interface ReaderAiEditorHunkOverlay {
  changeId: string;
  hunkId: string;
  path: string;
  header: string;
  lineStart: number;
  lineEnd: number;
  from: number | null;
  to: number | null;
  status: ReaderAiEditorHunkStatus;
  selected: boolean;
  conflictReason: ReaderAiEditorConflictReason | null;
}

export interface ReaderAiEditorOverlay {
  path: string;
  revision: number | null;
  changeSetId: string | null;
  runId: string | null;
  primaryChangeId: string | null;
  fileStatus: ReaderAiEditorFileStatus;
  statusLabel: string;
  statusMessage: string | null;
  hunks: ReaderAiEditorHunkOverlay[];
  conflicts: ReaderAiEditorConflict[];
  markers: EditorChangeMarker[] | null;
  diffPreview: EditorDiffPreview | null;
  provenance: ReaderAiEditorProvenance | null;
  checkpoint: ReaderAiEditorCheckpointSummary | null;
}

interface BuildReaderAiEditorOverlayOptions {
  active: boolean;
  path: string | null;
  revision: number;
  currentDocumentSavedContent: string | null;
  currentDocumentContent: string;
  hasUnsavedChanges: boolean;
  effectiveStagedChanges: ReaderAiStagedChange[];
  selectedChangeIds: Set<string>;
  selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId;
  activeChangeSet: ReaderAiChangeSetRecord | null;
  activeEditorCheckpoint: ReaderAiEditorCheckpoint | null;
  changeSets: ReaderAiChangeSetRecord[];
  runs: ReaderAiRunRecord[];
}

function buildReaderAiDiffPreviewActions(hunk: ReaderAiEditorHunkOverlay): EditorDiffPreviewAction[] {
  if (hunk.status === 'conflicted' || hunk.status === 'stale') {
    return [
      { id: 'keep_mine', label: 'Keep mine' },
      { id: 'use_ai', label: 'Use AI', tone: 'primary' },
      { id: 'review', label: 'View in sidebar' },
    ];
  }
  if (hunk.status === 'accepted') {
    return [
      { id: 'reject', label: 'Reject', tone: 'danger' },
      { id: 'review', label: 'View in sidebar' },
    ];
  }
  if (hunk.status === 'rejected') {
    return [
      { id: 'accept', label: 'Accept', tone: 'primary' },
      { id: 'review', label: 'View in sidebar' },
    ];
  }
  return [];
}

function attachReaderAiReviewMetadataToBlocks(options: {
  blocks: EditorDiffPreviewBlock[];
  change: ReaderAiStagedChange;
  fileStatus: ReaderAiEditorFileStatus;
  hunks: ReaderAiEditorHunkOverlay[];
  statusMessage: string | null;
}): EditorDiffPreviewBlock[] {
  if (options.hunks.length > 0) {
    return options.blocks.map((block, index) => {
      const hunk = options.hunks[index];
      if (!hunk) return block;
      return {
        ...block,
        changeId: hunk.changeId,
        hunkId: hunk.hunkId,
        status: hunk.status,
        detail: options.statusMessage ?? undefined,
        actions: buildReaderAiDiffPreviewActions(hunk),
      };
    });
  }
  if (!options.change.id) return options.blocks;
  return options.blocks.map((block) => ({
    ...block,
    changeId: options.change.id,
    status:
      options.fileStatus === 'ready' ? 'accepted' : options.fileStatus === 'conflicted' ? 'conflicted' : undefined,
    detail: options.statusMessage ?? undefined,
    actions:
      options.fileStatus === 'ready'
        ? [
            { id: 'reject', label: 'Reject', tone: 'danger' },
            { id: 'review', label: 'View in sidebar' },
          ]
        : [],
  }));
}

function buildReaderAiContentDiffPreview(options: {
  originalContent: string;
  modifiedContent: string;
  sourceLabel: string;
  badgeLabel: string;
  hunkLabel?: string;
  hunks?: ReaderAiStagedHunk[];
}): EditorDiffPreview | null {
  const { originalContent: original, modifiedContent: modified } = options;
  if (original === modified) return null;
  const hunkBlocks =
    Array.isArray(options.hunks) && options.hunks.length > 0
      ? buildDiffPreviewBlocksFromHunks(original, modified, options.hunks)
      : [];
  const blocks =
    hunkBlocks.length > 0
      ? hunkBlocks
      : buildDiffPreviewBlocksFromContent(original, modified, {
          label: options.hunkLabel ?? options.sourceLabel,
        });
  if (blocks.length === 0) return null;
  return {
    blocks,
    source: options.sourceLabel,
    badge: options.badgeLabel,
  };
}

function buildReaderAiEditorDiffPreview(
  change: ReaderAiStagedChange | undefined,
  provenance: ReaderAiEditorProvenance | null,
  fileStatus: ReaderAiEditorFileStatus,
  hunks: ReaderAiEditorHunkOverlay[],
  statusMessage: string | null,
): EditorDiffPreview | null {
  if (!change || change.type === 'delete') return null;
  if (typeof change.modifiedContent !== 'string') return null;
  const sourceLabel = provenance?.sourceLabel ?? 'Reader AI';
  const badgeLabel = fileStatus === 'applied' ? 'Applied' : fileStatus === 'conflicted' ? 'Conflict' : 'Proposal';
  if (change.type === 'create') {
    return {
      blocks: [
        {
          from: 0,
          to: 0,
          insertedText: change.modifiedContent,
          label: 'Reader AI proposal',
          changeId: change.id,
          status: fileStatus === 'ready' ? 'accepted' : fileStatus === 'conflicted' ? 'conflicted' : undefined,
          detail: statusMessage ?? undefined,
        },
      ],
      source: sourceLabel,
      badge: badgeLabel,
    };
  }
  const original = typeof change.originalContent === 'string' ? change.originalContent : null;
  if (original === null) return null;
  const preview = buildReaderAiContentDiffPreview({
    originalContent: original,
    modifiedContent: change.modifiedContent,
    sourceLabel,
    badgeLabel,
    hunks: change.hunks,
    hunkLabel: 'Reader AI proposal',
  });
  if (!preview) return null;
  return {
    ...preview,
    blocks: attachReaderAiReviewMetadataToBlocks({
      blocks: preview.blocks,
      change,
      fileStatus,
      hunks,
      statusMessage,
    }),
  };
}

function buildAppliedReaderAiDiffPreview(options: {
  checkpoint: ReaderAiEditorCheckpoint | null;
  currentDocumentContent: string;
  provenance: ReaderAiEditorProvenance | null;
}): EditorDiffPreview | null {
  if (!options.checkpoint) return null;
  return buildReaderAiContentDiffPreview({
    originalContent: options.checkpoint.content,
    modifiedContent: options.currentDocumentContent,
    sourceLabel: options.provenance?.sourceLabel ?? 'Reader AI',
    badgeLabel: 'Applied',
    hunkLabel: 'Applied Reader AI change',
  });
}

function buildReaderAiHunkLineRange(hunk: ReaderAiStagedHunk): { lineStart: number; lineEnd: number } {
  const firstChangeIndex = hunk.lines.findIndex((line) => line.type !== 'context');
  if (firstChangeIndex < 0) {
    const lineStart = Math.max(1, hunk.newStart);
    return { lineStart, lineEnd: lineStart };
  }
  let lastChangeIndex = firstChangeIndex;
  for (let index = hunk.lines.length - 1; index >= firstChangeIndex; index -= 1) {
    if (hunk.lines[index]?.type !== 'context') {
      lastChangeIndex = index;
      break;
    }
  }
  const modifiedLinesBeforeChange = hunk.lines.slice(0, firstChangeIndex).filter((line) => line.type !== 'del').length;
  const insertedModifiedLineCount = hunk.lines
    .slice(firstChangeIndex, lastChangeIndex + 1)
    .filter((line) => line.type !== 'del').length;
  const lineStart = Math.max(1, hunk.newStart + modifiedLinesBeforeChange);
  const lineEnd = Math.max(lineStart, lineStart + Math.max(0, insertedModifiedLineCount - 1));
  return { lineStart, lineEnd };
}

function resolveReaderAiEditorFileStatus(
  change: ReaderAiStagedChange | undefined,
  fileRecord: ReaderAiChangeSetFileRecord | undefined,
  changeSetStatus: ReaderAiChangeSetStatus | undefined,
): ReaderAiEditorFileStatus {
  if (fileRecord?.status === 'stale') return 'stale';
  if (fileRecord?.status === 'conflicted') return 'conflicted';
  if (fileRecord?.status === 'failed' || fileRecord?.status === 'missing_content') return 'failed';
  if (fileRecord?.status === 'applied') return 'applied';
  if (changeSetStatus === 'applying') return 'applying';
  if (changeSetStatus === 'applied') return 'applied';
  if (changeSetStatus === 'partial') return 'partial';
  if (changeSetStatus === 'conflicted') return 'conflicted';
  if (changeSetStatus === 'superseded') return 'superseded';
  if (changeSetStatus === 'failed') return 'failed';
  if (change) return 'ready';
  return 'idle';
}

function resolveReaderAiConflictReason(
  fileStatus: ReaderAiEditorFileStatus,
  fileRecord: ReaderAiChangeSetFileRecord | undefined,
  hasCheckpoint: boolean,
): ReaderAiEditorConflictReason | null {
  if (fileRecord?.status === 'missing_content') return 'missing_base';
  if (fileStatus === 'stale') return hasCheckpoint ? 'overlapping_local_edits' : 'stale_context';
  if (fileStatus === 'conflicted') return 'remote_conflict';
  if (fileStatus === 'failed') return 'apply_failed';
  return null;
}

function createReaderAiConflictMessage(
  reason: ReaderAiEditorConflictReason,
  failedEntry: ReaderAiChangeSetFailure | undefined,
): string {
  if (reason === 'overlapping_local_edits') {
    return 'Local editor content drifted after Reader AI generated this edit. Restore the checkpoint or keep your local changes.';
  }
  if (reason === 'stale_context') {
    return 'The current file no longer matches the content Reader AI edited. Review the latest text before applying.';
  }
  if (reason === 'missing_base') {
    return 'Reader AI is missing the full file content needed to safely apply this edit.';
  }
  if (reason === 'remote_conflict') {
    return 'The repository content changed while applying this Reader AI edit. Review the conflicting hunks before retrying.';
  }
  return (
    failedEntry?.error || 'Applying this Reader AI edit failed. Review or exclude the affected hunks before retrying.'
  );
}

function buildReaderAiEditorHunks(options: {
  path: string;
  change: ReaderAiStagedChange | undefined;
  fileStatus: ReaderAiEditorFileStatus;
  conflictReason: ReaderAiEditorConflictReason | null;
  selectedChangeIds: Set<string>;
  selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId;
}): ReaderAiEditorHunkOverlay[] {
  const { change, conflictReason, fileStatus, path, selectedChangeIds, selectedHunkIdsByChangeId } = options;
  if (!change?.id || !Array.isArray(change.hunks) || change.hunks.length === 0) return [];
  const selectedChange = selectedChangeIds.has(change.id);
  const selectedHunkIds = selectedHunkIdsByChangeId[change.id] ?? new Set<string>();
  const hunkBlocks =
    typeof change.originalContent === 'string' && typeof change.modifiedContent === 'string'
      ? buildDiffPreviewBlocksFromHunks(change.originalContent, change.modifiedContent, change.hunks)
      : [];
  return change.hunks.map((hunk, index) => {
    const block = hunkBlocks[index];
    const { lineStart, lineEnd } = buildReaderAiHunkLineRange(hunk);
    let status: ReaderAiEditorHunkStatus = selectedChange && selectedHunkIds.has(hunk.id) ? 'accepted' : 'rejected';
    if (fileStatus === 'applied') status = 'applied';
    else if (fileStatus === 'conflicted') status = 'conflicted';
    else if (fileStatus === 'stale') status = 'stale';
    else if (fileStatus === 'ready' && !selectedChange) status = 'rejected';
    else if (fileStatus === 'ready' && selectedChange && !selectedHunkIds.has(hunk.id)) status = 'rejected';
    else if (fileStatus === 'ready') status = 'accepted';
    return {
      changeId: change.id!,
      hunkId: hunk.id,
      path,
      header: hunk.header,
      lineStart,
      lineEnd,
      from: block ? block.from : null,
      to: block ? block.to : null,
      status,
      selected: selectedChange && selectedHunkIds.has(hunk.id),
      conflictReason: status === 'conflicted' || status === 'stale' ? conflictReason : null,
    };
  });
}

function extractReaderAiDocumentLineRange(content: string, lineStart: number, lineEnd: number): string | null {
  const lines = content.split('\n');
  const startIndex = Math.max(0, lineStart - 1);
  const endIndex = Math.max(startIndex, lineEnd);
  const segment = lines.slice(startIndex, endIndex).join('\n').trimEnd();
  return segment.length > 0 ? segment : null;
}

function buildReaderAiHunkBaseText(hunk: ReaderAiStagedHunk): string | null {
  const text = hunk.lines
    .filter((line) => line.type !== 'add')
    .map((line) => line.content)
    .join('\n')
    .trimEnd();
  return text.length > 0 ? text : null;
}

function buildReaderAiHunkProposedText(hunk: ReaderAiStagedHunk): string | null {
  const text = hunk.lines
    .filter((line) => line.type !== 'del')
    .map((line) => line.content)
    .join('\n')
    .trimEnd();
  return text.length > 0 ? text : null;
}

function buildReaderAiEditorConflicts(options: {
  path: string;
  change: ReaderAiStagedChange | undefined;
  hunks: ReaderAiEditorHunkOverlay[];
  fileStatus: ReaderAiEditorFileStatus;
  conflictReason: ReaderAiEditorConflictReason | null;
  failedEntry: ReaderAiChangeSetFailure | undefined;
  currentDocumentContent: string;
}): ReaderAiEditorConflict[] {
  if (!options.conflictReason) return [];
  const message = createReaderAiConflictMessage(options.conflictReason, options.failedEntry);
  if (options.hunks.length > 0) {
    return options.hunks.map((hunk) => {
      const sourceHunk = options.change?.hunks?.find((entry) => entry.id === hunk.hunkId) ?? null;
      return {
        changeId: hunk.changeId,
        hunkId: hunk.hunkId,
        path: options.path,
        title: hunk.header,
        reason: options.conflictReason!,
        message,
        selected: hunk.selected,
        currentText: extractReaderAiDocumentLineRange(options.currentDocumentContent, hunk.lineStart, hunk.lineEnd),
        proposedText: sourceHunk ? buildReaderAiHunkProposedText(sourceHunk) : null,
        baseText: sourceHunk ? buildReaderAiHunkBaseText(sourceHunk) : null,
      };
    });
  }
  return [
    {
      changeId: options.change?.id ?? null,
      hunkId: null,
      path: options.path,
      title: options.path,
      reason: options.conflictReason,
      message,
      selected: !!options.change?.id,
      currentText: options.currentDocumentContent.trimEnd() || null,
      proposedText: typeof options.change?.modifiedContent === 'string' ? options.change.modifiedContent : null,
      baseText: typeof options.change?.originalContent === 'string' ? options.change.originalContent : null,
    },
  ];
}

function buildReaderAiEditorMarkers(options: {
  change: ReaderAiStagedChange | undefined;
  fileStatus: ReaderAiEditorFileStatus;
  hunks: ReaderAiEditorHunkOverlay[];
  currentDocumentSavedContent: string | null;
  currentDocumentContent: string;
  hasUnsavedChanges: boolean;
  checkpoint: ReaderAiEditorCheckpoint | null;
  provenance: ReaderAiEditorProvenance | null;
  statusMessage: string | null;
}): EditorChangeMarker[] | null {
  if (options.change?.id && options.hunks.length > 0) {
    return options.hunks.map((hunk) => ({
      lineNumber: hunk.lineStart,
      lineEndNumber: hunk.lineEnd,
      kind: 'modify',
      source: 'reader_ai',
      changeId: hunk.changeId,
      hunkId: hunk.hunkId,
      status: hunk.status,
      label: hunk.header,
      sourceLabel: options.provenance?.sourceLabel ?? 'Reader AI',
      detail: options.statusMessage ?? undefined,
    }));
  }
  if (options.change?.id) {
    return [
      {
        lineNumber: 1,
        kind: options.change.type === 'create' ? 'add' : 'modify',
        source: 'reader_ai',
        changeId: options.change.id,
        status:
          options.fileStatus === 'applied'
            ? 'applied'
            : options.fileStatus === 'failed'
              ? 'failed'
              : options.fileStatus === 'conflicted'
                ? 'conflicted'
                : options.fileStatus === 'stale'
                  ? 'stale'
                  : 'accepted',
        label: options.change.path,
        sourceLabel: options.provenance?.sourceLabel ?? 'Reader AI',
        detail: options.statusMessage ?? undefined,
      },
    ];
  }
  if (options.checkpoint && options.currentDocumentContent !== options.checkpoint.content) {
    const markers = buildEditorChangeMarkers(options.checkpoint.content, options.currentDocumentContent);
    return markers.map((marker) => ({
      ...marker,
      source: 'reader_ai',
      status: 'applied',
      label: 'Applied Reader AI change',
      sourceLabel: options.provenance?.sourceLabel ?? 'Reader AI',
      detail: options.statusMessage ?? 'Applied Reader AI change',
    }));
  }
  if (options.currentDocumentSavedContent === null || !options.hasUnsavedChanges) return null;
  const markers = buildEditorChangeMarkers(options.currentDocumentSavedContent, options.currentDocumentContent);
  return markers.length > 0 ? markers : null;
}

function findRelevantReaderAiChangeSet(options: {
  path: string;
  activeChangeSet: ReaderAiChangeSetRecord | null;
  activeEditorCheckpoint: ReaderAiEditorCheckpoint | null;
  changeSets: ReaderAiChangeSetRecord[];
}): ReaderAiChangeSetRecord | null {
  const activeIncludesPath =
    options.activeChangeSet?.stagedChanges.some((change) => change.path === options.path) ||
    options.activeChangeSet?.files.some((file) => file.path === options.path) ||
    options.activeChangeSet?.appliedPaths.includes(options.path) ||
    options.activeChangeSet?.failedPaths.some((entry) => entry.path === options.path);
  if (activeIncludesPath) return options.activeChangeSet ?? null;
  if (options.activeEditorCheckpoint?.changeSetId) {
    const checkpointChangeSet =
      options.changeSets.find((changeSet) => changeSet.id === options.activeEditorCheckpoint?.changeSetId) ?? null;
    if (checkpointChangeSet) return checkpointChangeSet;
  }
  for (let index = options.changeSets.length - 1; index >= 0; index -= 1) {
    const changeSet = options.changeSets[index];
    if (changeSet?.status === 'superseded') continue;
    if (
      changeSet.stagedChanges.some((change) => change.path === options.path) ||
      changeSet.files.some((file) => file.path === options.path) ||
      changeSet.appliedPaths.includes(options.path) ||
      changeSet.failedPaths.some((entry) => entry.path === options.path)
    ) {
      return changeSet;
    }
  }
  return null;
}

function createReaderAiStatusLabel(status: ReaderAiEditorFileStatus): string {
  if (status === 'ready') return 'Proposal ready';
  if (status === 'applying') return 'Applying';
  if (status === 'applied') return 'Applied';
  if (status === 'partial') return 'Partial apply';
  if (status === 'conflicted') return 'Conflict';
  if (status === 'stale') return 'Stale';
  if (status === 'superseded') return 'Superseded';
  if (status === 'failed') return 'Failed';
  return 'Editor';
}

function createReaderAiStatusMessage(options: {
  fileStatus: ReaderAiEditorFileStatus;
  provenance: ReaderAiEditorProvenance | null;
  hunks: ReaderAiEditorHunkOverlay[];
  conflicts: ReaderAiEditorConflict[];
  checkpoint: ReaderAiEditorCheckpoint | null;
  failedEntry: ReaderAiChangeSetFailure | undefined;
}): string | null {
  const modelLabel = options.provenance?.modelId ?? 'Reader AI';
  if (options.fileStatus === 'ready') {
    const selectedCount = options.hunks.filter((hunk) => hunk.selected).length;
    if (options.hunks.length > 0) {
      return `${selectedCount} of ${options.hunks.length} review blocks selected from ${modelLabel}.`;
    }
    return `Reader AI has a pending proposal for this file from ${modelLabel}.`;
  }
  if (options.fileStatus === 'applied') {
    return options.checkpoint
      ? `Applied from ${modelLabel}. A restore checkpoint is available for this editor session.`
      : `Applied from ${modelLabel}.`;
  }
  if (options.fileStatus === 'applying') return `Applying Reader AI changes from ${modelLabel}.`;
  if (options.fileStatus === 'partial') {
    return 'Some Reader AI edits applied, but at least one file still needs review.';
  }
  if (options.fileStatus === 'conflicted' || options.fileStatus === 'stale' || options.fileStatus === 'failed') {
    return (
      options.conflicts[0]?.message ??
      options.failedEntry?.error ??
      'Reader AI needs review before this file can be applied.'
    );
  }
  if (options.fileStatus === 'superseded') return 'This Reader AI change set was superseded by a newer run.';
  return null;
}

export function buildReaderAiEditorOverlay(options: BuildReaderAiEditorOverlayOptions): ReaderAiEditorOverlay | null {
  if (!options.active || !options.path) return null;
  const currentChange = options.effectiveStagedChanges.find((change) => change.path === options.path);
  const relevantChangeSet = findRelevantReaderAiChangeSet({
    path: options.path,
    activeChangeSet: options.activeChangeSet,
    activeEditorCheckpoint: options.activeEditorCheckpoint,
    changeSets: options.changeSets,
  });
  const fileRecord = relevantChangeSet?.files.find((file) => file.path === options.path);
  const failedEntry = relevantChangeSet?.failedPaths.find((entry) => entry.path === options.path);
  const run = relevantChangeSet?.runId
    ? (options.runs.find((entry) => entry.id === relevantChangeSet.runId) ?? null)
    : null;
  const provenance =
    relevantChangeSet && run
      ? {
          runId: run.id,
          changeSetId: relevantChangeSet.id,
          modelId: run.modelId,
          sourceLabel: 'Reader AI',
        }
      : null;
  const fileStatus = resolveReaderAiEditorFileStatus(currentChange, fileRecord, relevantChangeSet?.status);
  const conflictReason = resolveReaderAiConflictReason(
    fileStatus,
    fileRecord,
    options.activeEditorCheckpoint?.path === options.path,
  );
  const hunks = buildReaderAiEditorHunks({
    path: options.path,
    change: currentChange,
    fileStatus,
    conflictReason,
    selectedChangeIds: options.selectedChangeIds,
    selectedHunkIdsByChangeId: options.selectedHunkIdsByChangeId,
  });
  const conflicts = buildReaderAiEditorConflicts({
    path: options.path,
    change: currentChange,
    hunks,
    fileStatus,
    conflictReason,
    failedEntry,
    currentDocumentContent: options.currentDocumentContent,
  });
  const statusMessage = createReaderAiStatusMessage({
    fileStatus,
    provenance,
    hunks,
    conflicts,
    checkpoint: options.activeEditorCheckpoint?.path === options.path ? options.activeEditorCheckpoint : null,
    failedEntry,
  });
  const diffPreview =
    buildReaderAiEditorDiffPreview(currentChange, provenance, fileStatus, hunks, statusMessage) ??
    (fileStatus === 'applied' || fileStatus === 'partial'
      ? buildAppliedReaderAiDiffPreview({
          checkpoint: options.activeEditorCheckpoint?.path === options.path ? options.activeEditorCheckpoint : null,
          currentDocumentContent: options.currentDocumentContent,
          provenance,
        })
      : null);
  const markers = buildReaderAiEditorMarkers({
    change: currentChange,
    fileStatus,
    hunks,
    currentDocumentSavedContent: options.currentDocumentSavedContent,
    currentDocumentContent: options.currentDocumentContent,
    hasUnsavedChanges: options.hasUnsavedChanges,
    checkpoint: options.activeEditorCheckpoint?.path === options.path ? options.activeEditorCheckpoint : null,
    provenance,
    statusMessage,
  });

  return {
    path: options.path,
    revision: options.revision,
    changeSetId: relevantChangeSet?.id ?? null,
    runId: run?.id ?? null,
    primaryChangeId: currentChange?.id ?? conflicts[0]?.changeId ?? null,
    fileStatus,
    statusLabel: createReaderAiStatusLabel(fileStatus),
    statusMessage,
    hunks,
    conflicts,
    markers: markers && markers.length > 0 ? markers : null,
    diffPreview,
    provenance,
    checkpoint:
      options.activeEditorCheckpoint && options.activeEditorCheckpoint.path === options.path
        ? {
            id: options.activeEditorCheckpoint.id,
            status: options.activeEditorCheckpoint.status,
          }
        : null,
  };
}
