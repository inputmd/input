import test from 'ava';
import { isEditableTextFilePath, isSidebarTextFileName } from '../../src/path_utils.ts';

test('sidebar text helpers treat .mjs and .cjs files as text', (t) => {
  t.true(isSidebarTextFileName('scripts/build.mjs'));
  t.true(isSidebarTextFileName('scripts/build.cjs'));
  t.true(isEditableTextFilePath('scripts/build.mjs'));
  t.true(isEditableTextFilePath('scripts/build.cjs'));
});
