export const PERSISTED_HOME_SYNC_SCRIPT_FILENAME = '.input-persisted-home-sync.cjs';
export const PERSISTED_HOME_SEED_FILENAME = '.input-persisted-home-seed.json';

const PERSISTED_HOME_DB_NAME = 'input_persisted_home_v1';
const PERSISTED_HOME_DB_VERSION = 1;
const PERSISTED_HOME_ENTRY_STORE = 'entries';
const PERSISTED_HOME_WORKSPACE_INDEX = 'byWorkspaceKey';
const PERSISTED_HOME_SCAN_INTERVAL_MS = 500;

export interface PersistedHomeTarget {
  id: string;
  kind: 'file' | 'directory';
  homePath: string;
}

export interface PersistedHomeEntry {
  path: string;
  content: string;
}

interface PersistedHomeSeedSnapshot {
  version: 1;
  entries: PersistedHomeEntry[];
}

interface PersistedHomeRecord {
  workspaceKey: string;
  homePath: string;
  content: string;
  updatedAt: number;
}

export const PERSISTED_HOME_TARGETS: readonly PersistedHomeTarget[] = [
  { id: 'jsh-history', kind: 'file', homePath: '.jsh_history' },
  { id: 'claude-config', kind: 'file', homePath: '.claude.json' },
  { id: 'claude-sessions', kind: 'directory', homePath: '.claude/sessions' },
];

function normalizeWorkspaceKey(workspaceKey: string): string | null {
  const key = workspaceKey.trim();
  if (!key || key === 'workspace:none') return null;
  return key;
}

export function normalizePersistedHomePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('Persisted home path must not be empty.');
  }
  if (trimmed.startsWith('/')) {
    throw new Error(`Persisted home path must be relative to $HOME: ${path}`);
  }
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Persisted home path must not be empty.');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Persisted home path must stay inside $HOME: ${path}`);
  }
  return segments.join('/');
}

function isPersistedHomePathManaged(
  homePath: string,
  targets: readonly PersistedHomeTarget[] = PERSISTED_HOME_TARGETS,
): boolean {
  return targets.some((target) => {
    if (target.kind === 'file') return homePath === target.homePath;
    return homePath.startsWith(`${target.homePath}/`);
  });
}

function normalizePersistedHomeTargets(targets: readonly PersistedHomeTarget[]): PersistedHomeTarget[] {
  const seenPaths = new Set<string>();
  const normalized = targets.map((target) => {
    const homePath = normalizePersistedHomePath(target.homePath);
    const nextTarget: PersistedHomeTarget = {
      id: target.id.trim(),
      kind: target.kind,
      homePath,
    };
    if (!nextTarget.id) {
      throw new Error('Persisted home target id must not be empty.');
    }
    if (seenPaths.has(homePath)) {
      throw new Error(`Duplicate persisted home target path: ${homePath}`);
    }
    seenPaths.add(homePath);
    return nextTarget;
  });

  for (const target of normalized) {
    if (target.kind !== 'directory') continue;
    for (const otherTarget of normalized) {
      if (target === otherTarget) continue;
      if (otherTarget.homePath.startsWith(`${target.homePath}/`)) {
        throw new Error(`Persisted home target overlaps managed directory: ${otherTarget.homePath}`);
      }
    }
  }

  return normalized;
}

function normalizePersistedHomeEntries(
  entries: readonly PersistedHomeEntry[],
  targets: readonly PersistedHomeTarget[] = PERSISTED_HOME_TARGETS,
): PersistedHomeEntry[] {
  const normalizedByPath = new Map<string, string>();
  for (const entry of entries) {
    const path = normalizePersistedHomePath(entry.path);
    if (!isPersistedHomePathManaged(path, targets)) continue;
    normalizedByPath.set(path, typeof entry.content === 'string' ? entry.content : String(entry.content));
  }
  return [...normalizedByPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ path, content }));
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed.')));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.')),
    );
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.')),
    );
  });
}

