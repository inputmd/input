import test from 'ava';
import type { ReaderAiStagedChange } from '../../src/reader_ai.ts';
import type { ReaderAiEditorCheckpoint } from '../../src/reader_ai_editor_checkpoints.ts';
import { buildReaderAiEditorOverlay, hasActionableReaderAiEditorOverlay } from '../../src/reader_ai_editor_state.ts';
import type { ReaderAiChangeSetRecord, ReaderAiRunRecord } from '../../src/reader_ai_ledger.ts';

function createRun(): ReaderAiRunRecord {
  return {
    id: 'run:1',
    modelId: 'model:test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
    baseMessages: [{ role: 'user', content: 'Edit this' }],
    toolLog: [],
    steps: [],
  };
}

function createCheckpoint(): ReaderAiEditorCheckpoint {
  return {
    id: 'checkpoint:1',
    path: 'doc.md',
    content: 'before\n',
    revision: 3,
    selection: null,
    scrollTop: 24,
    createdAt: '2026-01-01T00:00:00.000Z',
    changeSetId: 'changeset:1',
    status: 'active',
  };
}

test('buildReaderAiEditorOverlay suppresses editor diff artifacts after apply when a checkpoint exists', (t) => {
  const changeSets: ReaderAiChangeSetRecord[] = [
    {
      id: 'changeset:1',
      runId: 'run:1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'applied',
      editProposals: [],
      proposalStatusesByToolCallId: {},
      stagedChanges: [],
      stagedFileContents: {},
      documentEditedContent: null,
      files: [
        {
          path: 'doc.md',
          status: 'applied',
          hasCompleteContent: true,
          baseRevision: 3,
        },
      ],
      appliedPaths: ['doc.md'],
      failedPaths: [],
    },
  ];

  const overlay = buildReaderAiEditorOverlay({
    active: true,
    path: 'doc.md',
    revision: 4,
    currentDocumentSavedContent: 'before\n',
    currentDocumentContent: 'after\n',
    hasUnsavedChanges: true,
    effectiveStagedChanges: [],
    selectedChangeIds: new Set(),
    selectedHunkIdsByChangeId: {},
    activeChangeSet: null,
    activeEditorCheckpoint: createCheckpoint(),
    changeSets,
    runs: [createRun()],
  });

  t.truthy(overlay);
  t.is(overlay?.fileStatus, 'applied');
  t.is(overlay?.diffPreview, null);
  t.is(overlay?.markers, null);
  t.is(overlay?.provenance?.modelId, 'model:test');
});

test('buildReaderAiEditorOverlay keeps applied file status when the change set remains partial', (t) => {
  const otherChange: ReaderAiStagedChange = {
    id: 'change:other',
    path: 'other.md',
    type: 'edit',
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    revision: 3,
    originalContent: 'old\n',
    modifiedContent: 'new\n',
  };

  const changeSets: ReaderAiChangeSetRecord[] = [
    {
      id: 'changeset:1',
      runId: 'run:1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'partial',
      editProposals: [],
      proposalStatusesByToolCallId: {},
      stagedChanges: [otherChange],
      stagedFileContents: { 'other.md': 'new\n' },
      documentEditedContent: null,
      files: [
        {
          path: 'other.md',
          status: 'ready',
          hasCompleteContent: true,
          baseRevision: 3,
        },
      ],
      appliedPaths: ['doc.md'],
      failedPaths: [],
    },
  ];

  const overlay = buildReaderAiEditorOverlay({
    active: true,
    path: 'doc.md',
    revision: 4,
    currentDocumentSavedContent: 'before\n',
    currentDocumentContent: 'after\n',
    hasUnsavedChanges: true,
    effectiveStagedChanges: [],
    selectedChangeIds: new Set(),
    selectedHunkIdsByChangeId: {},
    activeChangeSet: changeSets[0] ?? null,
    activeEditorCheckpoint: createCheckpoint(),
    changeSets,
    runs: [createRun()],
  });

  t.truthy(overlay);
  t.is(overlay?.fileStatus, 'applied');
  t.is(overlay?.statusLabel, 'Applied');
  t.is(overlay?.diffPreview, null);
  t.is(overlay?.markers, null);
});

