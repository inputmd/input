import test from 'ava';
import { buildDiffPreviewBlocksFromHunks } from '../../src/components/codemirror_diff_preview.ts';
import { generateUnifiedDiff, parseUnifiedDiffHunks } from '../reader_ai_tools.ts';

test('buildDiffPreviewBlocksFromHunks returns one preview block per hunk', (t) => {
  const originalLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const modifiedLines = [...originalLines];
  modifiedLines[2] = 'CHANGED 3';
  modifiedLines[17] = 'CHANGED 18';

  const original = originalLines.join('\n');
  const modified = modifiedLines.join('\n');
  const diff = generateUnifiedDiff('multi.txt', original, modified);
  const hunks = parseUnifiedDiffHunks(diff);
  const blocks = buildDiffPreviewBlocksFromHunks(original, modified, hunks);

  t.is(hunks.length, 2);
  t.is(blocks.length, 2);

  t.deepEqual(
    blocks.map((block) => ({
      kind: block.kind,
      deletedText: block.deletedText,
      insert: block.insert,
      label: block.label,
    })),
    [
      {
        kind: 'replace',
        deletedText: 'line 3\n',
        insert: 'CHANGED 3\n',
        label: hunks[0]?.header,
      },
      {
        kind: 'replace',
        deletedText: 'line 18\n',
        insert: 'CHANGED 18\n',
        label: hunks[1]?.header,
      },
    ],
  );

  for (const block of blocks) {
    t.is(original.slice(block.from, block.to), block.deletedText ?? '');
  }
});
