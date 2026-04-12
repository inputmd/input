import test from 'ava';
import {
  extractLevelTwoMarkdownHeading,
  formatDailyNoteFileName,
  formatDailyNoteHeading,
  inferScratchFileNameFromContent,
  resolveActiveScratchFile,
} from '../../src/scratch_files.ts';

test('daily note headings format and infer filenames for en-US', (t) => {
  const date = new Date(2026, 3, 5);
  const content = `${formatDailyNoteHeading(date, 'en-US')}\n\n`;

  t.is(formatDailyNoteFileName(date), '2026-04-05.md');
  t.is(content, '## April 5, 2026\n\n');
  t.is(extractLevelTwoMarkdownHeading(content), 'April 5, 2026');
  t.is(inferScratchFileNameFromContent(content, 'en-US'), '2026-04-05.md');
});

test('daily note filename inference round-trips localized headings', (t) => {
  const date = new Date(2026, 3, 5);
  const content = `${formatDailyNoteHeading(date, 'de-DE')}\n\n`;

  t.is(inferScratchFileNameFromContent(content, 'de-DE'), '2026-04-05.md');
});

test('resolveActiveScratchFile uses the provided repo draft filename for placeholder paths', (t) => {
  const scratch = resolveActiveScratchFile({
    editingBackend: 'repo',
    route: { name: 'reponew', params: { owner: 'inputmd', repo: 'input', path: 'index.md' } },
    routeState: null,
    currentRepoDocPath: null,
    currentGistId: null,
    currentFileName: null,
    repoDraftFilename: '2026-04-08.md',
  });

  t.deepEqual(scratch, {
    backend: 'repo',
    draftPath: 'index.md',
    filePath: '2026-04-08.md',
    parentPath: '',
    filename: '2026-04-08.md',
  });
});