async function openPersistedHomeDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null;
  const request = window.indexedDB.open(PERSISTED_HOME_DB_NAME, PERSISTED_HOME_DB_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const database = request.result;
    const store = database.objectStoreNames.contains(PERSISTED_HOME_ENTRY_STORE)
      ? request.transaction?.objectStore(PERSISTED_HOME_ENTRY_STORE)
      : database.createObjectStore(PERSISTED_HOME_ENTRY_STORE, { keyPath: ['workspaceKey', 'homePath'] });
    if (store && !store.indexNames.contains(PERSISTED_HOME_WORKSPACE_INDEX)) {
      store.createIndex(PERSISTED_HOME_WORKSPACE_INDEX, 'workspaceKey', { unique: false });
    }
  });
  return await runRequest(request);
}

export async function loadPersistedHomeEntries(workspaceKey: string): Promise<PersistedHomeEntry[]> {
  const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
  if (!normalizedWorkspaceKey) return [];
  const database = await openPersistedHomeDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(PERSISTED_HOME_ENTRY_STORE, 'readonly');
    const store = transaction.objectStore(PERSISTED_HOME_ENTRY_STORE);
    const index = store.index(PERSISTED_HOME_WORKSPACE_INDEX);
    const records = await runRequest(index.getAll(IDBKeyRange.only(normalizedWorkspaceKey)));
    await waitForTransaction(transaction);
    return (records as PersistedHomeRecord[])
      .map((record) => ({ path: record.homePath, content: record.content }))
      .sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    database.close();
  }
}

