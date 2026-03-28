import type { ReaderAiMessage } from './components/ReaderAiPanel';
import type { Route } from './routing';
import type { PublicRepoRef } from './wiki_links';

const READER_AI_HISTORY_KEY = 'reader_ai_history_v1';
const READER_AI_HISTORY_MAX_ENTRIES = 12;
const READER_AI_HISTORY_MAX_MESSAGES = 100;
const READER_AI_HISTORY_MAX_APPLIED_CHANGES = 100;

export interface ReaderAiHistoryEntry {
  messages: ReaderAiMessage[];
  summary?: string;
  scope?: { kind: 'document' } | { kind: 'selection'; source: string };
  toolLog?: Array<{ type: 'call' | 'result' | 'progress'; name: string; detail?: string; taskId?: string }>;
  stagedChanges?: Array<{ path: string; type: 'edit' | 'create' | 'delete'; diff: string }>;
  stagedChangesInvalid?: boolean;
  stagedFileContents?: Record<string, string>;
  appliedChanges?: Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>;
}

export interface ReaderAiHistoryStore {
  order: string[];
  entries: Record<string, ReaderAiHistoryEntry>;
}

export function buildReaderAiHistoryDocumentKey(options: {
  currentRepoDocPath: string | null;
  currentGistId: string | null;
  currentFileName: string | null;
  repoAccessMode: 'installed' | 'shared' | 'public' | null;
  selectedRepo: string | null;
  publicRepoRef: PublicRepoRef | null;
  route: Route;
}): string | null {
  const { currentRepoDocPath, currentGistId, currentFileName, repoAccessMode, selectedRepo, publicRepoRef, route } =
    options;

  if (currentGistId && currentFileName) {
    return `gist:${currentGistId}:${currentFileName}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'installed' && selectedRepo) {
    return `repo:${selectedRepo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'public' && publicRepoRef) {
    return `public:${publicRepoRef.owner.toLowerCase()}/${publicRepoRef.repo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'shared' && (route.name === 'repofile' || route.name === 'repoedit')) {
    return `shared:${route.params.owner.toLowerCase()}/${route.params.repo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (route.name === 'sharefile' && currentRepoDocPath) {
    return `share:${route.params.owner}/${route.params.repo}:${currentRepoDocPath}`;
  }
  if (route.name === 'sharetoken' && currentRepoDocPath) {
    return `share:${route.params.token}:${currentRepoDocPath}`;
  }
  return null;
}

function isReaderAiRole(value: unknown): value is ReaderAiMessage['role'] {
  return value === 'user' || value === 'assistant';
}

export function normalizeReaderAiMessages(value: unknown): ReaderAiMessage[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((item): ReaderAiMessage | null => {
      if (!item || typeof item !== 'object') return null;
      const role = (item as { role?: unknown }).role;
      const content = (item as { content?: unknown }).content;
      const edited = (item as { edited?: unknown }).edited;
      if (!isReaderAiRole(role) || typeof content !== 'string') return null;
      const message: ReaderAiMessage = { role, content };
      if (edited === true) message.edited = true;
      return message;
    })
    .filter((message): message is ReaderAiMessage => message !== null);
  return normalized.slice(-READER_AI_HISTORY_MAX_MESSAGES);
}

function normalizePersistedStagedChanges(value: unknown): {
  changes: NonNullable<ReaderAiHistoryEntry['stagedChanges']>;
  invalid: boolean;
} {
  if (value === undefined) return { changes: [], invalid: false };
  if (!Array.isArray(value)) return { changes: [], invalid: true };
  const changes: NonNullable<ReaderAiHistoryEntry['stagedChanges']> = [];
  let invalid = false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      invalid = true;
      continue;
    }
    const path = typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : '';
    const type = typeof (entry as { type?: unknown }).type === 'string' ? (entry as { type: string }).type : '';
    const diff = typeof (entry as { diff?: unknown }).diff === 'string' ? (entry as { diff: string }).diff : '';
    if (!path || (type !== 'edit' && type !== 'create' && type !== 'delete') || !diff) {
      invalid = true;
      continue;
    }
    changes.push({ path, type, diff });
  }
  return { changes, invalid };
}

function normalizePersistedAppliedChanges(value: unknown): NonNullable<ReaderAiHistoryEntry['appliedChanges']> {
  if (!Array.isArray(value)) return [];
  const applied: NonNullable<ReaderAiHistoryEntry['appliedChanges']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const path = typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : '';
    const type = typeof (entry as { type?: unknown }).type === 'string' ? (entry as { type: string }).type : '';
    const appliedAt =
      typeof (entry as { appliedAt?: unknown }).appliedAt === 'string'
        ? (entry as { appliedAt: string }).appliedAt
        : '';
    if (!path || (type !== 'edit' && type !== 'create' && type !== 'delete') || !appliedAt) continue;
    applied.push({ path, type, appliedAt });
  }
  if (applied.length <= READER_AI_HISTORY_MAX_APPLIED_CHANGES) return applied;
  return applied.slice(-READER_AI_HISTORY_MAX_APPLIED_CHANGES);
}

