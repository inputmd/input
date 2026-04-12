export const PERSISTED_HOME_SYNC_SCRIPT_FILENAME = '.input-persisted-home-sync.cjs';
export const PERSISTED_HOME_SEED_FILENAME = '.input-persisted-home-seed.json';

const PERSISTED_HOME_DB_NAME = 'input_persisted_home_v1';
const PERSISTED_HOME_DB_VERSION = 2;
const PERSISTED_HOME_ENTRY_STORE = 'entries';
const PERSISTED_HOME_WORKSPACE_INDEX = 'byWorkspaceKey';
const PERSISTED_HOME_SCAN_INTERVAL_MS = 500;
const PERSISTED_HOME_GLOBAL_WORKSPACE_KEY = '__global__';

export type PersistedHomeScope = 'global' | 'workspace';

export interface PersistedHomeTarget {
  id: string;
  kind: 'file' | 'directory';
  homePath: string;
  scope?: PersistedHomeScope;
}

export interface PersistedHomeEntry {
  path: string;
  content: string;
  mtime: number | null;
}

export interface PersistedHomeInspectionSnapshot {
  normalizedWorkspaceKey: string | null;
  globalEntries: PersistedHomeEntry[];
  workspaceEntries: PersistedHomeEntry[];
  effectiveEntries: PersistedHomeEntry[];
}

interface PersistedHomeSeedSnapshot {
  version: 2;
  entries: PersistedHomeEntry[];
}

interface PersistedHomeRecord {
  workspaceKey: string;
  homePath: string;
  content: string;
  mtime: number | null;
  updatedAt: number;
}

export const PERSISTED_HOME_TARGETS: readonly PersistedHomeTarget[] = [
  { id: 'jsh-history', kind: 'file', homePath: '.jsh_history' },
  { id: 'claude-config-dir-config', kind: 'file', homePath: '.claude/.config.json', scope: 'global' },
  { id: 'claude-cache', kind: 'directory', homePath: '.claude/cache' },
  { id: 'claude-credentials', kind: 'file', homePath: '.claude/.credentials.json', scope: 'global' },
  { id: 'claude-config', kind: 'file', homePath: '.claude.json', scope: 'global' },
  { id: 'claude-projects', kind: 'directory', homePath: '.claude/projects' },
  { id: 'claude-sessions', kind: 'directory', homePath: '.claude/sessions' },
  { id: 'pi-auth', kind: 'file', homePath: '.pi/agent/auth.json' },
  { id: 'pi-bin', kind: 'directory', homePath: '.pi/agent/bin' },
  { id: 'pi-extensions', kind: 'directory', homePath: '.pi/agent/extensions' },
  { id: 'pi-keybindings', kind: 'file', homePath: '.pi/agent/keybindings.json' },
  { id: 'pi-models', kind: 'file', homePath: '.pi/agent/models.json' },
  { id: 'pi-prompts', kind: 'directory', homePath: '.pi/agent/prompts' },
  { id: 'pi-settings', kind: 'file', homePath: '.pi/agent/settings.json', scope: 'global' },
  { id: 'pi-sessions', kind: 'directory', homePath: '.pi/agent/sessions' },
  { id: 'pi-themes', kind: 'directory', homePath: '.pi/agent/themes' },
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
  return resolvePersistedHomeTargetForPath(homePath, targets) !== null;
}

