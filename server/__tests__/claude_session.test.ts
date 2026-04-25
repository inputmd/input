import test from 'ava';
import {
  buildClaudeSessionTreeRows,
  getDefaultClaudeSessionLeafId,
  parseClaudeSessionJsonl,
} from '../../src/claude_session.ts';

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

test('parseClaudeSessionJsonl parses Claude Code transcript entries', (t) => {
  const parsed = parseClaudeSessionJsonl(
    `${jsonl([
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2026-04-25T10:00:00.000Z',
        message: { role: 'user', content: 'user message' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'session-1',
        timestamp: '2026-04-25T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant message' }] },
      },
    ])}\n{`,
  );

  t.is(parsed.sessionId, 'session-1');
  t.is(parsed.firstUserMessage, 'user message');
  t.is(parsed.entries.length, 2);
  t.is(parsed.entries[1].parentId, 'u1');
  t.is(parsed.parseErrors.length, 1);
});

test('parseClaudeSessionJsonl light mode ignores late user messages', (t) => {
  const entries: unknown[] = [];
  for (let index = 0; index < 75; index += 1) {
    entries.push({
      type: 'assistant',
      uuid: `a${index}`,
      parentUuid: index === 0 ? null : `a${index - 1}`,
      message: { role: 'assistant', content: [{ type: 'text', text: `assistant message ${index}` }] },
    });
  }
  entries.push({
    type: 'user',
    uuid: 'late-user',
    parentUuid: 'a74',
    message: { role: 'user', content: 'late user message' },
  });

  t.is(parseClaudeSessionJsonl(jsonl(entries), { light: true }).firstUserMessage, null);
  t.is(parseClaudeSessionJsonl(jsonl(entries)).firstUserMessage, 'late user message');
});

test('buildClaudeSessionTreeRows renders branches and coalesced tool results', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-04-25T10:00:00.000Z',
        message: { role: 'user', content: 'user request' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-04-25T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }],
        },
      },
      {
        type: 'user',
        uuid: 'tool-result',
        parentUuid: 'a1',
        timestamp: '2026-04-25T10:02:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'tool-result',
        timestamp: '2026-04-25T10:03:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant response' }] },
      },
      {
        type: 'user',
        uuid: 'branch',
        parentUuid: 'a1',
        timestamp: '2026-04-25T10:04:00.000Z',
        message: { role: 'user', content: 'branch request' },
      },
      {
        type: 'assistant',
        uuid: 'branch-assistant',
        parentUuid: 'branch',
        timestamp: '2026-04-25T10:05:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'branch response' }] },
      },
    ]),
  );

  const rows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: getDefaultClaudeSessionLeafId(parsed.entries),
    selectedEntryId: 'tool-result',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });

  t.true(rows.some((row) => row.text === '[read: package.json] result'));
  t.false(rows.some((row) => row.id === 'tool-result'));
  t.deepEqual(
    rows.filter((row) => row.id === 'a2' || row.id === 'branch').map((row) => row.indentColumns),
    [2, 2],
  );
  t.deepEqual(
    rows.filter((row) => row.isFoldable).map((row) => row.id),
    ['branch'],
  );

  const compactRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: getDefaultClaudeSessionLeafId(parsed.entries),
    selectedEntryId: 'tool-result',
    filterMode: 'default',
    foldedIds: new Set(),
  });
  t.false(compactRows.some((row) => row.text.includes('[read: package.json]')));
  t.false(compactRows.some((row) => row.id === 'tool-result'));

  const fullRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: getDefaultClaudeSessionLeafId(parsed.entries),
    selectedEntryId: 'tool-result',
    filterMode: 'full',
    foldedIds: new Set(),
  });
  t.true(fullRows.some((row) => row.text === '[read: package.json]'));
  t.true(fullRows.some((row) => row.id === 'tool-result' && row.text === '[read: package.json] result'));
});

test('buildClaudeSessionTreeRows preserves assistant markdown line breaks', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: null,
        timestamp: '2026-04-25T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first paragraph\n\nsecond paragraph' }],
        },
      },
    ]),
  );

  const rows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'a1',
    selectedEntryId: 'a1',
    filterMode: 'full',
    foldedIds: new Set(),
  });

  t.is(rows[0]?.text, 'assistant: first paragraph\n\nsecond paragraph');
});