export function loadReaderAiHistoryStore(): ReaderAiHistoryStore {
  if (typeof window === 'undefined') return { order: [], entries: {} };
  try {
    const raw = localStorage.getItem(READER_AI_HISTORY_KEY);
    if (!raw) return { order: [], entries: {} };
    const parsed = JSON.parse(raw) as { order?: unknown; entries?: unknown };
    const rawEntries = parsed.entries;
    if (!rawEntries || typeof rawEntries !== 'object') return { order: [], entries: {} };
    const entries: Record<string, ReaderAiHistoryEntry> = {};
    for (const [key, value] of Object.entries(rawEntries)) {
      // Support both old format (ReaderAiMessage[]) and new format (ReaderAiHistoryEntry)
      if (Array.isArray(value)) {
        entries[key] = { messages: normalizeReaderAiMessages(value) };
      } else if (value && typeof value === 'object') {
        const entry = value as {
          messages?: unknown;
          summary?: unknown;
          scope?: unknown;
          toolLog?: unknown;
          stagedChanges?: unknown;
          stagedFileContents?: unknown;
          appliedChanges?: unknown;
        };
        const parsed: ReaderAiHistoryEntry = {
          messages: normalizeReaderAiMessages(entry.messages),
        };
        if (typeof entry.summary === 'string' && entry.summary) parsed.summary = entry.summary;
        if (entry.scope && typeof entry.scope === 'object') {
          const kind = (entry.scope as { kind?: unknown }).kind;
          const source = (entry.scope as { source?: unknown }).source;
          if (kind === 'document') {
            parsed.scope = { kind: 'document' };
          } else if (kind === 'selection' && typeof source === 'string' && source.length > 0) {
            parsed.scope = { kind: 'selection', source };
          }
        }
        if (Array.isArray(entry.toolLog) && entry.toolLog.length > 0)
          parsed.toolLog = entry.toolLog as ReaderAiHistoryEntry['toolLog'];
        const normalizedStagedChanges = normalizePersistedStagedChanges(entry.stagedChanges);
        if (normalizedStagedChanges.changes.length > 0) parsed.stagedChanges = normalizedStagedChanges.changes;
        if (normalizedStagedChanges.invalid) parsed.stagedChangesInvalid = true;
        if (entry.stagedFileContents && typeof entry.stagedFileContents === 'object') {
          const contents = Object.fromEntries(
            Object.entries(entry.stagedFileContents).filter(
              (item): item is [string, string] => typeof item[0] === 'string' && typeof item[1] === 'string',
            ),
          );
          if (Object.keys(contents).length > 0) parsed.stagedFileContents = contents;
        }
        const normalizedAppliedChanges = normalizePersistedAppliedChanges(entry.appliedChanges);
        if (normalizedAppliedChanges.length > 0) parsed.appliedChanges = normalizedAppliedChanges;
        entries[key] = parsed;
      }
    }
    const rawOrder = Array.isArray(parsed.order)
      ? parsed.order.filter((key): key is string => typeof key === 'string')
      : [];
    const order = rawOrder.filter((key, index) => index < READER_AI_HISTORY_MAX_ENTRIES && key in entries);
    for (const key of Object.keys(entries)) {
      if (!order.includes(key)) delete entries[key];
    }
    return { order, entries };
  } catch {
    return { order: [], entries: {} };
  }
}

