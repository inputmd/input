import test from 'ava';
import {
  buildPiSessionTree,
  buildPiSessionTreeRows,
  getDefaultPiSessionLeafId,
  parsePiSessionJsonl,
} from '../../src/pi_session.ts';

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

test('parsePiSessionJsonl skips malformed lines and parses valid pi sessions', (t) => {
  const content = `${jsonl([
    { type: 'session', id: 'session-1', version: 3 },
    {
      type: 'message',
      id: 'a',
      parentId: null,
      timestamp: '2026-04-25T00:00:00.000Z',
      message: { role: 'user', content: 'user message' },
    },
  ])}\n{`;

  const parsed = parsePiSessionJsonl(content);

  t.is(parsed.header?.id, 'session-1');
  t.is(parsed.entries.length, 1);
  t.is(parsed.entries[0].id, 'a');
  t.is(parsed.parseErrors.length, 1);
});

test('parsePiSessionJsonl migrates v1 linear sessions to parent-linked entries', (t) => {
  const parsed = parsePiSessionJsonl(
    jsonl([
      { type: 'session', id: 'session-1', version: 1 },
      { type: 'message', timestamp: '2026-04-25T00:00:00.000Z', message: { role: 'user', content: 'message one' } },
      {
        type: 'message',
        timestamp: '2026-04-25T00:01:00.000Z',
        message: { role: 'assistant', content: 'message two' },
      },
    ]),
  );

  t.is(parsed.header?.version, 3);
  t.is(parsed.entries[0].id, 'migrated-1');
  t.is(parsed.entries[0].parentId, null);
  t.is(parsed.entries[1].id, 'migrated-2');
  t.is(parsed.entries[1].parentId, 'migrated-1');
});

test('parsePiSessionJsonl light mode returns the first user message from the first 75 lines only', (t) => {
  const entries: unknown[] = [{ type: 'session', id: 'session-1', version: 3 }];
  for (let index = 1; index < 75; index += 1) {
    entries.push({
      type: 'message',
      id: `assistant-${index}`,
      parentId: index === 1 ? null : `assistant-${index - 1}`,
      message: { role: 'assistant', content: `assistant message ${index}` },
    });
  }
  entries.push({
    type: 'message',
    id: 'late-user',
    parentId: 'assistant-74',
    message: { role: 'user', content: 'late user message' },
  });

  t.is(parsePiSessionJsonl(jsonl(entries), { light: true }).firstUserMessage, null);
  t.is(parsePiSessionJsonl(jsonl(entries)).firstUserMessage, 'late user message');

  const earlyEntries = [
    { type: 'session', id: 'session-2', version: 3 },
    {
      type: 'message',
      id: 'early-user',
      parentId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'block user message' }] },
    },
  ];

  t.is(parsePiSessionJsonl(jsonl(earlyEntries), { light: true }).firstUserMessage, 'block user message');
});

test('buildPiSessionTree resolves labels and treats orphans as roots', (t) => {
  const parsed = parsePiSessionJsonl(
    jsonl([
      { type: 'session', id: 'session-1', version: 3 },
      {
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-04-25T00:00:00.000Z',
        message: { role: 'user', content: 'root message' },
      },
      {
        type: 'message',
        id: 'orphan',
        parentId: 'missing',
        timestamp: '2026-04-25T00:01:00.000Z',
        message: { role: 'user', content: 'orphan message' },
      },
      {
        type: 'label',
        id: 'label-1',
        parentId: 'orphan',
        targetId: 'root',
        label: 'label text',
        timestamp: '2026-04-25T00:02:00.000Z',
      },
    ]),
  );

  const tree = buildPiSessionTree(parsed.entries);

  t.deepEqual(
    tree.map((node) => node.entry.id),
    ['root', 'orphan'],
  );
  t.is(tree[0].label, 'label text');
});

