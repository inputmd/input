import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import test from 'ava';
import { isFencedCodeLine } from '../../src/components/codemirror_fenced_code_lines.ts';

test('isFencedCodeLine detects fenced code lines without matching normal lines', (t) => {
  const doc = ['Before', '```ts', 'const x = 1;', '```', 'After'].join('\n');
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });

  const beforeLine = state.doc.line(1);
  const fenceStartLine = state.doc.line(2);
  const codeLine = state.doc.line(3);
  const fenceEndLine = state.doc.line(4);
  const afterLine = state.doc.line(5);

  t.false(isFencedCodeLine(state, beforeLine.from, beforeLine.to));
  t.true(isFencedCodeLine(state, fenceStartLine.from, fenceStartLine.to));
  t.true(isFencedCodeLine(state, codeLine.from, codeLine.to));
  t.true(isFencedCodeLine(state, fenceEndLine.from, fenceEndLine.to));
  t.false(isFencedCodeLine(state, afterLine.from, afterLine.to));
});