export function loadReaderAiEntryFromHistory(historyKey: string): ReaderAiHistoryEntry {
  const store = loadReaderAiHistoryStore();
  const entry = store.entries[historyKey] ?? { messages: [] };
  return entry;
}

export function persistReaderAiMessagesToHistory(
  historyKey: string,
  messages: ReaderAiMessage[],
  summary?: string,
  scope?: ReaderAiHistoryEntry['scope'],
  toolLog?: Array<{ type: 'call' | 'result' | 'progress'; name: string; detail?: string }>,
  stagedChanges?: Array<{ path: string; type: 'edit' | 'create' | 'delete'; diff: string }>,
  stagedFileContents?: Record<string, string>,
  appliedChanges?: Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>,
): void {
  if (typeof window === 'undefined') return;
  const store = loadReaderAiHistoryStore();
  const nextEntries = { ...store.entries };
  const nextOrder = store.order.filter((key) => key !== historyKey);
  const normalizedMessages = normalizeReaderAiMessages(messages);
  if (normalizedMessages.length === 0) {
    return;
  }
  const entry: ReaderAiHistoryEntry = { messages: normalizedMessages };
  if (summary) entry.summary = summary;
  if (scope) entry.scope = scope;
  if (toolLog && toolLog.length > 0) entry.toolLog = toolLog;
  if (stagedChanges && stagedChanges.length > 0) entry.stagedChanges = stagedChanges;
  if (stagedFileContents && Object.keys(stagedFileContents).length > 0) entry.stagedFileContents = stagedFileContents;
  if (appliedChanges && appliedChanges.length > 0)
    entry.appliedChanges = appliedChanges.slice(-READER_AI_HISTORY_MAX_APPLIED_CHANGES);
  nextEntries[historyKey] = entry;
  nextOrder.unshift(historyKey);
  const trimmedOrder = nextOrder.slice(0, READER_AI_HISTORY_MAX_ENTRIES);
  for (const key of Object.keys(nextEntries)) {
    if (!trimmedOrder.includes(key)) delete nextEntries[key];
  }
  try {
    if (trimmedOrder.length === 0) {
      localStorage.removeItem(READER_AI_HISTORY_KEY);
      return;
    }
    localStorage.setItem(READER_AI_HISTORY_KEY, JSON.stringify({ order: trimmedOrder, entries: nextEntries }));
  } catch {
    return;
  }
}

export function clearReaderAiMessagesFromHistory(historyKey: string): void {
  if (typeof window === 'undefined') return;
  const store = loadReaderAiHistoryStore();
  if (!(historyKey in store.entries)) return;
  const nextEntries = { ...store.entries };
  delete nextEntries[historyKey];
  const trimmedOrder = store.order.filter((key) => key !== historyKey).slice(0, READER_AI_HISTORY_MAX_ENTRIES);
  for (const key of Object.keys(nextEntries)) {
    if (!trimmedOrder.includes(key)) delete nextEntries[key];
  }
  try {
    if (trimmedOrder.length === 0) {
      localStorage.removeItem(READER_AI_HISTORY_KEY);
      return;
    }
    localStorage.setItem(READER_AI_HISTORY_KEY, JSON.stringify({ order: trimmedOrder, entries: nextEntries }));
  } catch {
    return;
  }
}
