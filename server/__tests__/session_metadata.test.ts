import test from 'ava';
import { createNoteJsonl } from '../../src/notes.ts';
import {
  formatSessionCardDate,
  formatSessionCardDateTitle,
  parseSessionCardMetadata,
  sessionAgentName,
} from '../../src/session_metadata.ts';

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

test('parseSessionCardMetadata extracts Pi first user message and latest message date', (t) => {
  const metadata = parseSessionCardMetadata(
    '.input/.pi/agent/sessions/project/session.jsonl',
    jsonl([
      { type: 'session', id: 's1', version: 3 },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-04-25T10:00:00.000Z',
        message: { role: 'user', content: 'first message' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-04-25T10:03:00.000Z',
        message: { role: 'assistant', content: 'assistant message' },
      },
    ]),
  );

  t.is(metadata.agentName, 'Pi');
  t.is(metadata.firstUserMessage, 'first message');
  t.is(metadata.lastMessageDate?.toISOString(), '2026-04-25T10:03:00.000Z');
});

test('parseSessionCardMetadata extracts Claude-style first user message and latest message date', (t) => {
  const metadata = parseSessionCardMetadata(
    '.input/.claude/projects/project/session.jsonl',
    jsonl([
      { type: 'summary', summary: 'summary text', timestamp: '2026-04-25T09:00:00.000Z' },
      {
        type: 'user',
        timestamp: '2026-04-25T09:01:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'first message' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-25T09:05:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'assistant message' }] },
      },
    ]),
  );

  t.is(metadata.agentName, 'Claude');
  t.is(metadata.firstUserMessage, 'first message');
  t.is(metadata.lastMessageDate?.toISOString(), '2026-04-25T09:05:00.000Z');
});

test('sessionAgentName falls back for unknown session paths', (t) => {
  t.is(sessionAgentName('other/session.jsonl'), 'Session');
});

test('parseSessionCardMetadata extracts note text and created date', (t) => {
  const metadata = parseSessionCardMetadata(
    '.input/.notes/2026-04-26T12-00-00-000Z_note.jsonl',
    createNoteJsonl('# Note title\n\nNote body', new Date('2026-04-26T12:00:00.000Z')),
  );

  t.is(metadata.agentName, 'Note');
  t.is(metadata.firstUserMessage, '# Note title\n\nNote body');
  t.is(metadata.lastMessageDate?.toISOString(), '2026-04-26T12:00:00.000Z');
});

test('formatSessionCardDate uses relative labels for sessions less than 24 hours old', (t) => {
  const now = new Date('2026-04-26T12:00:00.000Z');

  t.is(formatSessionCardDate(new Date('2026-04-26T11:59:45.000Z'), now), 'just now');
  t.is(formatSessionCardDate(new Date('2026-04-26T11:59:00.000Z'), now), '1 minute ago');
  t.is(formatSessionCardDate(new Date('2026-04-26T11:15:00.000Z'), now), '45 minutes ago');
  t.is(formatSessionCardDate(new Date('2026-04-26T10:00:00.000Z'), now), '2 hours ago');
});

test('formatSessionCardDateTitle keeps the absolute session date label', (t) => {
  t.not(formatSessionCardDateTitle(new Date('2026-04-26T11:59:00.000Z')), '1 minute ago');
});
