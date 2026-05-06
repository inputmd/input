import test from 'ava';
import { shouldTriggerEditSaveShortcut } from '../../src/editor_save_guards.ts';

const saveableShortcut = {
  key: 's',
  metaKey: true,
  ctrlKey: false,
  repeat: false,
  loading: false,
  locked: false,
  readOnly: false,
  canSave: true,
  saving: false,
};

test('shouldTriggerEditSaveShortcut ignores repeated save keydown events', (t) => {
  t.false(
    shouldTriggerEditSaveShortcut({
      ...saveableShortcut,
      repeat: true,
    }),
  );
});

test('shouldTriggerEditSaveShortcut accepts a single save shortcut when the editor can save', (t) => {
  t.true(
    shouldTriggerEditSaveShortcut({
      ...saveableShortcut,
      key: 'S',
    }),
  );
});

test('shouldTriggerEditSaveShortcut requires a save modifier', (t) => {
  t.false(
    shouldTriggerEditSaveShortcut({
      ...saveableShortcut,
      metaKey: false,
      ctrlKey: false,
    }),
  );
});

test('shouldTriggerEditSaveShortcut respects editor save availability', (t) => {
  t.false(
    shouldTriggerEditSaveShortcut({
      ...saveableShortcut,
      saving: true,
    }),
  );
  t.false(
    shouldTriggerEditSaveShortcut({
      ...saveableShortcut,
      readOnly: true,
    }),
  );
  t.false(
    shouldTriggerEditSaveShortcut({
      ...saveableShortcut,
      canSave: false,
    }),
  );
});
