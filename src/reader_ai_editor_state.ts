import { buildEditorChangeMarkers, type EditorChangeMarker } from './components/codemirror_change_markers';
import { buildDiffPreviewBlocksFromHunks, type EditorDiffPreview } from './components/codemirror_diff_preview';
import { commonPrefixLength, commonSuffixLength } from './path_utils';
import type { ReaderAiStagedChange, ReaderAiStagedHunk } from './reader_ai';
import type { ReaderAiEditorCheckpoint } from './reader_ai_editor_checkpoints';
import type {
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
}

export interface ReaderAiEditorOverlay {
  path: string;
  revision: number | null;
  changeSetId: string | null;
  runId: string | null;
  fileStatus: ReaderAiEditorFileStatus;
  hunks: ReaderAiEditorHunkOverlay[];
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
  runs: ReaderAiRunRecord[];
}

function buildReaderAiEditorDiffPreview(change: ReaderAiStagedChange | undefined): EditorDiffPreview | null {
  if (!change || change.type === 'delete') return null;
  if (typeof change.modifiedContent !== 'string') return null;
  if (change.type === 'create') {
    return {
      blocks: [
        {
          kind: 'insert',
          from: 0,
          to: 0,
          insert: change.modifiedContent,
          label: 'Reader AI proposal',
        },
      ],
      source: 'Reader AI proposal',
    };
  }
  const original = typeof change.originalContent === 'string' ? change.originalContent : null;
  if (original === null) return null;
  const modified = change.modifiedContent;
  if (original === modified) return null;
  const hunkBlocks = buildDiffPreviewBlocksFromHunks(original, modified, change.hunks ?? []);
  if (hunkBlocks.length > 0) {
    return {
      blocks: hunkBlocks,
      source: 'Reader AI proposal',
    };
  }
  const start = commonPrefixLength(original, modified);
  const trailingOverlap = commonSuffixLength(original, modified, start);
  const originalTrimmedEnd = original.length - trailingOverlap;
  const modifiedTrimmedEnd = modified.length - trailingOverlap;
  const replacement = modified.slice(start, modifiedTrimmedEnd);
  const deleted = original.slice(start, originalTrimmedEnd);
  const blocks: EditorDiffPreview['blocks'] = [];
  if (deleted.length > 0) {
    blocks.push({
      kind: replacement.length > 0 ? 'replace' : 'delete',
      from: Math.max(0, start),
      to: Math.max(0, originalTrimmedEnd),
      label: replacement.length > 0 ? 'Replace' : 'Delete',
      deletedText: deleted,
    });
  }
  if (replacement.length > 0) {
    blocks.push({
      kind: deleted.length > 0 ? 'replace' : 'insert',
      from: Math.max(0, start),
      to: Math.max(0, originalTrimmedEnd),
      insert: replacement,
      label: deleted.length > 0 ? 'Insert' : 'Reader AI proposal',
    });
  }
  if (blocks.length === 0) return null;
  return {
    blocks,
    source: 'Reader AI proposal',
  };
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
  if (fileRecord?.status === 'applied') return 'applied';
  if (fileRecord?.status === 'failed') return 'failed';
  if (changeSetStatus === 'applying') return 'applying';
  if (changeSetStatus === 'applied') return 'applied';
  if (changeSetStatus === 'partial') return 'partial';
  if (changeSetStatus === 'conflicted') return 'conflicted';
  if (changeSetStatus === 'superseded') return 'superseded';
  if (change) return 'ready';
  return 'idle';
}

function buildReaderAiEditorHunks(options: {
  path: string;
  change: ReaderAiStagedChange | undefined;
  fileStatus: ReaderAiEditorFileStatus;
  selectedChangeIds: Set<string>;
  selectedHunkIdsByChangeId: ReaderAiSelectedHunkIdsByChangeId;
}): ReaderAiEditorHunkOverlay[] {
  const { change, fileStatus, path, selectedChangeIds, selectedHunkIdsByChangeId } = options;
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
    };
  });
}

function buildReaderAiEditorMarkers(options: {
  change: ReaderAiStagedChange | undefined;
  fileStatus: ReaderAiEditorFileStatus;
  hunks: ReaderAiEditorHunkOverlay[];
  currentDocumentSavedContent: string | null;
  currentDocumentContent: string;
  hasUnsavedChanges: boolean;
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
            : options.fileStatus === 'conflicted'
              ? 'conflicted'
              : options.fileStatus === 'stale'
                ? 'stale'
                : 'accepted',
        label: options.change.path,
      },
    ];
  }
  if (options.currentDocumentSavedContent === null || !options.hasUnsavedChanges) return null;
  const markers = buildEditorChangeMarkers(options.currentDocumentSavedContent, options.currentDocumentContent);
  return markers.length > 0 ? markers : null;
}

export function buildReaderAiEditorOverlay(options: BuildReaderAiEditorOverlayOptions): ReaderAiEditorOverlay | null {
  if (!options.active || !options.path) return null;
  const currentChange = options.effectiveStagedChanges.find((change) => change.path === options.path);
  const fileRecord = options.activeChangeSet?.files.find((file) => file.path === options.path);
  const run = options.activeChangeSet?.runId
    ? (options.runs.find((entry) => entry.id === options.activeChangeSet?.runId) ?? null)
    : null;
  const diffPreview = buildReaderAiEditorDiffPreview(currentChange);
  const fileStatus = resolveReaderAiEditorFileStatus(currentChange, fileRecord, options.activeChangeSet?.status);
  const hunks = buildReaderAiEditorHunks({
    path: options.path,
    change: currentChange,
    fileStatus,
    selectedChangeIds: options.selectedChangeIds,
    selectedHunkIdsByChangeId: options.selectedHunkIdsByChangeId,
  });
  const markers = buildReaderAiEditorMarkers({
    change: currentChange,
    fileStatus,
    hunks,
    currentDocumentSavedContent: options.currentDocumentSavedContent,
    currentDocumentContent: options.currentDocumentContent,
    hasUnsavedChanges: options.hasUnsavedChanges,
  });

  return {
    path: options.path,
    revision: options.revision,
    changeSetId: options.activeChangeSet?.id ?? null,
    runId: run?.id ?? null,
    fileStatus,
    hunks,
    markers: markers && markers.length > 0 ? markers : null,
    diffPreview,
    provenance:
      options.activeChangeSet && run
        ? {
            runId: run.id,
            changeSetId: options.activeChangeSet.id,
            modelId: run.modelId,
            sourceLabel: 'Reader AI proposal',
          }
        : null,
    checkpoint:
      options.activeEditorCheckpoint && options.activeEditorCheckpoint.path === options.path
        ? {
            id: options.activeEditorCheckpoint.id,
            status: options.activeEditorCheckpoint.status,
          }
        : null,
  };
}
