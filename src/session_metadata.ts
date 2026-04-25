import { isClaudeSessionPath, parseClaudeSessionJsonl } from './claude_session.ts';
import { isNotePath, parseNoteJsonl } from './notes.ts';
import { isPiSessionPath, normalizePiSessionText, parsePiSessionJsonl } from './pi_session.ts';

export interface SessionCardMetadata {
  agentName: string;
  firstUserMessage: string | null;
  lastMessageDate: Date | null;
}

const FIRST_MESSAGE_MAX_LINES = 75;
const LAST_MESSAGE_MAX_LINES = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonlHeadLines(content: string, maxLines: number): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index <= content.length && lines.length < maxLines; index += 1) {
    const char = content[index];
    if (index !== content.length && char !== '\n') continue;
    let lineEnd = index;
    if (lineEnd > lineStart && content[lineEnd - 1] === '\r') lineEnd -= 1;
    lines.push(content.slice(lineStart, lineEnd));
    lineStart = index + 1;
  }
  return lines;
}

function jsonlTailLines(content: string, maxLines: number): string[] {
  const lines: string[] = [];
  let lineEnd = content.length;
  if (lineEnd > 0 && content[lineEnd - 1] === '\n') lineEnd -= 1;
  while (lineEnd >= 0 && lines.length < maxLines) {
    const newlineIndex = content.lastIndexOf('\n', lineEnd - 1);
    const lineStart = newlineIndex < 0 ? 0 : newlineIndex + 1;
    let currentLineEnd = lineEnd;
    if (currentLineEnd > lineStart && content[currentLineEnd - 1] === '\r') currentLineEnd -= 1;
    lines.push(content.slice(lineStart, currentLineEnd));
    if (newlineIndex < 0) break;
    lineEnd = newlineIndex;
  }
  return lines;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let result = '';
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      result += block.text;
    }
  }
  return result;
}

function extractUserMessage(entry: Record<string, unknown>): string | null {
  const message = isRecord(entry.message) ? entry.message : entry;
  if (message.role !== 'user' && entry.type !== 'user') return null;
  const content =
    extractTextContent(message.content) ||
    extractTextContent(entry.content) ||
    (typeof entry.text === 'string' ? entry.text : '') ||
    (typeof message.text === 'string' ? message.text : '');
  const normalized = normalizePiSessionText(content);
  return normalized || null;
}

function extractTimestampValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== 'string') return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function extractEntryTimestamp(entry: Record<string, unknown>): number | null {
  const message = isRecord(entry.message) ? entry.message : null;
  return (
    extractTimestampValue(message?.timestamp) ??
    extractTimestampValue(entry.timestamp) ??
    extractTimestampValue(entry.createdAt) ??
    extractTimestampValue(entry.created_at) ??
    extractTimestampValue(entry.updatedAt) ??
    extractTimestampValue(entry.updated_at)
  );
}

function isConversationMessage(entry: Record<string, unknown>): boolean {
  const message = isRecord(entry.message) ? entry.message : entry;
  return message.role === 'user' || message.role === 'assistant' || entry.type === 'user' || entry.type === 'assistant';
}

function extractGenericFirstUserMessage(content: string): string | null {
  for (const line of jsonlHeadLines(content, FIRST_MESSAGE_MAX_LINES)) {
    const entry = parseJsonLine(line);
    if (!entry) continue;
    const userMessage = extractUserMessage(entry);
    if (userMessage) return userMessage;
  }
  return null;
}

function extractLatestMessageDate(content: string): Date | null {
  for (const line of jsonlTailLines(content, LAST_MESSAGE_MAX_LINES)) {
    const entry = parseJsonLine(line);
    if (!entry || !isConversationMessage(entry)) continue;
    const timestamp = extractEntryTimestamp(entry);
    if (timestamp !== null) return new Date(timestamp);
  }
  return null;
}

export function sessionAgentName(path: string): string {
  if (isNotePath(path)) return 'Note';
  if (isPiSessionPath(path)) return 'Pi';
  if (isClaudeSessionPath(path)) return 'Claude';
  return 'Session';
}

export function parseSessionCardMetadata(path: string, content: string): SessionCardMetadata {
  const piLightParse = isPiSessionPath(path) ? parsePiSessionJsonl(content, { light: true }) : null;
  const claudeLightParse = isClaudeSessionPath(path) ? parseClaudeSessionJsonl(content, { light: true }) : null;
  const note = isNotePath(path) ? parseNoteJsonl(content) : null;
  const noteDate = note?.createdAt ? new Date(note.createdAt) : null;
  return {
    agentName: sessionAgentName(path),
    firstUserMessage:
      note?.text ??
      piLightParse?.firstUserMessage ??
      claudeLightParse?.firstUserMessage ??
      extractGenericFirstUserMessage(content),
    lastMessageDate: noteDate && Number.isFinite(noteDate.getTime()) ? noteDate : extractLatestMessageDate(content),
  };
}

export function formatSessionCardDateTitle(date: Date | null): string {
  if (!date) return 'Unknown date';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay = sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(undefined, {
    month: sameDay ? undefined : 'short',
    day: sameDay ? undefined : 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatSessionCardDate(date: Date | null, now: Date = new Date()): string {
  if (!date) return 'Unknown date';
  const elapsedMs = now.getTime() - date.getTime();
  if (elapsedMs >= 0 && elapsedMs < 24 * 60 * 60 * 1000) {
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
    if (elapsedMinutes < 1) return 'just now';
    if (elapsedMinutes < 60) return `${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'} ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    return `${elapsedHours} hour${elapsedHours === 1 ? '' : 's'} ago`;
  }
  return formatSessionCardDateTitle(date);
}
