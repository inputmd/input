import test from 'ava';
import {
  buildReaderAiRetryRequestFromRuns,
  completeReaderAiRunStepRetry,
  markReaderAiRunStepRetryAttempt,
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
