import test from 'ava';
import type { ReaderAiStagedChange } from '../../src/reader_ai.ts';
import {
  buildReaderAiRetryRequestFromRuns,
  completeReaderAiRunStepRetry,
  markReaderAiRunStepRetryAttempt,
  prepareReaderAiSelectedChangesForApply,
  resolveReaderAiStagedHunkState,
} from '../../src/reader_ai_controller_runtime.ts';
import type { ReaderAiRunRecord } from '../../src/reader_ai_ledger.ts';

function createRun(): ReaderAiRunRecord {
  return {
    id: 'run:1',
    modelId: 'model:test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'failed',
    baseMessages: [{ role: 'user', content: 'Retry this' }],
    toolLog: [],
    steps: [
      {
        id: 'step:1',
        kind: 'tool',
        name: 'search_document',
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        retryCount: 0,
        maxRetries: 1,
        retryable: true,
        retryState: 'ready',
        retryReason: 'transient',
        error: 'network timeout',
      },
    ],
  };
}

test('step retry stays in progress until the retry completes', (t) => {
  const run = createRun();

  const inProgress = markReaderAiRunStepRetryAttempt(run, 'step:1');
  t.is(inProgress.steps[0]?.retryCount, 1);
  t.is(inProgress.steps[0]?.retryState, 'in_progress');

  const failed = completeReaderAiRunStepRetry(inProgress, 'step:1', false);
  t.is(failed.steps[0]?.retryState, 'exhausted');
});

test('retry request only targets failed steps that are still ready', (t) => {
  const run = createRun();
  const inProgress = markReaderAiRunStepRetryAttempt(run, 'step:1');

  t.is(buildReaderAiRetryRequestFromRuns([inProgress])?.retryStepId, undefined);

  const exhausted = completeReaderAiRunStepRetry(inProgress, 'step:1', false);
  t.is(buildReaderAiRetryRequestFromRuns([exhausted])?.retryStepId, undefined);
});

