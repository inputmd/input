import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import test from 'ava';
import {
  buildExternalContentSyncTransaction,
  externalSyncAnnotation,
  isExternalSyncTransaction,
  markdownListContinuation,
  wrapWithMarker,
} from '../../src/components/markdown_editor_commands.ts';

function makeMockView(doc: string, selection?: EditorSelection): EditorView {
  let currentState = EditorState.create({ doc, selection });
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

test('markdownListContinuation inserts next ordered marker', (t) => {
  const view = makeMockView('1. item', EditorSelection.cursor('1. item'.length));
  const handled = markdownListContinuation(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '1. item\n2. ');
  t.is(view.state.selection.main.head, '1. item\n2. '.length);
});

test('markdownListContinuation clears empty list item marker', (t) => {
  const view = makeMockView('- ', EditorSelection.cursor(2));
  const handled = markdownListContinuation(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '');
  t.is(view.state.selection.main.head, 0);
});

test('markdownListContinuation returns false for non-list text', (t) => {
  const view = makeMockView('plain text', EditorSelection.cursor('plain text'.length));
  const handled = markdownListContinuation(view);

  t.false(handled);
  t.is(view.state.doc.toString(), 'plain text');
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
