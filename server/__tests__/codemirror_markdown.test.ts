import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import test from 'ava';
import {
  bracePromptHintForText,
  bracePromptHintLabelForText,
  bracePromptRangesForText,
  markdownCodeLanguageSupport,
  markdownEditorLanguageSupport,
  promptListHintLabelForText,
} from '../../src/components/codemirror_markdown.ts';

function syntaxNodeNames(state: EditorState): Set<string> {
  const names = new Set<string>();
  syntaxTree(state).iterate({
    enter: (node) => {
      names.add(node.name);
    },
  });
  return names;
}

test('markdown editor language does not parse html comments', (t) => {
  const state = EditorState.create({
    doc: 'before <!--\nafter',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.false(names.has('HtmlComment'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown code view language does not parse html comments', (t) => {
  const state = EditorState.create({
    doc: 'before <!-- after',
    extensions: [markdownCodeLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.false(names.has('HtmlComment'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown editor language parses closed html comments without enabling html parsing', (t) => {
  const state = EditorState.create({
    doc: 'before <!-- comment --> after',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.true(names.has('HtmlComment'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown editor language parses multiline html comments without enabling html parsing', (t) => {
  const state = EditorState.create({
    doc: '<!--\n*comment*\n-->\nafter',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.true(names.has('HtmlCommentBlock'));
  t.false(names.has('Emphasis'));
  t.false(names.has('CommentBlock'));
  t.false(names.has('HTMLBlock'));
  t.false(names.has('HTMLTag'));
});

test('markdown editor language keeps inline comment content opaque to emphasis parsing', (t) => {
  const state = EditorState.create({
    doc: 'before <!-- *comment* --> after',
    extensions: [markdownEditorLanguageSupport()],
  });

  const names = syntaxNodeNames(state);
  t.true(names.has('HtmlComment'));
  t.false(names.has('Emphasis'));
});

test('promptListHintLabelForText returns question hint labels', (t) => {
  t.is(promptListHintLabelForText('~ '), 'Type to ask AI');
  t.is(promptListHintLabelForText('~ Explain Solomonoff induction'), null);
  t.is(promptListHintLabelForText('❯ '), null);
});

test('promptListHintLabelForText returns answering hint for blank answers while streaming', (t) => {
  t.is(promptListHintLabelForText('⏺ ', true), 'Answering... (Esc to cancel)');
  t.is(promptListHintLabelForText('⏺ Existing answer', true), null);
  t.is(promptListHintLabelForText('⏺ ', false), null);
});

test('promptListHintLabelForText ignores non-question lines', (t) => {
  t.is(promptListHintLabelForText('⏺ Existing answer'), null);
  t.is(promptListHintLabelForText('- regular bullet'), null);
});

test('bracePromptHintLabelForText returns a hint at the end of a brace prompt', (t) => {
  const text = 'today {come up with two more examples}';
  t.is(bracePromptHintLabelForText(text, text.length), '⇥');
  t.deepEqual(bracePromptHintForText(text, text.length), {
    position: text.length,
    label: '⇥',
    className: 'cm-brace-prompt-hint',
  });
});

test('bracePromptHintLabelForText ignores positions away from a completed brace prompt', (t) => {
  const text = 'today {come up with two more examples} next';
  t.is(bracePromptHintLabelForText(text, text.length), null);
  t.is(bracePromptHintLabelForText(text, 'today {come'.length), null);
  t.deepEqual(bracePromptHintForText(text, text.length), null);
});

test('brace prompt syntax exists inside code, but editor parsing can identify those code contexts', (t) => {
  const inlineState = EditorState.create({
    doc: '`{query}`',
    extensions: [markdownEditorLanguageSupport()],
  });
  const fencedState = EditorState.create({
    doc: '```md\n{query}\n```',
    extensions: [markdownEditorLanguageSupport()],
  });

  t.true(syntaxNodeNames(inlineState).has('InlineCode'));
  t.true(syntaxNodeNames(fencedState).has('FencedCode'));
});

test('bracePromptHintForText anchors the hint at the closing brace', (t) => {
  const text = 'today {come up with two more examples} next';
  t.deepEqual(bracePromptHintForText(text, 'today {come up with two more examples}'.length), {
    position: 'today {come up with two more examples}'.length,
    label: '⇥',
    className: 'cm-brace-prompt-hint',
  });
});

test('bracePromptRangesForText returns valid brace prompt spans only', (t) => {
  t.deepEqual(bracePromptRangesForText('before {prompt} after'), [{ from: 7, to: 15 }]);
  t.deepEqual(bracePromptRangesForText('before {{skip}} and {keep}'), [{ from: 20, to: 26 }]);
  t.deepEqual(bracePromptRangesForText('before {++critic++} and {keep}'), [{ from: 24, to: 30 }]);
});