test('prepareReaderAiSelectedChangesForApply scopes local editor apply to the current file', (t) => {
  const currentChange: ReaderAiStagedChange = {
    id: 'change:current',
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
  const otherChange: ReaderAiStagedChange = {
    id: 'change:other',
    path: 'other.md',
    type: 'edit',
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    revision: 1,
    originalContent: 'old\n',
    modifiedContent: 'new\n',
  };

  const prepared = prepareReaderAiSelectedChangesForApply({
    activeChangeSet: {
      id: 'changeset:1',
      runId: 'run:1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'ready',
      editProposals: [],
      proposalStatusesByToolCallId: {},
      stagedChanges: [currentChange, otherChange],
      stagedFileContents: {
        'doc.md': 'after\n',
        'other.md': 'new\n',
      },
      documentEditedContent: null,
      files: [
        { path: 'doc.md', status: 'ready', hasCompleteContent: true, baseRevision: 3 },
        { path: 'other.md', status: 'ready', hasCompleteContent: true, baseRevision: 1 },
      ],
      appliedPaths: [],
      failedPaths: [],
    },
    currentEditContentRevision: 3,
    currentEditingDocPath: 'doc.md',
    currentEditingDocumentContent: 'before\n',
    selectedChanges: [currentChange, otherChange],
    selectedFileContents: {
      'doc.md': 'after\n',
      'other.md': 'new\n',
    },
    mode: 'without-saving',
  });

  t.deepEqual(
    prepared.selectedChanges.map((change) => change.path),
    ['doc.md'],
  );
  t.deepEqual(prepared.ignoredPaths, ['other.md']);
  t.deepEqual(Object.keys(prepared.selectedFileContents), ['doc.md']);
});

test('prepareReaderAiSelectedChangesForApply rebases a stale current-document hunk onto live editor content', (t) => {
  const currentChange: ReaderAiStagedChange = {
    id: 'change:current',
    path: 'doc.md',
    type: 'edit',
    diff: ['--- a/doc.md', '+++ b/doc.md', '@@ -1,3 +1,3 @@', ' alpha', '-before', '+after', ' tail'].join('\n'),
    revision: 3,
    originalContent: ['alpha', 'before', 'tail', ''].join('\n'),
    modifiedContent: ['alpha', 'after', 'tail', ''].join('\n'),
    hunks: [
      {
        id: 'hunk:1',
        header: '@@ -2,2 +2,2 @@',
        oldStart: 2,
        oldLines: 2,
        newStart: 2,
        newLines: 2,
        lines: [
          { type: 'context', content: 'alpha' },
          { type: 'del', content: 'before' },
          { type: 'add', content: 'after' },
          { type: 'context', content: 'tail' },
        ],
      },
    ],
  };

  const prepared = prepareReaderAiSelectedChangesForApply({
    activeChangeSet: {
      id: 'changeset:1',
      runId: 'run:1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'conflicted',
      editProposals: [],
      proposalStatusesByToolCallId: {},
      stagedChanges: [currentChange],
      stagedFileContents: { 'doc.md': ['alpha', 'after', 'tail'].join('\n') },
      documentEditedContent: null,
      files: [{ path: 'doc.md', status: 'stale', hasCompleteContent: true, baseRevision: 3 }],
      appliedPaths: [],
      failedPaths: [],
    },
    currentEditContentRevision: 4,
    currentEditingDocPath: 'doc.md',
    currentEditingDocumentContent: ['heading', 'alpha', 'before', 'tail', ''].join('\n'),
    selectedChanges: [currentChange],
    selectedFileContents: { 'doc.md': ['alpha', 'after', 'tail', ''].join('\n') },
    mode: 'without-saving',
  });

  t.deepEqual(prepared.invalid, []);
  t.deepEqual(prepared.repairedPaths, ['doc.md']);
  t.true(prepared.selectedFileContents['doc.md']?.includes('heading') ?? false);
  t.true(prepared.selectedFileContents['doc.md']?.includes('after') ?? false);
});

test('resolveReaderAiStagedHunkState removes a resolved hunk and keeps remaining hunks staged', (t) => {
  const change: ReaderAiStagedChange = {
    id: 'change:1',
    path: 'doc.md',
    type: 'edit',
    diff: [
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,4 +1,4 @@',
      ' alpha',
      '-before',
      '+after',
      ' beta',
      '-old tail',
      '+new tail',
      '',
    ].join('\n'),
    revision: 3,
    originalContent: ['alpha', 'before', 'beta', 'old tail', ''].join('\n'),
    modifiedContent: ['alpha', 'after', 'beta', 'new tail', ''].join('\n'),
    hunks: [
      {
        id: 'hunk:1',
        header: '@@ -1,2 +1,2 @@',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { type: 'context', content: 'alpha' },
          { type: 'del', content: 'before' },
          { type: 'add', content: 'after' },
        ],
      },
      {
        id: 'hunk:2',
        header: '@@ -3,2 +3,2 @@',
        oldStart: 3,
        oldLines: 2,
        newStart: 3,
        newLines: 2,
        lines: [
          { type: 'context', content: 'beta' },
          { type: 'del', content: 'old tail' },
          { type: 'add', content: 'new tail' },
        ],
      },
    ],
  };

  const resolved = resolveReaderAiStagedHunkState({
    stagedChanges: [change],
    selectedChangeIds: new Set(['change:1']),
    selectedHunkIdsByChangeId: { 'change:1': new Set(['hunk:1', 'hunk:2']) },
    stagedFileContents: { 'doc.md': change.modifiedContent ?? '' },
    documentEditedContent: change.modifiedContent ?? null,
    changeId: 'change:1',
    hunkId: 'hunk:1',
    syncDocumentEditedContent: true,
  });

  t.is(resolved.stagedChanges.length, 1);
  t.deepEqual(
    resolved.stagedChanges[0]?.hunks?.map((hunk) => hunk.id),
    ['hunk:2'],
  );
  t.true(resolved.selectedChangeIds.has('change:1'));
  t.deepEqual(Array.from(resolved.selectedHunkIdsByChangeId['change:1'] ?? []), ['hunk:2']);
  t.true(resolved.stagedFileContents['doc.md']?.includes('new tail') ?? false);
  t.false(resolved.stagedFileContents['doc.md']?.includes('after') ?? false);
  t.true(resolved.documentEditedContent?.includes('new tail') ?? false);
});
