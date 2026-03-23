import { history, undo, undoDepth } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import test from 'ava';
import { JSDOM } from 'jsdom';
import { continuedIndentExtension } from '../../src/components/codemirror_continued_indent.ts';
import { fencedCodeLineClassExtension } from '../../src/components/codemirror_fenced_code_lines.ts';
import { markdownEditorLanguageSupport, promptListAnsweringFacet } from '../../src/components/codemirror_markdown.ts';
import {
  backspacePromptQuestionMarker,
  buildExternalContentSyncTransaction,
  buildExternalEditorChangeTransaction,
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

function installDomGlobals(dom: JSDOM): () => void {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousMutationObserver = globalThis.MutationObserver;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousWindowCtor = (globalThis as typeof globalThis & { Window?: typeof Window }).Window;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  dom.window.requestAnimationFrame = () => 0;
  dom.window.cancelAnimationFrame = () => {};
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver as typeof globalThis.MutationObserver;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement as typeof globalThis.HTMLElement;
  globalThis.Node = dom.window.Node as typeof globalThis.Node;
  (globalThis as typeof globalThis & { Window?: typeof Window }).Window = dom.window.Window as typeof Window;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

  return () => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.MutationObserver = previousMutationObserver;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.Node = previousNode;
    (globalThis as typeof globalThis & { Window?: typeof Window }).Window = previousWindowCtor;
    globalThis.getComputedStyle = previousGetComputedStyle;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  };
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

test('buildExternalContentSyncTransaction collapses a prior selection to the previous head by default', (t) => {
  const state = EditorState.create({
    doc: 'abcdef',
    selection: EditorSelection.range(1, 4),
  });

  const spec = buildExternalContentSyncTransaction(state, 'xyz');
  t.truthy(spec);

  const transaction = state.update(spec!);
  t.is(transaction.state.selection.main.anchor, 3);
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

test('buildExternalEditorChangeTransaction emits an external non-history range replacement', (t) => {
  const state = EditorState.create({
    doc: 'hello world',
    selection: EditorSelection.cursor(11),
  });

  const spec = buildExternalEditorChangeTransaction(state, {
    from: 6,
    to: 11,
    insert: 'reader',
    selection: { anchor: 12, head: 12 },
  });
  t.truthy(spec);

  const transaction = state.update(spec!);
  t.true(isExternalSyncTransaction(transaction));
  t.is(transaction.annotation(Transaction.addToHistory), false);
  t.is(transaction.state.doc.toString(), 'hello reader');
  t.is(transaction.state.selection.main.anchor, 12);
  t.is(transaction.state.selection.main.head, 12);
});

test('buildExternalEditorChangeTransaction returns null for unchanged content without selection', (t) => {
  const state = EditorState.create({ doc: 'same' });
  t.is(buildExternalEditorChangeTransaction(state, { from: 0, to: 4, insert: 'same' }), null);
});

test('buildExternalEditorChangeTransaction can update selection without changing content', (t) => {
  const state = EditorState.create({
    doc: 'same',
    selection: EditorSelection.cursor(0),
  });

  const spec = buildExternalEditorChangeTransaction(state, {
    from: 0,
    to: 4,
    insert: 'same',
    selection: { anchor: 2, head: 2 },
  });
  t.truthy(spec);

  const transaction = state.update(spec!);
  t.is(transaction.state.doc.toString(), 'same');
  t.is(transaction.state.selection.main.anchor, 2);
  t.is(transaction.state.selection.main.head, 2);
});

test('buildExternalEditorChangeTransaction can opt AI edits into isolated undo history', (t) => {
  let state = EditorState.create({
    doc: 'hello world',
    selection: EditorSelection.cursor(11),
    extensions: [history()],
  });

  const replaceSpec = buildExternalEditorChangeTransaction(state, {
    from: 6,
    to: 11,
    insert: 'reader',
    selection: { anchor: 12, head: 12 },
    addToHistory: true,
    isolateHistory: 'before',
  });
  t.truthy(replaceSpec);
  state = state.update(replaceSpec!).state;

  const finalizeSpec = buildExternalEditorChangeTransaction(state, {
    from: 12,
    to: 12,
    insert: '',
    selection: { anchor: 12, head: 12 },
    addToHistory: true,
    isolateHistory: 'after',
  });
  t.truthy(finalizeSpec);
  state = state.update(finalizeSpec!).state;

  t.is(undoDepth(state), 1);
  t.true(undo({ state, dispatch: (tr) => (state = tr.state) } as EditorView));
  t.is(state.doc.toString(), 'hello world');
  t.is(state.selection.main.anchor, 11);
  t.is(state.selection.main.head, 11);
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
  const view = makeMockView('= Existing answer', EditorSelection.cursor('= Existing answer'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  const handled = insertNewlineContinuePromptAnswer(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '= Existing answer\n% ');
  t.is(view.state.selection.main.head, '= Existing answer\n% '.length);
});

test('insertNewlineContinuePromptAnswer preserves indent for nested prompt answers', (t) => {
  const view = makeMockView('  = Existing answer', EditorSelection.cursor('  = Existing answer'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  const handled = insertNewlineContinuePromptAnswer(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '  = Existing answer\n  % ');
  t.is(view.state.selection.main.head, '  = Existing answer\n  % '.length);
});

test('insertNewlineContinuePromptAnswer works from the last continuation line of a multiline answer', (t) => {
  const doc = '= Existing answer\n  continuation';
  const view = makeMockView(doc, EditorSelection.cursor(doc.length), [markdown({ base: markdownLanguage })]);

  const handled = insertNewlineContinuePromptAnswer(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '= Existing answer\n  continuation\n% ');
  t.is(view.state.selection.main.head, '= Existing answer\n  continuation\n% '.length);
});

test('insertNewlineContinuePromptAnswer ignores non-answer or non-terminal positions', (t) => {
  const questionView = makeMockView('% Question', EditorSelection.cursor('% Question'.length), [
    markdown({ base: markdownLanguage }),
  ]);
  const midLineView = makeMockView('= Existing answer', EditorSelection.cursor('= Existing'.length), [
    markdown({ base: markdownLanguage }),
  ]);

  t.false(insertNewlineContinuePromptAnswer(questionView));
  t.false(insertNewlineContinuePromptAnswer(midLineView));
});

test('insertNewlineExitPromptQuestion clears an empty trailing prompt question at document end', (t) => {
  const doc = '% Question\n= Answer\n% ';
  const view = makeMockView(doc, EditorSelection.cursor(doc.length), [markdown({ base: markdownLanguage })]);

  const handled = insertNewlineExitPromptQuestion(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '% Question\n= Answer\n\n');
  t.is(view.state.selection.main.head, '% Question\n= Answer\n\n'.length);
});

test('insertNewlineExitPromptQuestion clears an empty trailing prompt question before a non-list line', (t) => {
  const doc = '% Question\n= Answer\n% \nParagraph';
  const questionLineEnd = '% Question\n= Answer\n% '.length;
  const view = makeMockView(doc, EditorSelection.cursor(questionLineEnd), [markdown({ base: markdownLanguage })]);

  const handled = insertNewlineExitPromptQuestion(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '% Question\n= Answer\n\n\nParagraph');
  t.is(view.state.selection.main.head, '% Question\n= Answer\n\n'.length);
});

test('insertNewlineExitPromptQuestion clears empty prompt questions without requiring prior or trailing list context', (t) => {
  const firstLineView = makeMockView('% ', EditorSelection.cursor('% '.length), [markdown({ base: markdownLanguage })]);
  const nonTrailingView = makeMockView('% Question\n% \n= Answer', EditorSelection.cursor('% Question\n% '.length), [
    markdown({ base: markdownLanguage }),
  ]);

  t.true(insertNewlineExitPromptQuestion(firstLineView));
  t.is(firstLineView.state.doc.toString(), '\n');
  t.is(firstLineView.state.selection.main.head, 1);

  t.true(insertNewlineExitPromptQuestion(nonTrailingView));
  t.is(nonTrailingView.state.doc.toString(), '% Question\n\n\n= Answer');
  t.is(nonTrailingView.state.selection.main.head, '% Question\n\n'.length);
});

test('backspacePromptQuestionMarker removes the % marker and preserves trailing spacing', (t) => {
  const view = makeMockView('% ', EditorSelection.cursor('% '.length), [markdown({ base: markdownLanguage })]);

  const handled = backspacePromptQuestionMarker(view);

  t.true(handled);
  t.is(view.state.doc.toString(), ' ');
  t.is(view.state.selection.main.head, 1);
});

test('backspacePromptQuestionMarker preserves indentation when removing a nested prompt marker', (t) => {
  const view = makeMockView('  %   ', EditorSelection.cursor('  %   '.length), [markdown({ base: markdownLanguage })]);

  const handled = backspacePromptQuestionMarker(view);

  t.true(handled);
  t.is(view.state.doc.toString(), '     ');
  t.is(view.state.selection.main.head, 5);
});

test('backspacePromptQuestionMarker ignores non-empty prompt questions and other cursor positions', (t) => {
  const nonEmptyView = makeMockView('% question', EditorSelection.cursor(3), [markdown({ base: markdownLanguage })]);
  const midSpacingView = makeMockView('%  ', EditorSelection.cursor(2), [markdown({ base: markdownLanguage })]);

  t.false(backspacePromptQuestionMarker(nonEmptyView));
  t.false(backspacePromptQuestionMarker(midSpacingView));
});

test('getPromptListRequest returns an insert request for question lines at line end', (t) => {
  const state = EditorState.create({
    doc: '% What is Solomonoff induction?',
    selection: EditorSelection.cursor('% What is Solomonoff induction?'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'What is Solomonoff induction?',
    documentContent: '% What is Solomonoff induction?',
    messages: [{ role: 'user', content: 'What is Solomonoff induction?' }],
    answerIndent: '',
    insertFrom: '% What is Solomonoff induction?'.length,
    insertTo: '% What is Solomonoff induction?'.length,
    insertedPrefix: '\n= ',
    answerFrom: '% What is Solomonoff induction?\n= '.length,
  });
});

test('getPromptListRequest replaces an existing answer line', (t) => {
  const doc = '% What is Solomonoff induction?\n= Old answer';
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor('% What is Solomonoff induction?'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'What is Solomonoff induction?',
    documentContent: doc,
    messages: [{ role: 'user', content: 'What is Solomonoff induction?' }],
    answerIndent: '',
    insertFrom: '% What is Solomonoff induction?\n'.length,
    insertTo: doc.length,
    insertedPrefix: '= ',
    answerFrom: '% What is Solomonoff induction?\n= '.length,
  });
});

test('getPromptListRequest replaces an existing multiline answer block', (t) => {
  const doc = '% Question\n= Old answer\n  continuation';
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor('% Question'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'Question',
    documentContent: doc,
    messages: [{ role: 'user', content: 'Question' }],
    answerIndent: '',
    insertFrom: '% Question\n'.length,
    insertTo: doc.length,
    insertedPrefix: '= ',
    answerFrom: '% Question\n= '.length,
  });
});

test('getPromptListRequest includes prior prompt-list history and local multiline excerpt', (t) => {
  const doc = ['Before', '% First question', '= First answer', '% Follow-up question', 'After'].join('\n');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor('Before\n% First question\n= First answer\n% Follow-up question'.length),
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
    insertFrom: 'Before\n% First question\n= First answer\n% Follow-up question'.length,
    insertTo: 'Before\n% First question\n= First answer\n% Follow-up question'.length,
    insertedPrefix: '\n= ',
    answerFrom: 'Before\n% First question\n= First answer\n% Follow-up question\n= '.length,
  });
});

test('getPromptListRequest keeps prompt-list history across a single blank line between turns', (t) => {
  const doc = ['% First question', '= First answer', '  ', '% Follow-up question'].join('\n');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
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
    insertFrom: doc.length,
    insertTo: doc.length,
    insertedPrefix: '\n= ',
    answerFrom: `${doc}\n= `.length,
  });
});

test('getPromptListRequest treats two blank lines between turns as a new prompt list', (t) => {
  const doc = ['% First question', '= First answer', '  ', '  ', '% Follow-up question'].join('\n');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'Follow-up question',
    documentContent: doc,
    messages: [{ role: 'user', content: 'Follow-up question' }],
    answerIndent: '',
    insertFrom: doc.length,
    insertTo: doc.length,
    insertedPrefix: '\n= ',
    answerFrom: `${doc}\n= `.length,
  });
});

