import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type Extension, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import test from 'ava';
import {
  buildExternalContentSyncTransaction,
  externalSyncAnnotation,
  insertNewlineContinueLooseListItem,
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
    ' [^src](https://example.com/source)',
  );
});
