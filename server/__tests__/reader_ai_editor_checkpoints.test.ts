import test from 'ava';
import {
  appendReaderAiEditorCheckpoint,
  createReaderAiEditorCheckpoint,
  findActiveReaderAiEditorCheckpoint,
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