export async function persistPersistedHomeEntries(
  workspaceKey: string,
  entries: readonly PersistedHomeEntry[],
): Promise<void> {
  const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
  if (!normalizedWorkspaceKey) return;
  const database = await openPersistedHomeDatabase();
  if (!database) return;
  const normalizedEntries = normalizePersistedHomeEntries(entries);
  const updatedAt = Date.now();

  try {
    const transaction = database.transaction(PERSISTED_HOME_ENTRY_STORE, 'readwrite');
    const store = transaction.objectStore(PERSISTED_HOME_ENTRY_STORE);
    const index = store.index(PERSISTED_HOME_WORKSPACE_INDEX);
    const keyCursorRequest = index.openKeyCursor(IDBKeyRange.only(normalizedWorkspaceKey));
    await new Promise<void>((resolve, reject) => {
      keyCursorRequest.addEventListener('success', () => {
        const cursor = keyCursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
      });
      keyCursorRequest.addEventListener('error', () => {
        reject(keyCursorRequest.error ?? new Error('IndexedDB cursor request failed.'));
      });
    });

    for (const entry of normalizedEntries) {
      store.put({
        workspaceKey: normalizedWorkspaceKey,
        homePath: entry.path,
        content: entry.content,
        updatedAt,
      } satisfies PersistedHomeRecord);
    }

    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export function buildPersistedHomeSeed(entries: readonly PersistedHomeEntry[]): string {
  const snapshot: PersistedHomeSeedSnapshot = {
    version: 1,
    entries: normalizePersistedHomeEntries(entries),
  };
  return JSON.stringify(snapshot);
}

export function buildPersistedHomeSyncScript(
  seedPath: string,
  targets: readonly PersistedHomeTarget[] = PERSISTED_HOME_TARGETS,
): string {
  const normalizedTargets = normalizePersistedHomeTargets(targets);
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const mode = process.argv[2] || '';",
    `const seedPath = ${JSON.stringify(seedPath)};`,
    `const targets = ${JSON.stringify(normalizedTargets)};`,
    `const scanIntervalMs = ${PERSISTED_HOME_SCAN_INTERVAL_MS};`,
    "const home = process.env.HOME || '';",
    "if (!home) throw new Error('HOME is not set');",
    'function normalizePath(rawPath) {',
    '  const trimmed = String(rawPath || "").trim();',
    "  if (!trimmed) throw new Error('Persisted home path must not be empty.');",
    "  if (trimmed.startsWith('/')) throw new Error('Persisted home path must be relative to $HOME: ' + rawPath);",
    "  const segments = trimmed.split('/').filter(Boolean);",
    "  if (segments.length === 0) throw new Error('Persisted home path must not be empty.');",
    "  if (segments.some((segment) => segment === '.' || segment === '..')) {",
    "    throw new Error('Persisted home path must stay inside $HOME: ' + rawPath);",
    '  }',
    "  return segments.join('/');",
    '}',
    'function isManagedPath(relativePath) {',
    '  return targets.some((target) => {',
    "    if (target.kind === 'file') return relativePath === target.homePath;",
    "    return relativePath.startsWith(target.homePath + '/');",
    '  });',
    '}',
    'function sortEntries(entries) {',
    '  entries.sort((left, right) => left.path.localeCompare(right.path));',
    '  return entries;',
    '}',
    'function readSeedEntries() {',
    '  try {',
    "    const raw = fs.readFileSync(seedPath, 'utf8');",
    '    const parsed = JSON.parse(raw);',
    '    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];',
    '    const entriesByPath = new Map();',
    '    for (const entry of parsed.entries) {',
    "      if (!entry || typeof entry.path !== 'string' || typeof entry.content !== 'string') continue;",
    '      const relativePath = normalizePath(entry.path);',
    '      if (!isManagedPath(relativePath)) continue;',
    '      entriesByPath.set(relativePath, entry.content);',
    '    }',
    '    return sortEntries(Array.from(entriesByPath, ([path, content]) => ({ path, content })));',
    '  } catch {',
    '    return [];',
    '  }',
    '}',
    'function collectDirectoryEntries(directoryPath, relativePrefix, entries) {',
    '  let dirEntries = [];',
    '  try {',
    '    dirEntries = fs.readdirSync(directoryPath, { withFileTypes: true });',
    '  } catch {',
    '    return;',
    '  }',
    '  dirEntries.sort((left, right) => left.name.localeCompare(right.name));',
    '  for (const entry of dirEntries) {',
    '    const absoluteChildPath = path.join(directoryPath, entry.name);',
    "    const relativeChildPath = relativePrefix ? relativePrefix + '/' + entry.name : entry.name;",
    '    if (entry.isDirectory()) {',
    '      collectDirectoryEntries(absoluteChildPath, relativeChildPath, entries);',
    '      continue;',
    '    }',
    '    if (!entry.isFile()) continue;',
    "    entries.push({ path: normalizePath(relativeChildPath), content: fs.readFileSync(absoluteChildPath, 'utf8') });",
    '  }',
    '}',
    'function collectEntries() {',
    '  const entries = [];',
    '  for (const target of targets) {',
    '    const targetPath = path.join(home, target.homePath);',
    "    if (target.kind === 'file') {",
    '      try {',
    '        if (!fs.statSync(targetPath).isFile()) continue;',
    "        entries.push({ path: target.homePath, content: fs.readFileSync(targetPath, 'utf8') });",
    '      } catch {}',
    '      continue;',
    '    }',
    '    collectDirectoryEntries(targetPath, target.homePath, entries);',
    '  }',
    '  return sortEntries(entries);',
    '}',
    'function emitSnapshot(entries) {',
    "  process.stdout.write(JSON.stringify({ type: 'snapshot', entries }) + '\\n');",
    '}',
    'function restoreEntries(entries) {',
    '  for (const target of targets) {',
    '    try {',
    '      fs.rmSync(path.join(home, target.homePath), { force: true, recursive: true });',
    '    } catch {}',
    '  }',
    '  for (const entry of entries) {',
    '    const absolutePath = path.join(home, entry.path);',
    '    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });',
    "    fs.writeFileSync(absolutePath, entry.content, 'utf8');",
    '  }',
    '}',
    "if (mode === 'restore') {",
    '  restoreEntries(readSeedEntries());',
    '  process.exit(0);',
    "} else if (mode === 'snapshot') {",
    '  emitSnapshot(collectEntries());',
    '  process.exit(0);',
    "} else if (mode === 'watch') {",
    '  let lastSerialized = null;',
    '  const emitIfChanged = () => {',
    '    const entries = collectEntries();',
    '    const serialized = JSON.stringify(entries);',
    '    if (serialized === lastSerialized) return;',
    '    lastSerialized = serialized;',
    '    emitSnapshot(entries);',
    '  };',
    '  emitIfChanged();',
    '  const intervalId = setInterval(emitIfChanged, scanIntervalMs);',
    '  const shutdown = () => {',
    '    try {',
    '      emitIfChanged();',
    '    } catch {}',
    '    clearInterval(intervalId);',
    '    process.exit(0);',
    '  };',
    "  process.on('SIGINT', shutdown);",
    "  process.on('SIGTERM', shutdown);",
    "  process.on('exit', () => clearInterval(intervalId));",
    '} else {',
    "  throw new Error('Unknown persisted home mode: ' + mode);",
    '}',
  ].join(' ');
}