test('getPromptListRequest keeps all prior sibling branches under the same parent in context', (t) => {
  const doc = [
    '% user1',
    '= asst1',
    '  % ignored',
    '  = ignored',
    '    % ignored',
    '    = ignored',
    '% user2',
    '= asst2',
    '  % user2a',
    '  = asst2a',
    '  % user3',
    '  = asst3',
    '    % ignored',
    '    = ignored',
    '  % user4',
    '  = asst4',
    '  % hello',
  ].join('\n');
  const target = doc.length;
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(target),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'hello',
    documentContent: doc,
    messages: [
      { role: 'user', content: 'user1' },
      { role: 'assistant', content: 'asst1' },
      { role: 'user', content: 'user2' },
      { role: 'assistant', content: 'asst2' },
      { role: 'user', content: 'user2a' },
      { role: 'assistant', content: 'asst2a' },
      { role: 'user', content: 'user3' },
      { role: 'assistant', content: 'asst3' },
      { role: 'user', content: 'user4' },
      { role: 'assistant', content: 'asst4' },
      { role: 'user', content: 'hello' },
    ],
    answerIndent: '  ',
    insertFrom: doc.length,
    insertTo: doc.length,
    insertedPrefix: '\n  = ',
    answerFrom: `${doc}\n  = `.length,
  });
});

