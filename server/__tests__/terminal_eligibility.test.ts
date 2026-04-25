import test from 'ava';
import { resolveTerminalRouteEligibility } from '../../src/terminal_eligibility.ts';

test('markdown edit routes remain terminal-eligible', (t) => {
  t.true(
    resolveTerminalRouteEligibility({
      route: { name: 'repoedit', params: { owner: 'octo', repo: 'notes', path: 'docs/readme.md' } },
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
      route: { name: 'repoedit', params: { owner: 'octo', repo: 'notes', path: 'scripts/build.ts' } },
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
      route: { name: 'new', params: {} },
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
      route: { name: 'repofile', params: { owner: 'octo', repo: 'notes', path: 'notes/todo.txt' } },
      routeView: 'content',
      readerAiContentEligible: false,
      currentEditingDocPath: 'notes/todo.txt',
      isScratchDocument: false,
    }),
  );
  t.true(
    resolveTerminalRouteEligibility({
      route: { name: 'repofile', params: { owner: 'octo', repo: 'notes', path: 'notes/todo.txt' } },
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
      route: { name: 'repoedit', params: { owner: 'octo', repo: 'notes', path: 'assets/logo.png' } },
      routeView: 'edit',
      readerAiContentEligible: false,
      currentEditingDocPath: 'assets/logo.png',
      isScratchDocument: false,
    }),
  );
});

test('repo documents route remains terminal-eligible without a selected file', (t) => {
  t.true(
    resolveTerminalRouteEligibility({
      route: { name: 'repodocuments', params: { owner: 'octo', repo: 'notes' } },
      routeView: 'content',
      readerAiContentEligible: false,
      currentEditingDocPath: null,
      isScratchDocument: false,
    }),
  );
});