test('buildClaudeSessionTreeRows renders Claude search tools by query', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'assistant',
        uuid: 'web-search',
        parentUuid: null,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'web-search-tool',
              name: 'WebSearch',
              input: { query: 'METR task suite AI agent time horizon benchmark', max_results: 10 },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'web-search-result',
        parentUuid: 'web-search',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'web-search-tool', content: 'results' }],
        },
      },
      {
        type: 'user',
        uuid: 'tool-search-text-result',
        parentUuid: 'web-search-result',
        message: {
          role: 'user',
          content: '[ToolSearch: {"query":"select:WebSearch,WebFetch","max_results":2}] result',
        },
      },
    ]),
  );

  const defaultRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'web-search-result',
    selectedEntryId: 'web-search-result',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });
  t.true(
    defaultRows.some((row) => row.text === '[WebSearch: METR task suite AI agent time horizon benchmark] success'),
  );

  const compactRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'web-search-result',
    selectedEntryId: 'web-search-result',
    filterMode: 'default',
    foldedIds: new Set(),
  });
  t.false(compactRows.some((row) => row.text.includes('WebSearch')));

  const fullRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'tool-search-text-result',
    selectedEntryId: 'tool-search-text-result',
    filterMode: 'full',
    foldedIds: new Set(),
  });
  t.true(fullRows.some((row) => row.text === '[ToolSearch: select:WebSearch,WebFetch] success'));
});

test('buildClaudeSessionTreeRows hides metadata in minimal mode', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      { type: 'summary', uuid: 'summary', parentUuid: null, summary: 'summary text' },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'summary',
        message: { role: 'user', content: 'user message' },
      },
    ]),
  );

  const rows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });

  t.deepEqual(
    rows.map((row) => row.id),
    ['u1'],
  );
});

test('Claude system reminder user messages render as neutral metadata', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'user',
        uuid: 'reminder',
        parentUuid: null,
        message: { role: 'user', content: '<system-reminder>Reminder text.</system-reminder>' },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'reminder',
        message: { role: 'user', content: 'user message' },
      },
    ]),
  );

  t.is(parsed.firstUserMessage, 'user message');

  const rows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'default',
    foldedIds: new Set(),
  });

  t.deepEqual(
    rows.map((row) => row.id),
    ['u1'],
  );

  const minimalRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });
  t.deepEqual(
    minimalRows.map((row) => row.id),
    ['u1'],
  );

  const fullRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'full',
    foldedIds: new Set(),
  });
  const reminderRow = fullRows.find((row) => row.id === 'reminder');
  t.truthy(reminderRow);
  t.is(reminderRow?.role, 'systemReminder');
  t.is(reminderRow?.text, '<system-reminder>Reminder text.</system-reminder>');
});

test('Claude default mode hides system directives and text tool calls', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'user',
        uuid: 'permission',
        parentUuid: null,
        message: { role: 'user', content: '[permission-mode] mode' },
      },
      {
        type: 'user',
        uuid: 'history',
        parentUuid: 'permission',
        message: { role: 'user', content: '[file-history-snapshot] file changed' },
      },
      {
        type: 'user',
        uuid: 'attachment',
        parentUuid: 'history',
        message: { role: 'user', content: '[attachment] file.png' },
      },
      {
        type: 'user',
        uuid: 'tool-search',
        parentUuid: 'attachment',
        message: { role: 'user', content: '[ToolSearch: {"query":"query"}]' },
      },
      {
        type: 'user',
        uuid: 'web-search',
        parentUuid: 'tool-search',
        message: { role: 'user', content: '[WebSearch: {"query":"query"}]' },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'web-search',
        message: { role: 'user', content: 'user message' },
      },
    ]),
  );

  const defaultRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'default',
    foldedIds: new Set(),
  });
  t.deepEqual(
    defaultRows.map((row) => row.id),
    ['u1'],
  );
  t.deepEqual(
    defaultRows.map((row) => row.role),
    ['user'],
  );

  const minimalRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });
  t.deepEqual(
    minimalRows.map((row) => row.id),
    ['u1'],
  );

  const fullRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'full',
    foldedIds: new Set(),
  });
  t.deepEqual(
    fullRows.map((row) => row.id),
    ['permission', 'history', 'attachment', 'tool-search', 'web-search', 'u1'],
  );
  t.is(fullRows[0]?.role, 'systemDirective');
});

