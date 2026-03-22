import test from 'ava';
import {
  canGitHubUserEditMarkdownDocument,
  normalizeGitHubHandle,
  parseDocumentEditorsFromMarkdown,
  validateEditorsPreserved,
} from '../../src/document_permissions.ts';

test('normalizeGitHubHandle lowercases and strips leading at-signs', (t) => {
  t.is(normalizeGitHubHandle('@Alice-Test'), 'alice-test');
  t.is(normalizeGitHubHandle('"@Bob"'), 'bob');
  t.is(normalizeGitHubHandle(''), null);
  t.is(normalizeGitHubHandle('-bad'), null);
});

test('parseDocumentEditorsFromMarkdown reads multiline editors lists from front matter', (t) => {
  const parsed = parseDocumentEditorsFromMarkdown(`---
title: Example
editors:
  - Alice
  - "@bob"
  - alice
---
# Hello`);

  t.deepEqual(parsed, {
    editors: ['alice', 'bob'],
    error: null,
  });
});

test('parseDocumentEditorsFromMarkdown reads inline editors lists and scalars', (t) => {
  t.deepEqual(
    parseDocumentEditorsFromMarkdown(`---
editors: [alice, "@Bob"]
---
Body`),
    {
      editors: ['alice', 'bob'],
      error: null,
    },
  );

  t.deepEqual(
    parseDocumentEditorsFromMarkdown(`---
editors: "@Carol"
---
Body`),
    {
      editors: ['carol'],
      error: null,
    },
  );
});

test('parseDocumentEditorsFromMarkdown reports malformed editors front matter', (t) => {
  const parsed = parseDocumentEditorsFromMarkdown(`---
editors:
 - alice
   - bob
---
Body`);

  t.is(parsed.error, 'Could not parse editors front matter');
  t.deepEqual(parsed.editors, []);
});

test('canGitHubUserEditMarkdownDocument checks normalized logins against editors', (t) => {
  const markdown = `---
editors:
  - Alice
  - bob
---
Body`;

  t.true(canGitHubUserEditMarkdownDocument(markdown, '@alice'));
  t.true(canGitHubUserEditMarkdownDocument(markdown, 'BOB'));
  t.false(canGitHubUserEditMarkdownDocument(markdown, 'carol'));
});

test('validateEditorsPreserved allows body changes when editors list is unchanged', (t) => {
  const original = `---
editors:
  - alice
  - bob
---
Original body`;
  const updated = `---
editors:
  - alice
  - bob
---
Updated body`;
  t.is(validateEditorsPreserved(original, updated), null);
});

test('validateEditorsPreserved allows reordered editors', (t) => {
  const original = `---
editors:
  - alice
  - bob
---
Body`;
  const updated = `---
editors:
  - bob
  - alice
---
Body`;
  t.is(validateEditorsPreserved(original, updated), null);
});

test('validateEditorsPreserved rejects adding an editor', (t) => {
  const original = `---
editors:
  - alice
---
Body`;
  const updated = `---
editors:
  - alice
  - carol
---
Body`;
  t.is(validateEditorsPreserved(original, updated), 'Editors list cannot be modified');
});

test('validateEditorsPreserved rejects removing an editor', (t) => {
  const original = `---
editors:
  - alice
  - bob
---
Body`;
  const updated = `---
editors:
  - alice
---
Body`;
  t.is(validateEditorsPreserved(original, updated), 'Editors list cannot be modified');
});

test('validateEditorsPreserved rejects removing the editors field entirely', (t) => {
  const original = `---
editors:
  - alice
---
Body`;
  const updated = `---
title: No editors
---
Body`;
  t.is(validateEditorsPreserved(original, updated), 'Editors list cannot be removed');
});

test('validateEditorsPreserved rejects removing front matter entirely', (t) => {
  const original = `---
editors:
  - alice
---
Body`;
  const updated = 'Just plain body text';
  t.is(validateEditorsPreserved(original, updated), 'Editors list cannot be removed');
});