test('getPromptListRequest replaces an existing nested answer and keeps branch ancestry in context', (t) => {
  const doc = [
    '% root',
    '= root answer',
    '  % child one',
    '  = child one answer',
    '  % child two',
    '  = old child two answer',
    '    continuation',
  ].join('\n');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(
      '% root\n= root answer\n  % child one\n  = child one answer\n  % child two'.length,
    ),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'child two',
    documentContent: doc,
    messages: [
      { role: 'user', content: 'root' },
      { role: 'assistant', content: 'root answer' },
      { role: 'user', content: 'child one' },
      { role: 'assistant', content: 'child one answer' },
      { role: 'user', content: 'child two' },
    ],
    answerIndent: '  ',
    insertFrom: '% root\n= root answer\n  % child one\n  = child one answer\n  % child two\n'.length,
    insertTo: doc.length,
    insertedPrefix: '  = ',
    answerFrom: '% root\n= root answer\n  % child one\n  = child one answer\n  % child two\n  = '.length,
  });
});

test('getPromptListRequest ignores nested descendants when continuing at root level', (t) => {
  const doc = ['% root one', '= root one answer', '  % nested child', '  = nested answer', '% root two'].join('\n');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'root two',
    documentContent: doc,
    messages: [
      { role: 'user', content: 'root one' },
      { role: 'assistant', content: 'root one answer' },
      { role: 'user', content: 'root two' },
    ],
    answerIndent: '',
    insertFrom: doc.length,
    insertTo: doc.length,
    insertedPrefix: '\n= ',
    answerFrom: `${doc}\n= `.length,
  });
});

