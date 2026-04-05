import test from 'ava';
import { buildReaderAiDocumentSource } from '../../src/reader_ai_context.ts';

test('buildReaderAiDocumentSource preserves CriticMarkup comments in edit mode', (t) => {
  const currentEditContent = ['# Draft', '', 'Intro paragraph.', '{>>keep this comment<<}', 'Closing line.', ''].join(
    '\n',
  );

  const source = buildReaderAiDocumentSource({
    allowDocumentEdits: true,
    currentEditContent,
    readerAiSource: 'ignored',
  });

  t.is(source, currentEditContent);
  t.true(source.includes('{>>keep this comment<<}'));
});

test('buildReaderAiDocumentSource prefers staged proposal content in edit mode', (t) => {
  const source = buildReaderAiDocumentSource({
    allowDocumentEdits: true,
    currentEditContent: 'Editor buffer\n',
    documentEditedContent: 'Pending staged edit\n',
    readerAiSource: 'Rendered view content\n',
  });

  t.is(source, 'Pending staged edit\n');
});

test('buildReaderAiDocumentSource uses the non-editor source outside edit mode', (t) => {
  const source = buildReaderAiDocumentSource({
    allowDocumentEdits: false,
    currentEditContent: 'ignored',
    documentEditedContent: 'Pending staged edit\n',
    readerAiSource: 'Rendered view content\n',
  });

  t.is(source, 'Rendered view content\n');
});