test('Claude default mode hides local command caveats and empty assistant messages', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'user',
        uuid: 'caveat',
        parentUuid: null,
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat text.</local-command-caveat>',
        },
      },
      {
        type: 'assistant',
        uuid: 'empty-assistant',
        parentUuid: 'caveat',
        message: { role: 'assistant', content: [] },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'empty-assistant',
        message: { role: 'user', content: 'user message' },
      },
      {
        type: 'user',
        uuid: 'bracket-only',
        parentUuid: 'u1',
        message: { role: 'user', content: '[local-command]' },
      },
      {
        type: 'user',
        uuid: 'stdout',
        parentUuid: 'bracket-only',
        message: { role: 'user', content: '<local-command-stdout>command output</local-command-stdout>' },
      },
      {
        type: 'assistant',
        uuid: 'tool-use',
        parentUuid: 'stdout',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'package.json' } }],
        },
      },
    ]),
  );

  const defaultRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'tool-use',
    selectedEntryId: 'tool-use',
    filterMode: 'default',
    foldedIds: new Set(),
  });
  t.deepEqual(
    defaultRows.map((row) => row.id),
    ['u1'],
  );
  t.false(defaultRows.some((row) => row.text === '[read: package.json]'));

  const minimalRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'tool-use',
    selectedEntryId: 'tool-use',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });
  t.deepEqual(
    minimalRows.map((row) => row.id),
    ['u1', 'tool-use'],
  );

  const fullRows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'tool-use',
    selectedEntryId: 'tool-use',
    filterMode: 'full',
    foldedIds: new Set(),
  });
  t.deepEqual(
    fullRows.map((row) => row.id),
    ['caveat', 'empty-assistant', 'u1', 'bracket-only', 'stdout', 'tool-use'],
  );
  t.true(fullRows.some((row) => row.text === 'assistant: (no content)'));
});

test('Claude default mode hides raw bracket metadata transparently', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: 'session-1',
      },
      {
        type: 'file-history-snapshot',
        uuid: 'history',
        messageId: 'u1',
        snapshot: {},
      },
      {
        type: 'attachment',
        uuid: 'tools',
        parentUuid: 'history',
        attachment: { type: 'metadata', content: 'metadata content' },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'tools',
        message: { role: 'user', content: 'visible message' },
      },
    ]),
  );

  const rows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'u1',
    selectedEntryId: 'u1',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });

  t.deepEqual(
    rows.map((row) => row.id),
    ['u1'],
  );
});

test('Claude default mode inserts elision rows when hidden metadata contains visible branches', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'root message' },
      },
      {
        type: 'attachment',
        uuid: 'metadata-branch',
        parentUuid: 'u1',
        attachment: { type: 'deferred_tools_delta' },
      },
      {
        type: 'user',
        uuid: 'branch-a',
        parentUuid: 'metadata-branch',
        timestamp: '2026-04-25T10:00:00.000Z',
        message: { role: 'user', content: 'first branch' },
      },
      {
        type: 'user',
        uuid: 'branch-b',
        parentUuid: 'metadata-branch',
        timestamp: '2026-04-25T10:01:00.000Z',
        message: { role: 'user', content: 'second branch' },
      },
    ]),
  );

  const rows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'branch-b',
    selectedEntryId: 'branch-b',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });

  t.deepEqual(
    rows.map((row) => row.text),
    ['user: root message', 'hidden metadata', 'user: first branch', 'user: second branch'],
  );
  t.true(rows[1]?.isSynthetic);
  t.is(rows[1]?.role, 'elision');
  t.true(rows[1]?.isFoldable);
});

test('Claude default mode hides login retry scaffolding', (t) => {
  const parsed = parseClaudeSessionJsonl(
    jsonl([
      {
        type: 'user',
        uuid: 'first-prompt',
        parentUuid: null,
        message: { role: 'user', content: 'user request' },
      },
      {
        type: 'assistant',
        uuid: 'auth-error',
        parentUuid: 'first-prompt',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Please run /login - API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
            },
          ],
        },
        isApiErrorMessage: true,
        apiErrorStatus: 401,
      },
      {
        type: 'user',
        uuid: 'login-command',
        parentUuid: 'auth-error',
        message: {
          role: 'user',
          content:
            '<command-name>/command</command-name>\n<command-message>command</command-message>\n<command-args></command-args>',
        },
      },
      {
        type: 'user',
        uuid: 'login-stdout',
        parentUuid: 'login-command',
        message: { role: 'user', content: '<local-command-stdout>command output</local-command-stdout>' },
      },
      {
        type: 'user',
        uuid: 'retry-prompt',
        parentUuid: null,
        message: { role: 'user', content: 'user request' },
      },
      {
        type: 'assistant',
        uuid: 'answer',
        parentUuid: 'retry-prompt',
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant response' }] },
      },
    ]),
  );

  const rows = buildClaudeSessionTreeRows({
    entries: parsed.entries,
    currentLeafId: 'answer',
    selectedEntryId: 'answer',
    filterMode: 'minimal',
    foldedIds: new Set(),
  });

  t.deepEqual(
    rows.map((row) => row.id),
    ['retry-prompt', 'answer'],
  );
});
