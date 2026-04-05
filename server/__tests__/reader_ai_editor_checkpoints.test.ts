import test from 'ava';
import {
  activateReaderAiEditorCheckpoint,
  appendReaderAiEditorCheckpoint,
  createReaderAiEditorCheckpoint,
  findActiveReaderAiEditorCheckpoint,
  findLatestReaderAiEditorCheckpointForPath,
  updateReaderAiEditorCheckpointStatus,
} from '../../src/reader_ai_editor_checkpoints.ts';

test('appendReaderAiEditorCheckpoint discards the previous active checkpoint', (t) => {
  const first = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before',
    revision: 4,
  });
  const second = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before again',
    revision: 8,
  });

  const checkpoints = appendReaderAiEditorCheckpoint([first], second);

  t.is(checkpoints.length, 2);
  t.is(checkpoints[0]?.status, 'discarded');
  t.is(checkpoints[1]?.status, 'active');
});

test('findActiveReaderAiEditorCheckpoint returns the active checkpoint by id', (t) => {
  const checkpoint = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before',
    revision: 4,
  });

  t.is(findActiveReaderAiEditorCheckpoint([checkpoint], checkpoint.id)?.id, checkpoint.id);
  t.is(findActiveReaderAiEditorCheckpoint([checkpoint], 'missing'), null);
  t.is(checkpoint.appliedContent, null);
});

test('updateReaderAiEditorCheckpointStatus updates only the matching checkpoint', (t) => {
  const first = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before',
    revision: 4,
  });
  const second = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before again',
    revision: 8,
  });

  const checkpoints = updateReaderAiEditorCheckpointStatus([first, second], second.id, 'restored');

  t.is(checkpoints[0]?.status, 'active');
  t.is(checkpoints[1]?.status, 'restored');
});

test('findLatestReaderAiEditorCheckpointForPath returns the latest non-discarded checkpoint for a path', (t) => {
  const first = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before',
    revision: 1,
  });
  const second = createReaderAiEditorCheckpoint({
    path: 'other.md',
    content: 'other',
    revision: 2,
  });
  const third = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'after',
    revision: 3,
  });

  const checkpoints = [{ ...first, status: 'discarded' as const }, second, { ...third, status: 'restored' as const }];

  t.is(findLatestReaderAiEditorCheckpointForPath(checkpoints, 'doc.md')?.id, third.id);
  t.is(findLatestReaderAiEditorCheckpointForPath(checkpoints, 'other.md')?.id, second.id);
  t.is(findLatestReaderAiEditorCheckpointForPath(checkpoints, 'missing.md'), null);
});

test('activateReaderAiEditorCheckpoint reactivates the target checkpoint and discards any active predecessor', (t) => {
  const first = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before',
    revision: 1,
    appliedContent: 'after',
  });
  const second = createReaderAiEditorCheckpoint({
    path: 'doc.md',
    content: 'before again',
    revision: 2,
  });

  const checkpoints = activateReaderAiEditorCheckpoint(
    [
      { ...first, status: 'restored' as const },
      { ...second, status: 'active' as const },
    ],
    first.id,
  );

  t.is(checkpoints[0]?.status, 'active');
  t.is(checkpoints[1]?.status, 'discarded');
  t.is(checkpoints[0]?.appliedContent, 'after');
});
