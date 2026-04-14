import test from 'ava';
import { resolveTerminalRouteEligibility } from '../../src/terminal_eligibility.ts';

test('markdown edit routes remain terminal-eligible', (t) => {
  t.true(
    resolveTerminalRouteEligibility({
      routeView: 'edit',
      readerAiContentEligible: false,
      currentEditingDocPath: 'docs/readme.md',
      isScratchDocument: false,
    }),
  );
});

test('non-markdown editable text edit routes are terminal-eligible', (t) => {
  t.true(
    resolveTerminalRouteEligibility({
      routeView: 'edit',
      readerAiContentEligible: false,
      currentEditingDocPath: 'scripts/build.ts',
      isScratchDocument: false,
    }),
  );
});

test('scratch edit routes remain terminal-eligible without a file path', (t) => {
  t.true(
    resolveTerminalRouteEligibility({
      routeView: 'edit',
      readerAiContentEligible: false,
      currentEditingDocPath: null,
      isScratchDocument: true,
    }),
  );
});

test('non-edit routes still defer to reader ai content eligibility', (t) => {
  t.false(
    resolveTerminalRouteEligibility({
      routeView: 'content',
      readerAiContentEligible: false,
      currentEditingDocPath: 'notes/todo.txt',
      isScratchDocument: false,
    }),
  );
  t.true(
    resolveTerminalRouteEligibility({
      routeView: 'content',
      readerAiContentEligible: true,
      currentEditingDocPath: 'notes/todo.txt',
      isScratchDocument: false,
    }),
  );
});

test('binary-looking edit targets stay terminal-ineligible', (t) => {
  t.false(
    resolveTerminalRouteEligibility({
      routeView: 'edit',
      readerAiContentEligible: false,
      currentEditingDocPath: 'assets/logo.png',
      isScratchDocument: false,
    }),
  );
});