function normalizePersistedHomeTargets(targets: readonly PersistedHomeTarget[]): PersistedHomeTarget[] {
  const seenPaths = new Set<string>();
  const normalized = targets.map((target) => {
    const homePath = normalizePersistedHomePath(target.homePath);
    const nextTarget: PersistedHomeTarget = {
      id: target.id.trim(),
      kind: target.kind,
      homePath,
      scope: target.scope === 'global' ? 'global' : 'workspace',
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

function isPersistedHomeTargetMatch(homePath: string, target: PersistedHomeTarget): boolean {
  if (target.kind === 'file') return homePath === target.homePath;
  return homePath.startsWith(`${target.homePath}/`);
}

function resolvePersistedHomeTargetForPath(
  homePath: string,
  targets: readonly PersistedHomeTarget[] = PERSISTED_HOME_TARGETS,
): PersistedHomeTarget | null {
  const normalizedPath = normalizePersistedHomePath(homePath);
  const normalizedTargets = normalizePersistedHomeTargets(targets);
  return normalizedTargets.find((target) => isPersistedHomeTargetMatch(normalizedPath, target)) ?? null;
}

export function resolvePersistedHomeScopeForPath(
  homePath: string,
  targets: readonly PersistedHomeTarget[] = PERSISTED_HOME_TARGETS,
): PersistedHomeScope | null {
  const target = resolvePersistedHomeTargetForPath(homePath, targets);
  return target?.scope ?? null;
}

function normalizePersistedHomeMtime(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function normalizePersistedHomeEntries(
  entries: readonly PersistedHomeEntry[],
  targets: readonly PersistedHomeTarget[] = PERSISTED_HOME_TARGETS,
): PersistedHomeEntry[] {
  const normalizedByPath = new Map<string, PersistedHomeEntry>();
  for (const entry of entries) {
    const path = normalizePersistedHomePath(entry.path);
    if (!isPersistedHomePathManaged(path, targets)) continue;
    normalizedByPath.set(path, {
      path,
      content: typeof entry.content === 'string' ? entry.content : String(entry.content),
      mtime: normalizePersistedHomeMtime(entry.mtime),
    });
  }
  return [...normalizedByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function partitionPersistedHomeEntriesByScope(
  entries: readonly PersistedHomeEntry[],
  targets: readonly PersistedHomeTarget[] = PERSISTED_HOME_TARGETS,
): {
  globalEntries: PersistedHomeEntry[];
  workspaceEntries: PersistedHomeEntry[];
} {
  const normalizedTargets = normalizePersistedHomeTargets(targets);
  const globalEntries: PersistedHomeEntry[] = [];
  const workspaceEntries: PersistedHomeEntry[] = [];
  for (const entry of normalizePersistedHomeEntries(entries, normalizedTargets)) {
    const scope = resolvePersistedHomeScopeForPath(entry.path, normalizedTargets);
    if (scope === 'global') {
      globalEntries.push(entry);
      continue;
    }
    workspaceEntries.push(entry);
  }
  return { globalEntries, workspaceEntries };
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

async function clearPersistedHomeScopeEntries(store: IDBObjectStore, scopeKey: string): Promise<void> {
  const index = store.index(PERSISTED_HOME_WORKSPACE_INDEX);
  const keyCursorRequest = index.openKeyCursor(IDBKeyRange.only(scopeKey));
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
}

export async function persistPersistedHomeEntries(
  workspaceKey: string,
  entries: readonly PersistedHomeEntry[],
): Promise<void> {
  const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
  const { globalEntries, workspaceEntries } = partitionPersistedHomeEntriesByScope(entries);
  if (!normalizedWorkspaceKey && globalEntries.length === 0) return;
  const database = await openPersistedHomeDatabase();
  if (!database) return;
  const updatedAt = Date.now();

  try {
    const transaction = database.transaction(PERSISTED_HOME_ENTRY_STORE, 'readwrite');
    const store = transaction.objectStore(PERSISTED_HOME_ENTRY_STORE);
    await clearPersistedHomeScopeEntries(store, PERSISTED_HOME_GLOBAL_WORKSPACE_KEY);
    if (normalizedWorkspaceKey) {
      await clearPersistedHomeScopeEntries(store, normalizedWorkspaceKey);
    }

    for (const entry of globalEntries) {
      store.put({
        workspaceKey: PERSISTED_HOME_GLOBAL_WORKSPACE_KEY,
        homePath: entry.path,
        content: entry.content,
        mtime: entry.mtime,
        updatedAt,
      } satisfies PersistedHomeRecord);
    }

    if (normalizedWorkspaceKey) {
      for (const entry of workspaceEntries) {
        store.put({
          workspaceKey: normalizedWorkspaceKey,
          homePath: entry.path,
          content: entry.content,
          mtime: entry.mtime,
          updatedAt,
        } satisfies PersistedHomeRecord);
      }
    }

    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function loadPersistedHomeEntries(workspaceKey: string): Promise<PersistedHomeEntry[]> {
  const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
  const database = await openPersistedHomeDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(PERSISTED_HOME_ENTRY_STORE, 'readonly');
    const store = transaction.objectStore(PERSISTED_HOME_ENTRY_STORE);
    const index = store.index(PERSISTED_HOME_WORKSPACE_INDEX);
    const globalRecordsPromise = runRequest(index.getAll(IDBKeyRange.only(PERSISTED_HOME_GLOBAL_WORKSPACE_KEY)));
    const workspaceRecordsPromise = normalizedWorkspaceKey
      ? runRequest(index.getAll(IDBKeyRange.only(normalizedWorkspaceKey)))
      : Promise.resolve([]);
    const [workspaceRecords, globalRecords] = await Promise.all([workspaceRecordsPromise, globalRecordsPromise]);
    await waitForTransaction(transaction);
    const workspaceEntries = (workspaceRecords as PersistedHomeRecord[]).map((record) => ({
      path: record.homePath,
      content: record.content,
      mtime: normalizePersistedHomeMtime(record.mtime),
    }));
    const globalEntries = (globalRecords as PersistedHomeRecord[]).map((record) => ({
      path: record.homePath,
      content: record.content,
      mtime: normalizePersistedHomeMtime(record.mtime),
    }));
    const partitionedWorkspaceEntries = partitionPersistedHomeEntriesByScope(workspaceEntries);
    const partitionedGlobalEntries = partitionPersistedHomeEntriesByScope(globalEntries);
    const mergedEntriesByPath = new Map<string, PersistedHomeEntry>();
    for (const entry of partitionedWorkspaceEntries.workspaceEntries) {
      mergedEntriesByPath.set(entry.path, entry);
    }
    for (const entry of partitionedWorkspaceEntries.globalEntries) {
      mergedEntriesByPath.set(entry.path, entry);
    }
    for (const entry of partitionedGlobalEntries.globalEntries) {
      mergedEntriesByPath.set(entry.path, entry);
    }
    return [...mergedEntriesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    database.close();
  }
}

export async function inspectPersistedHomeEntries(workspaceKey: string): Promise<PersistedHomeInspectionSnapshot> {
  const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
  const database = await openPersistedHomeDatabase();
  if (!database) {
    return {
      normalizedWorkspaceKey,
      globalEntries: [],
      workspaceEntries: [],
      effectiveEntries: [],
    };
  }

  try {
    const transaction = database.transaction(PERSISTED_HOME_ENTRY_STORE, 'readonly');
    const store = transaction.objectStore(PERSISTED_HOME_ENTRY_STORE);
    const index = store.index(PERSISTED_HOME_WORKSPACE_INDEX);
    const globalRecordsPromise = runRequest(index.getAll(IDBKeyRange.only(PERSISTED_HOME_GLOBAL_WORKSPACE_KEY)));
    const workspaceRecordsPromise = normalizedWorkspaceKey
      ? runRequest(index.getAll(IDBKeyRange.only(normalizedWorkspaceKey)))
      : Promise.resolve([]);
    const [workspaceRecords, globalRecords] = await Promise.all([workspaceRecordsPromise, globalRecordsPromise]);
    await waitForTransaction(transaction);

    const workspaceEntries = partitionPersistedHomeEntriesByScope(
      (workspaceRecords as PersistedHomeRecord[]).map((record) => ({
        path: record.homePath,
        content: record.content,
        mtime: normalizePersistedHomeMtime(record.mtime),
      })),
    ).workspaceEntries;
    const globalEntries = partitionPersistedHomeEntriesByScope(
      (globalRecords as PersistedHomeRecord[]).map((record) => ({
        path: record.homePath,
        content: record.content,
        mtime: normalizePersistedHomeMtime(record.mtime),
      })),
    ).globalEntries;

    const effectiveEntriesByPath = new Map<string, PersistedHomeEntry>();
    for (const entry of workspaceEntries) {
      effectiveEntriesByPath.set(entry.path, entry);
    }
    for (const entry of globalEntries) {
      effectiveEntriesByPath.set(entry.path, entry);
    }

    return {
      normalizedWorkspaceKey,
      globalEntries,
      workspaceEntries,
      effectiveEntries: [...effectiveEntriesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
  } finally {
    database.close();
  }
}

export function buildPersistedHomeSeed(entries: readonly PersistedHomeEntry[]): string {
  const snapshot: PersistedHomeSeedSnapshot = {
    version: 2,
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
    '    if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.entries)) return [];',
    '    const entriesByPath = new Map();',
    '    for (const entry of parsed.entries) {',
    "      if (!entry || typeof entry.path !== 'string' || typeof entry.content !== 'string') continue;",
    '      const relativePath = normalizePath(entry.path);',
    '      if (!isManagedPath(relativePath)) continue;',
    '      const mtime = typeof entry.mtime === "number" && Number.isFinite(entry.mtime) && entry.mtime >= 0 ? Math.trunc(entry.mtime) : null;',
    '      entriesByPath.set(relativePath, { path: relativePath, content: entry.content, mtime });',
    '    }',
    '    return sortEntries(Array.from(entriesByPath.values()));',
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
    '    const stats = fs.statSync(absoluteChildPath);',
    '    const mtime = Number.isFinite(stats.mtimeMs) && stats.mtimeMs >= 0 ? Math.trunc(stats.mtimeMs) : null;',
    "    entries.push({ path: normalizePath(relativeChildPath), content: fs.readFileSync(absoluteChildPath, 'utf8'), mtime });",
    '  }',
    '}',
    'function collectEntries() {',
    '  const entries = [];',
    '  for (const target of targets) {',
    '    const targetPath = path.join(home, target.homePath);',
    "    if (target.kind === 'file') {",
    '      try {',
    '        const stats = fs.statSync(targetPath);',
    '        if (!stats.isFile()) continue;',
    '        const mtime = Number.isFinite(stats.mtimeMs) && stats.mtimeMs >= 0 ? Math.trunc(stats.mtimeMs) : null;',
    "        entries.push({ path: target.homePath, content: fs.readFileSync(targetPath, 'utf8'), mtime });",
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
    '    if (typeof entry.mtime === "number" && Number.isFinite(entry.mtime) && entry.mtime >= 0) {',
    '      const stampedTime = new Date(entry.mtime);',
    '      fs.utimesSync(absolutePath, stampedTime, stampedTime);',
    '    }',
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
