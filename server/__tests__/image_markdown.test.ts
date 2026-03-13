import test from 'ava';
import { buildImageDimensionTitle, buildImageMarkdown, parseImageDimensionTitle } from '../../src/image_markdown.ts';

test('buildImageDimensionTitle formats valid dimensions', (t) => {
  t.is(buildImageDimensionTitle({ width: 1200, height: 800 }), 'input-size=1200x800');
});

test('buildImageDimensionTitle rejects invalid dimensions', (t) => {
  t.is(buildImageDimensionTitle({ width: 0, height: 800 }), null);
  t.is(buildImageDimensionTitle({ width: 1200.5, height: 800 }), null);
});

test('parseImageDimensionTitle parses valid metadata', (t) => {
  t.deepEqual(parseImageDimensionTitle('input-size=640x480'), { width: 640, height: 480 });
});

test('parseImageDimensionTitle ignores unrelated titles', (t) => {
  t.is(parseImageDimensionTitle('Screenshot'), null);
  t.is(parseImageDimensionTitle('input-size=640'), null);
});

test('buildImageMarkdown embeds size metadata as the markdown title', (t) => {
  t.is(
    buildImageMarkdown('diagram.png', './.assets/diagram.png', { width: 640, height: 480 }),
    '![diagram.png](./.assets/diagram.png "input-size=640x480")',
  );
});

test('buildImageMarkdown omits title metadata without valid dimensions', (t) => {
  t.is(buildImageMarkdown('diagram.png', './.assets/diagram.png'), '![diagram.png](./.assets/diagram.png)');
});
