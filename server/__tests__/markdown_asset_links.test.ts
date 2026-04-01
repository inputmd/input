import test from 'ava';
import { listMarkdownFilesNearAsset, rewriteMovedAssetLinks } from '../../src/markdown_asset_links.ts';

test('listMarkdownFilesNearAsset keeps only same-directory and ancestor markdown files', (t) => {
  t.deepEqual(
    listMarkdownFilesNearAsset(
      [
        'index.md',
        'docs/index.md',
        'docs/guide.md',
        'docs/nested/page.md',
        'docs/images/captions.md',
        'docs/images/nested/deeper.md',
        'notes/todo.md',
      ],
      'docs/images/diagram.png',
    ),
    ['docs/guide.md', 'docs/images/captions.md', 'docs/index.md', 'index.md'],
  );
});

test('rewriteMovedAssetLinks updates inline markdown links and images', (t) => {
  const source = [
    '![Diagram](./images/diagram.png)',
    '[Download](./images/diagram.png#raw)',
    '[Leave me](https://example.com/images/diagram.png)',
  ].join('\n');

  const result = rewriteMovedAssetLinks(source, 'docs/guide.md', 'docs/images/diagram.png', 'docs/assets/diagram.png');

  t.is(
    result.content,
    [
      '![Diagram](./assets/diagram.png)',
      '[Download](./assets/diagram.png#raw)',
      '[Leave me](https://example.com/images/diagram.png)',
    ].join('\n'),
  );
  t.is(result.replacements, 2);
});

test('rewriteMovedAssetLinks preserves rooted destinations and reference definitions', (t) => {
  const source = ['![Hero][hero]', '', '[hero]: </docs/images/hero.png?download=1> "Hero image"'].join('\n');

  const result = rewriteMovedAssetLinks(source, 'docs/index.md', 'docs/images/hero.png', 'shared/hero.png');

  t.is(result.content, ['![Hero][hero]', '', '[hero]: </shared/hero.png?download=1> "Hero image"'].join('\n'));
  t.is(result.replacements, 1);
});

test('rewriteMovedAssetLinks preserves bare relative style when the original link was not dot-prefixed', (t) => {
  const result = rewriteMovedAssetLinks(
    '![Diagram](images/diagram.png)',
    'docs/guide.md',
    'docs/images/diagram.png',
    'docs/media/diagram.png',
  );

  t.is(result.content, '![Diagram](media/diagram.png)');
  t.is(result.replacements, 1);
});