test('buildPiSessionTreeRows filters settings entries and formats tool results', (t) => {
  const parsed = parsePiSessionJsonl(
    jsonl([
      { type: 'session', id: 'session-1', version: 3 },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-04-25T00:00:00.000Z',
        message: { role: 'user', content: 'user request' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-04-25T00:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'package.json' } }],
        },
      },
      {
        type: 'message',
        id: 't1',
        parentId: 'a1',
        timestamp: '2026-04-25T00:02:00.000Z',
        message: { role: 'toolResult', toolCallId: 'tc1', content: '...' },
      },
      {
        type: 'session_info',
        id: 'title',
        parentId: 't1',
        timestamp: '2026-04-25T00:03:00.000Z',
        name: 'session title',
      },
    ]),
  );

  const rows = buildPiSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: getDefaultPiSessionLeafId(parsed.entries),
    selectedEntryId: 't1',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });

  t.deepEqual(
    rows.map((row) => row.id),
    ['u1', 't1'],
  );
  t.true(rows[0].text.includes('user request'));

  const compactRows = buildPiSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: getDefaultPiSessionLeafId(parsed.entries),
    selectedEntryId: 't1',
    filterMode: 'default',
    foldedIds: new Set(),
  });

  t.deepEqual(
    compactRows.map((row) => row.id),
    ['u1'],
  );
  t.false(compactRows.some((row) => row.text.includes('[read: package.json]')));

  const allRows = buildPiSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 't1',
    selectedEntryId: 't1',
    filterMode: 'full',
    foldedIds: new Set(),
  });

  t.true(allRows.some((row) => row.text === '[read: package.json]'));
});

test('buildPiSessionTreeRows keeps single-child conversations visually flat and indents branches', (t) => {
  const parsed = parsePiSessionJsonl(
    jsonl([
      { type: 'session', id: 'session-1', version: 3 },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-04-25T00:00:00.000Z',
        message: { role: 'user', content: 'first message' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-04-25T00:01:00.000Z',
        message: { role: 'assistant', content: 'first response' },
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'a1',
        timestamp: '2026-04-25T00:02:00.000Z',
        message: { role: 'user', content: 'second message' },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'u2',
        timestamp: '2026-04-25T00:02:30.000Z',
        message: { role: 'assistant', content: 'second response' },
      },
      {
        type: 'message',
        id: 'branch',
        parentId: 'a1',
        timestamp: '2026-04-25T00:03:00.000Z',
        message: { role: 'user', content: 'branch message' },
      },
      {
        type: 'message',
        id: 'branch-assistant',
        parentId: 'branch',
        timestamp: '2026-04-25T00:03:30.000Z',
        message: { role: 'assistant', content: 'branch response' },
      },
    ]),
  );

  const linearRows = buildPiSessionTreeRows({
    entries: parsed.entries.filter((entry) => entry.id !== 'branch' && entry.id !== 'branch-assistant'),
    currentLeafId: 'u2',
    selectedEntryId: 'u2',
    filterMode: 'default',
    foldedIds: new Set(),
  });

  t.deepEqual(
    linearRows.map((row) => row.indentColumns),
    [0, 0, 0, 0],
  );
  t.false(linearRows.some((row) => row.isFoldable));

  const branchedRows = buildPiSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u2',
    selectedEntryId: 'u2',
    filterMode: 'default',
    foldedIds: new Set(),
  });

  const childRows = branchedRows.filter((row) => row.id === 'u2' || row.id === 'branch');
  t.true(childRows.every((row) => row.indentColumns === 2));
  t.deepEqual(
    branchedRows.filter((row) => row.isFoldable).map((row) => row.id),
    ['u2', 'branch'],
  );
});

test('buildPiSessionTreeRows preserves assistant markdown line breaks', (t) => {
  const parsed = parsePiSessionJsonl(
    jsonl([
      { type: 'session', id: 'session-1', version: 3 },
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        timestamp: '2026-04-25T00:01:00.000Z',
        message: {
          role: 'assistant',
          content: 'first paragraph\n\nsecond paragraph',
        },
      },
    ]),
  );

  const rows = buildPiSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'a1',
    selectedEntryId: 'a1',
    filterMode: 'full',
    foldedIds: new Set(),
  });

  t.is(rows[0]?.text, 'assistant: first paragraph\n\nsecond paragraph');
});
