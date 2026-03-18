import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type Extension, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import test from 'ava';
import {
  buildExternalContentSyncTransaction,
  externalSyncAnnotation,
  getPromptListRequest,
  insertNewlineContinueLooseListItem,
  insertNewlineContinuePromptAnswer,
  insertNewlineExitBlockquote,
  insertNewlineExitPromptQuestion,
  isExternalSyncTransaction,
  normalizeBlockquotePaste,
  wrapWithMarker,
} from '../../src/components/markdown_editor_commands.ts';

function makeMockView(doc: string, selection?: EditorSelection, extensions: Extension[] = []): EditorView {
  let currentState = EditorState.create({ doc, selection, extensions });
  return {
    get state() {
      return currentState;
    },
    dispatch(transactionOrSpec: Transaction | TransactionSpec) {
      const transaction =
        transactionOrSpec instanceof Transaction ? transactionOrSpec : currentState.update(transactionOrSpec);
      currentState = transaction.state;
    },
  } as EditorView;
}

test('wrapWithMarker wraps selected text and keeps selection around content', (t) => {
  const view = makeMockView('hello world', EditorSelection.range(0, 5));
  const handled = wrapWithMarker(view, '**');

  t.true(handled);
  t.is(view.state.doc.toString(), '**hello** world');
  t.is(view.state.selection.main.from, 2);
  t.is(view.state.selection.main.to, 7);
});

test('wrapWithMarker unwraps selected text when markers already surround selection', (t) => {
  const view = makeMockView('**hello** world', EditorSelection.range(2, 7));
  const handled = wrapWithMarker(view, '**');

  t.true(handled);
  t.is(view.state.doc.toString(), 'hello world');
  t.is(view.state.selection.main.from, 0);
  t.is(view.state.selection.main.to, 5);
});

test('buildExternalContentSyncTransaction emits external non-history transaction', (t) => {
  const state = EditorState.create({
    doc: 'abcdef',
    selection: EditorSelection.cursor(6),
  });

  const spec = buildExternalContentSyncTransaction(state, 'xyz');
  t.truthy(spec);

  const transaction = state.update(spec!);
  t.true(isExternalSyncTransaction(transaction));
  t.is(transaction.annotation(Transaction.addToHistory), false);
  t.is(transaction.state.doc.toString(), 'xyz');
  t.is(transaction.state.selection.main.head, 3);
});

test('buildExternalContentSyncTransaction can restore an explicit selection', (t) => {
  const state = EditorState.create({
    doc: 'abcdef',
    selection: EditorSelection.cursor(0),
  });

  const spec = buildExternalContentSyncTransaction(state, 'hello world', { anchor: 5, head: 5 });
  t.truthy(spec);

  const transaction = state.update(spec!);
  t.is(transaction.state.selection.main.anchor, 5);
  t.is(transaction.state.selection.main.head, 5);
});

test('buildExternalContentSyncTransaction returns null when content is unchanged', (t) => {
  const state = EditorState.create({ doc: 'same' });
  t.is(buildExternalContentSyncTransaction(state, 'same'), null);
});

test('isExternalSyncTransaction detects only external user events', (t) => {
  const state = EditorState.create({ doc: 'x' });
  const external = state.update({ annotations: externalSyncAnnotation });
  const input = state.update({ annotations: Transaction.userEvent.of('input.type') });

  t.true(isExternalSyncTransaction(external));
  t.false(isExternalSyncTransaction(input));
});