test('buildReaderAiEditorOverlay exposes stale hunks as editor conflicts', (t) => {
  const stagedChange: ReaderAiStagedChange = {
    id: 'change:1',
    path: 'doc.md',
    type: 'edit',
    diff: '@@ -1 +1 @@\n-before\n+after\n',
    revision: 3,
    originalContent: 'before\n',
    modifiedContent: 'after\n',
    hunks: [
      {
        id: 'hunk:1',
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { type: 'del', content: 'before' },
          { type: 'add', content: 'after' },
        ],
      },
    ],
  };
  const changeSets: ReaderAiChangeSetRecord[] = [
    {
      id: 'changeset:1',
      runId: 'run:1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'conflicted',
      editProposals: [],
      proposalStatusesByToolCallId: {},
      stagedChanges: [stagedChange],
      stagedFileContents: { 'doc.md': 'after\n' },
      documentEditedContent: null,
      files: [
        {
          path: 'doc.md',
          status: 'stale',
          hasCompleteContent: true,
          baseRevision: 3,
        },
      ],
      appliedPaths: [],
      failedPaths: [],
    },
  ];

  const overlay = buildReaderAiEditorOverlay({
    active: true,
    path: 'doc.md',
    revision: 4,
    currentDocumentSavedContent: 'before\n',
    currentDocumentContent: 'local drift\n',
    hasUnsavedChanges: true,
    effectiveStagedChanges: [stagedChange],
    selectedChangeIds: new Set(['change:1']),
    selectedHunkIdsByChangeId: { 'change:1': new Set(['hunk:1']) },
    activeChangeSet: changeSets[0] ?? null,
    activeEditorCheckpoint: createCheckpoint(),
    changeSets,
    runs: [createRun()],
  });

  t.truthy(overlay);
  t.is(overlay?.fileStatus, 'stale');
  t.is(overlay?.hunks[0]?.conflictReason, 'overlapping_local_edits');
  t.is(overlay?.conflicts[0]?.hunkId, 'hunk:1');
  t.true(overlay?.conflicts[0]?.message.includes('Restore the checkpoint') ?? false);
  t.is(overlay?.conflicts[0]?.currentText, 'local drift');
  t.is(overlay?.conflicts[0]?.proposedText, 'after');
  t.is(overlay?.conflicts[0]?.baseText, 'before');
});

test('buildReaderAiEditorOverlay maps hunk review status into diff preview actions', (t) => {
  const stagedChange: ReaderAiStagedChange = {
    id: 'change:1',
    path: 'doc.md',
    type: 'edit',
    diff: '@@ -1 +1 @@\n-before\n+after\n',
    revision: 3,
    originalContent: 'before\n',
    modifiedContent: 'after\n',
    hunks: [
      {
        id: 'hunk:1',
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { type: 'del', content: 'before' },
          { type: 'add', content: 'after' },
        ],
      },
    ],
  };

  const overlay = buildReaderAiEditorOverlay({
    active: true,
    path: 'doc.md',
    revision: 3,
    currentDocumentSavedContent: 'before\n',
    currentDocumentContent: 'before\n',
    hasUnsavedChanges: false,
    effectiveStagedChanges: [stagedChange],
    selectedChangeIds: new Set(['change:1']),
    selectedHunkIdsByChangeId: { 'change:1': new Set(['hunk:1']) },
    activeChangeSet: null,
    activeEditorCheckpoint: null,
    changeSets: [],
    runs: [],
  });

  t.truthy(overlay);
  t.is(overlay?.hunks[0]?.status, 'accepted');
  t.deepEqual(overlay?.diffPreview?.blocks[0]?.actions, [
    { id: 'reject', label: 'Reject', tone: 'danger' },
    { id: 'review', label: 'View in sidebar' },
  ]);
  t.is(overlay?.diffPreview?.blocks[0]?.changeId, 'change:1');
  t.is(overlay?.diffPreview?.blocks[0]?.hunkId, 'hunk:1');
  t.is(overlay?.markers?.[0]?.status, 'accepted');
});

