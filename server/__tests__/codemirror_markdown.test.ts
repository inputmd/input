import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import test from 'ava';
import {
  markdownCodeLanguageSupport,
  markdownEditorLanguageSupport,
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
