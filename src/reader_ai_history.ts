import type { ReaderAiMessage } from './components/ReaderAiPanel';
import type { ReaderAiEditProposal, ReaderAiStagedChange, ReaderAiStagedHunk } from './reader_ai';
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
  toolLog?: Array<{
    type: 'call' | 'result' | 'progress';
    id?: string;
    name: string;
    detail?: string;
    taskId?: string;
  }>;
  editProposals?: ReaderAiEditProposal[];
  stagedChanges?: ReaderAiStagedChange[];
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
    const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : undefined;
    const revision =
      typeof (entry as { revision?: unknown }).revision === 'number'
        ? (entry as { revision: number }).revision
        : undefined;
    const originalContent =
      (entry as { originalContent?: unknown }).originalContent === null ||
      typeof (entry as { originalContent?: unknown }).originalContent === 'string'
        ? ((entry as { originalContent?: string | null }).originalContent ?? undefined)
        : undefined;
    const modifiedContent =
      (entry as { modifiedContent?: unknown }).modifiedContent === null ||
      typeof (entry as { modifiedContent?: unknown }).modifiedContent === 'string'
        ? ((entry as { modifiedContent?: string | null }).modifiedContent ?? undefined)
        : undefined;
    const hunksRaw = (entry as { hunks?: unknown }).hunks;
    if (!path || (type !== 'edit' && type !== 'create' && type !== 'delete') || !diff) {
      invalid = true;
      continue;
    }
    const hunks = Array.isArray(hunksRaw)
      ? hunksRaw
          .map((hunk): ReaderAiStagedHunk | null => {
            if (!hunk || typeof hunk !== 'object') return null;
            const header =
              typeof (hunk as { header?: unknown }).header === 'string' ? (hunk as { header: string }).header : '';
            const hunkId = typeof (hunk as { id?: unknown }).id === 'string' ? (hunk as { id: string }).id : '';
            const oldStart =
              typeof (hunk as { oldStart?: unknown }).oldStart === 'number'
                ? (hunk as { oldStart: number }).oldStart
                : NaN;
            const oldLines =
              typeof (hunk as { oldLines?: unknown }).oldLines === 'number'
                ? (hunk as { oldLines: number }).oldLines
                : NaN;
            const newStart =
              typeof (hunk as { newStart?: unknown }).newStart === 'number'
                ? (hunk as { newStart: number }).newStart
                : NaN;
            const newLines =
              typeof (hunk as { newLines?: unknown }).newLines === 'number'
                ? (hunk as { newLines: number }).newLines
                : NaN;
            const linesRaw = (hunk as { lines?: unknown }).lines;
            if (
              !hunkId ||
              !header ||
              !Number.isFinite(oldStart) ||
              !Number.isFinite(oldLines) ||
              !Number.isFinite(newStart) ||
              !Number.isFinite(newLines) ||
              !Array.isArray(linesRaw)
            ) {
              return null;
            }
            const lines = linesRaw
              .map((line) => {
                if (!line || typeof line !== 'object') return null;
                const lineType = (line as { type?: unknown }).type;
                const contentValue = (line as { content?: unknown }).content;
                if (
                  (lineType !== 'context' && lineType !== 'add' && lineType !== 'del') ||
                  typeof contentValue !== 'string'
                ) {
                  return null;
                }
                return { type: lineType, content: contentValue } as const;
              })
              .filter((line): line is NonNullable<typeof line> => line !== null);
            if (lines.length === 0) return null;
            return { id: hunkId, header, oldStart, oldLines, newStart, newLines, lines };
          })
          .filter((hunk): hunk is NonNullable<typeof hunk> => hunk !== null)
      : undefined;
    changes.push({
      ...(id ? { id } : {}),
      path,
      type,
      diff,
      ...(typeof revision === 'number' ? { revision } : {}),
      ...(originalContent !== undefined ? { originalContent } : {}),
      ...(modifiedContent !== undefined ? { modifiedContent } : {}),
      ...(hunks && hunks.length > 0 ? { hunks } : {}),
    });
  }
  return { changes, invalid };
}

function normalizePersistedEditProposals(value: unknown): ReaderAiEditProposal[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ReaderAiEditProposal | null => {
      if (!entry || typeof entry !== 'object') return null;
      const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : '';
      const toolCallId =
        typeof (entry as { toolCallId?: unknown }).toolCallId === 'string'
          ? (entry as { toolCallId: string }).toolCallId
          : undefined;
      const statusRaw = (entry as { status?: unknown }).status;
      const status = statusRaw === 'accepted' || statusRaw === 'rejected' ? statusRaw : undefined;
      const selectedHunkIdsRaw = (entry as { selectedHunkIds?: unknown }).selectedHunkIds;
      const selectedHunkIds = Array.isArray(selectedHunkIdsRaw)
        ? selectedHunkIdsRaw.filter((value): value is string => typeof value === 'string')
        : undefined;
      const normalizedChange = normalizePersistedStagedChanges([(entry as { change?: unknown }).change]).changes[0];
      if (!id || !normalizedChange) return null;
      return {
        id,
        ...(toolCallId ? { toolCallId } : {}),
        change: normalizedChange,
        ...(status ? { status } : {}),
        ...(selectedHunkIds ? { selectedHunkIds } : {}),
      };
    })
    .filter((proposal): proposal is ReaderAiEditProposal => proposal !== null);
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
          parsed.toolLog = (entry.toolLog as Array<Record<string, unknown>>)
            .map((toolEntry): NonNullable<ReaderAiHistoryEntry['toolLog']>[number] | null => {
              const type = toolEntry.type;
              const name = toolEntry.name;
              if (
                (type !== 'call' && type !== 'result' && type !== 'progress') ||
                typeof name !== 'string' ||
                !name.trim()
              ) {
                return null;
              }
              return {
                type,
                name,
                id: typeof toolEntry.id === 'string' ? toolEntry.id : undefined,
                detail: typeof toolEntry.detail === 'string' ? toolEntry.detail : undefined,
                taskId: typeof toolEntry.taskId === 'string' ? toolEntry.taskId : undefined,
              };
            })
            .filter(
              (toolEntry): toolEntry is NonNullable<ReaderAiHistoryEntry['toolLog']>[number] => toolEntry !== null,
            );
        const editProposals = normalizePersistedEditProposals((entry as { editProposals?: unknown }).editProposals);
        if (editProposals.length > 0) parsed.editProposals = editProposals;
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
  toolLog?: Array<{
    type: 'call' | 'result' | 'progress';
    id?: string;
    name: string;
    detail?: string;
    taskId?: string;
  }>,
  editProposals?: ReaderAiEditProposal[],
  stagedChanges?: ReaderAiStagedChange[],
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
  if (editProposals && editProposals.length > 0) entry.editProposals = editProposals;
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