test('buildReaderAiEditorOverlay ignores superseded change sets when no active proposal remains', (t) => {
  const supersededChange: ReaderAiStagedChange = {
    id: 'change:1',
    path: 'doc.md',
    type: 'edit',
    diff: '@@ -1 +1 @@\n-before\n+after\n',
    revision: 3,
    originalContent: 'before\n',
    modifiedContent: 'after\n',
  };

  const overlay = buildReaderAiEditorOverlay({
    active: true,
    path: 'doc.md',
    revision: 3,
    currentDocumentSavedContent: 'before\n',
    currentDocumentContent: 'before\n',
    hasUnsavedChanges: false,
    effectiveStagedChanges: [],
    selectedChangeIds: new Set(),
    selectedHunkIdsByChangeId: {},
    activeChangeSet: null,
    activeEditorCheckpoint: null,
    changeSets: [
      {
        id: 'changeset:1',
        runId: 'run:1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'superseded',
        editProposals: [],
        proposalStatusesByToolCallId: {},
        stagedChanges: [supersededChange],
        stagedFileContents: { 'doc.md': 'after\n' },
        documentEditedContent: null,
        files: [
          {
            path: 'doc.md',
            status: 'ready',
            hasCompleteContent: true,
            baseRevision: 3,
          },
        ],
        appliedPaths: [],
        failedPaths: [],
      },
    ],
    runs: [createRun()],
  });

  t.truthy(overlay);
  t.is(overlay?.fileStatus, 'idle');
  t.is(overlay?.statusLabel, 'Editor');
  t.is(overlay?.diffPreview, null);
  t.is(overlay?.markers, null);
});

test('hasActionableReaderAiEditorOverlay only returns true for pending editor-side Reader AI states', (t) => {
  const readyOverlay = buildReaderAiEditorOverlay({
    active: true,
    path: 'doc.md',
    revision: 3,
    currentDocumentSavedContent: 'before\n',
    currentDocumentContent: 'before\n',
    hasUnsavedChanges: false,
    effectiveStagedChanges: [
      {
        id: 'change:1',
        path: 'doc.md',
        type: 'edit',
        diff: '@@ -1 +1 @@\n-before\n+after\n',
        revision: 3,
        originalContent: 'before\n',
        modifiedContent: 'after\n',
      },
    ],
    selectedChangeIds: new Set(['change:1']),
    selectedHunkIdsByChangeId: {},
    activeChangeSet: null,
    activeEditorCheckpoint: null,
    changeSets: [],
    runs: [],
  });

  const appliedOverlay = buildReaderAiEditorOverlay({
    active: true,
    path: 'doc.md',
    revision: 4,
    currentDocumentSavedContent: 'before\n',
    currentDocumentContent: 'after\n',
    hasUnsavedChanges: true,
    effectiveStagedChanges: [],
    selectedChangeIds: new Set(),
    selectedHunkIdsByChangeId: {},
    activeChangeSet: null,
    activeEditorCheckpoint: createCheckpoint(),
    changeSets: [
      {
        id: 'changeset:1',
        runId: 'run:1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'applied',
        editProposals: [],
        proposalStatusesByToolCallId: {},
        stagedChanges: [],
        stagedFileContents: {},
        documentEditedContent: null,
        files: [
          {
            path: 'doc.md',
            status: 'applied',
            hasCompleteContent: true,
            baseRevision: 3,
          },
        ],
        appliedPaths: ['doc.md'],
        failedPaths: [],
      },
    ],
    runs: [createRun()],
  });

  t.true(hasActionableReaderAiEditorOverlay(readyOverlay));
  t.false(hasActionableReaderAiEditorOverlay(appliedOverlay));
  t.false(hasActionableReaderAiEditorOverlay(null));
});
