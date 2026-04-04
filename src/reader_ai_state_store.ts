import {
  clearReaderAiHistoryEntry,
  persistReaderAiHistoryEntry,
  type ReaderAiHistoryEntry,
} from './reader_ai_history_store';

const READER_AI_PERSIST_DEBOUNCE_MS = 250;

const pendingEntries = new Map<string, ReaderAiHistoryEntry>();
const persistTimeouts = new Map<string, number>();

export function schedulePersistReaderAiHistoryEntry(historyKey: string, entry: ReaderAiHistoryEntry): void {
  pendingEntries.set(historyKey, entry);
  const existingTimeout = persistTimeouts.get(historyKey);
  if (existingTimeout !== undefined) window.clearTimeout(existingTimeout);
  const timeoutId = window.setTimeout(() => {
    persistTimeouts.delete(historyKey);
    const pendingEntry = pendingEntries.get(historyKey);
    if (!pendingEntry) return;
    pendingEntries.delete(historyKey);
    persistReaderAiHistoryEntry(historyKey, pendingEntry);
  }, READER_AI_PERSIST_DEBOUNCE_MS);
  persistTimeouts.set(historyKey, timeoutId);
}

export function flushPersistedReaderAiHistoryEntry(historyKey: string): void {
  const existingTimeout = persistTimeouts.get(historyKey);
  if (existingTimeout !== undefined) {
    window.clearTimeout(existingTimeout);
    persistTimeouts.delete(historyKey);
  }
  const pendingEntry = pendingEntries.get(historyKey);
  if (!pendingEntry) return;
  pendingEntries.delete(historyKey);
  persistReaderAiHistoryEntry(historyKey, pendingEntry);
}

export function clearPersistedReaderAiHistoryEntry(historyKey: string): void {
  const existingTimeout = persistTimeouts.get(historyKey);
  if (existingTimeout !== undefined) {
    window.clearTimeout(existingTimeout);
    persistTimeouts.delete(historyKey);
  }
  pendingEntries.delete(historyKey);
  clearReaderAiHistoryEntry(historyKey);
}