test('insertNewlineContinueLooseListItem continues within loose list item', (t) => {
  const view = makeMockView('- first\n\n- second', EditorSelection.cursor('- first\n\n- sec'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  const handled = insertNewlineContinueLooseListItem(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '- first\n\n- sec\nond');
  t.is(view.state.selection.main.head, '- first\n\n- sec\n'.length);
});

test('insertNewlineContinueLooseListItem ignores tight lists', (t) => {
  const view = makeMockView('- first\n- second', EditorSelection.cursor('- sec'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  t.false(insertNewlineContinueLooseListItem(view));
});

test('insertNewlineExitBlockquote exits a plain blockquote at line end', (t) => {
  const view = makeMockView('> foo', EditorSelection.cursor('> foo'.length), [markdown({ base: markdownLanguage })]);

  const handled = insertNewlineExitBlockquote(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '> foo\n');
  t.is(view.state.selection.main.head, '> foo\n'.length);
});

test('insertNewlineExitBlockquote ignores non-terminal cursor positions', (t) => {
  const view = makeMockView('> foo', EditorSelection.cursor('> fo'.length), [markdown({ base: markdownLanguage })]);

  t.false(insertNewlineExitBlockquote(view));
});

test('insertNewlineContinuePromptAnswer creates a prompt question line after an answer', (t) => {
  const view = makeMockView('-⏺ Existing answer', EditorSelection.cursor('-⏺ Existing answer'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  const handled = insertNewlineContinuePromptAnswer(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '-⏺ Existing answer\n-* ');
  t.is(view.state.selection.main.head, '-⏺ Existing answer\n-* '.length);
});

test('insertNewlineContinuePromptAnswer preserves indent for nested prompt answers', (t) => {
  const view = makeMockView('  -⏺ Existing answer', EditorSelection.cursor('  -⏺ Existing answer'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  const handled = insertNewlineContinuePromptAnswer(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '  -⏺ Existing answer\n  -* ');
  t.is(view.state.selection.main.head, '  -⏺ Existing answer\n  -* '.length);
});

test('insertNewlineContinuePromptAnswer works from the last continuation line of a multiline answer', (t) => {
  const doc = '-⏺ Existing answer\n  continuation';
  const view = makeMockView(doc, EditorSelection.cursor(doc.length), [markdown({ base: markdownLanguage })]);

  const handled = insertNewlineContinuePromptAnswer(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '-⏺ Existing answer\n  continuation\n-* ');
  t.is(view.state.selection.main.head, '-⏺ Existing answer\n  continuation\n-* '.length);
});

test('insertNewlineContinuePromptAnswer ignores non-answer or non-terminal positions', (t) => {
  const questionView = makeMockView('-* Question', EditorSelection.cursor('-* Question'.length), [
    markdown({ base: markdownLanguage }),
  ]);
  const midLineView = makeMockView('-⏺ Existing answer', EditorSelection.cursor('-⏺ Existing'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  t.false(insertNewlineContinuePromptAnswer(questionView));
  t.false(insertNewlineContinuePromptAnswer(midLineView));
});

test('insertNewlineExitPromptQuestion clears an empty trailing prompt question at document end', (t) => {
  const doc = '-* Question\n-⏺ Answer\n-* ';
  const view = makeMockView(doc, EditorSelection.cursor(doc.length), [markdown({ base: markdownLanguage })]);

  const handled = insertNewlineExitPromptQuestion(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '-* Question\n-⏺ Answer\n\n');
  t.is(view.state.selection.main.head, '-* Question\n-⏺ Answer\n\n'.length);
});

test('insertNewlineExitPromptQuestion clears an empty trailing prompt question before a non-list line', (t) => {
  const doc = '-* Question\n-⏺ Answer\n-* \nParagraph';
  const questionLineEnd = '-* Question\n-⏺ Answer\n-* '.length;
  const view = makeMockView(doc, EditorSelection.cursor(questionLineEnd), [markdown({ base: markdownLanguage })]);

  const handled = insertNewlineExitPromptQuestion(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '-* Question\n-⏺ Answer\n\nParagraph');
  t.is(view.state.selection.main.head, '-* Question\n-⏺ Answer\n'.length);
});

test('insertNewlineExitPromptQuestion ignores empty prompt questions without prior list entries or with following list items', (t) => {
  const firstLineView = makeMockView('-* ', EditorSelection.cursor('-* '.length), [
    markdown({ base: markdownLanguage }),
  ]);
  const nonTrailingView = makeMockView(
    '-* Question\n-* \n-⏺ Answer',
    EditorSelection.cursor('-* Question\n-* '.length),
    [markdown({ base: markdownLanguage })],
  );

  t.false(insertNewlineExitPromptQuestion(firstLineView));
  t.false(insertNewlineExitPromptQuestion(nonTrailingView));
});

test('getPromptListRequest returns an insert request for question lines at line end', (t) => {
  const state = EditorState.create({
    doc: '-* What is Solomonoff induction?',
    selection: EditorSelection.cursor('-* What is Solomonoff induction?'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'What is Solomonoff induction?',
    documentContent: '-* What is Solomonoff induction?',
    messages: [{ role: 'user', content: 'What is Solomonoff induction?' }],
    answerIndent: '',
    insertFrom: '-* What is Solomonoff induction?'.length,
    insertTo: '-* What is Solomonoff induction?'.length,
    insertedPrefix: '\n-⏺ ',
    answerFrom: '-* What is Solomonoff induction?\n-⏺ '.length,
  });
});

test('getPromptListRequest replaces an existing answer line', (t) => {
  const doc = '-* What is Solomonoff induction?\n-⏺ Old answer';
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor('-* What is Solomonoff induction?'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'What is Solomonoff induction?',
    documentContent: doc,
    messages: [{ role: 'user', content: 'What is Solomonoff induction?' }],
    answerIndent: '',
    insertFrom: '-* What is Solomonoff induction?\n'.length,
    insertTo: doc.length,
    insertedPrefix: '-⏺ ',
    answerFrom: '-* What is Solomonoff induction?\n-⏺ '.length,
  });
});

test('getPromptListRequest replaces an existing multiline answer block', (t) => {
  const doc = '-* Question\n-⏺ Old answer\n  continuation';
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor('-* Question'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'Question',
    documentContent: doc,
    messages: [{ role: 'user', content: 'Question' }],
    answerIndent: '',
    insertFrom: '-* Question\n'.length,
    insertTo: doc.length,
    insertedPrefix: '-⏺ ',
    answerFrom: '-* Question\n-⏺ '.length,
  });
});

test('getPromptListRequest includes prior prompt-list history and local multiline excerpt', (t) => {
  const doc = ['Before', '-* First question', '-⏺ First answer', '-* Follow-up question', 'After'].join('\n');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor('Before\n-* First question\n-⏺ First answer\n-* Follow-up question'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'Follow-up question',
    documentContent: doc,
    messages: [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up question' },
    ],
    answerIndent: '',
    insertFrom: 'Before\n-* First question\n-⏺ First answer\n-* Follow-up question'.length,
    insertTo: 'Before\n-* First question\n-⏺ First answer\n-* Follow-up question'.length,
    insertedPrefix: '\n-⏺ ',
    answerFrom: 'Before\n-* First question\n-⏺ First answer\n-* Follow-up question\n-⏺ '.length,
  });
});

test('getPromptListRequest ignores non-question prompt list lines and non-terminal cursors', (t) => {
  const nonTerminal = EditorState.create({
    doc: '-* What is Solomonoff induction?',
    selection: EditorSelection.cursor('-* What is Sol'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });
  const answerLine = EditorState.create({
    doc: '-⏺ Existing answer',
    selection: EditorSelection.cursor('-⏺ Existing answer'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.is(getPromptListRequest(nonTerminal), null);
  t.is(getPromptListRequest(answerLine), null);
});

test('normalizeBlockquotePaste continues blockquote prefixes for pasted multiline text', (t) => {
  const state = EditorState.create({
    doc: '> quoted',
    selection: EditorSelection.cursor('> quo'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.is(normalizeBlockquotePaste(state, state.selection.main.from, 'alpha\nbeta\ngamma'), 'alpha\n> beta\n> gamma');
});

test('normalizeBlockquotePaste turns pasted links at blockquote end into source citations', (t) => {
  const state = EditorState.create({
    doc: '> quoted line',
    selection: EditorSelection.cursor('> quoted line'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.is(
    normalizeBlockquotePaste(state, state.selection.main.from, 'https://example.com/source'),
    '[^src](https://example.com/source)',
  );
});

test('normalizeBlockquotePaste does not create a citation inside a markdown link url', (t) => {
  const state = EditorState.create({
    doc: '> [^src](',
    selection: EditorSelection.cursor('> [^src]('.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.is(normalizeBlockquotePaste(state, state.selection.main.from, 'https://example.com/source'), null);
});