test('getPromptListRequest supports tab-indented sibling branches', (t) => {
  const doc = [
    '% root',
    '= root answer',
    '% parent',
    '= parent answer',
    '\t% tab one',
    '\t= tab one answer',
    '\t% tab two',
  ].join('\n');
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [EditorState.tabSize.of(2), markdown({ base: markdownLanguage })],
  });

  t.deepEqual(getPromptListRequest(state), {
    prompt: 'tab two',
    documentContent: doc,
    messages: [
      { role: 'user', content: 'root' },
      { role: 'assistant', content: 'root answer' },
      { role: 'user', content: 'parent' },
      { role: 'assistant', content: 'parent answer' },
      { role: 'user', content: 'tab one' },
      { role: 'assistant', content: 'tab one answer' },
      { role: 'user', content: 'tab two' },
    ],
    answerIndent: '\t',
    insertFrom: doc.length,
    insertTo: doc.length,
    insertedPrefix: '\n\t= ',
    answerFrom: `${doc}\n\t= `.length,
  });
});

test('getPromptListRequest ignores non-question prompt list lines and non-terminal cursors', (t) => {
  const nonTerminal = EditorState.create({
    doc: '% What is Solomonoff induction?',
    selection: EditorSelection.cursor('% What is Sol'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });
  const answerLine = EditorState.create({
    doc: '= Existing answer',
    selection: EditorSelection.cursor('= Existing answer'.length),
    extensions: [markdown({ base: markdownLanguage })],
  });

  t.is(getPromptListRequest(nonTerminal), null);
  t.is(getPromptListRequest(answerLine), null);
});

test('prompt question Enter binding wins over markdown Enter handling for multiline answers', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const restore = installDomGlobals(dom);

  try {
    let submitted = false;
    const doc = [
      '% What are some novel HCI interfaces that I could implement inside a text editor?',
      '= - Semantic zoom for code: pinch/keys to smoothly move between tokens, lines, blocks, functions, and architecture views.',
      '   - Intent lens: hold a modifier to reveal why code exists, likely next edits, and affected symbols inline.',
      '% More?',
    ].join('\n');

    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.length),
        extensions: [
          markdownEditorLanguageSupport(),
          promptListAnsweringFacet.of(false),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          fencedCodeLineClassExtension,
          continuedIndentExtension({ mode: 'markdown', maxColumns: 10 }),
          Prec.highest(
            keymap.of([
              {
                key: 'Enter',
                run: (editorView) => {
                  const request = getPromptListRequest(editorView.state);
                  if (!request) return false;
                  submitted = true;
                  return true;
                },
              },
            ]),
          ),
        ],
      }),
      parent: document.getElementById('app')!,
    });

    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    t.true(runScopeHandlers(view, event, 'editor'));
    t.true(submitted);
  } finally {
    restore();
  }
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
