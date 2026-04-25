import type { RepoDocFile } from '../document_store.ts';
import type { RepoWorkspaceDeletedFile, RepoWorkspaceOverlayFile, RepoWorkspaceRenamedFile } from './types.ts';

const RECOVERY_DB_NAME = 'input_repo_workspace_recovery_v1';
const RECOVERY_DB_VERSION = 1;
const RECOVERY_STORE = 'snapshots';
export const REPO_WORKSPACE_RECOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type RepoWorkspaceRecoveryBackend = 'repo' | 'gist';

export type RepoWorkspaceRecoveryRestoreStatus = 'restored' | 'conflict' | 'none';

export interface RepoWorkspaceRecoveryBaseFingerprint {
  path: string;
  state: 'missing' | 'present';
  sha?: string;
  size?: number;
  contentHash?: string;
}

export interface RepoWorkspaceRecoverySnapshot {
  version: 1;
  workspaceKey: string;
  backend: RepoWorkspaceRecoveryBackend;
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRenamedFile[];
  baseFingerprints: RepoWorkspaceRecoveryBaseFingerprint[];
  updatedAt: number;
}

interface BuildRepoWorkspaceRecoverySnapshotArgs {
  workspaceKey: string;
  backend: RepoWorkspaceRecoveryBackend;
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRenamedFile[];
  findBaseFile: (path: string) => RepoDocFile | undefined;
  resolveBasePath: (path: string) => string | null;
  baseFileContents: Record<string, string>;
  now?: number;
}

interface ValidateRepoWorkspaceRecoverySnapshotArgs {
  snapshot: RepoWorkspaceRecoverySnapshot;
  findBaseFile: (path: string) => RepoDocFile | undefined;
  baseFileContents: Record<string, string>;
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

async function openRecoveryDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null;
  const request = window.indexedDB.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(RECOVERY_STORE)) {
      database.createObjectStore(RECOVERY_STORE, { keyPath: 'workspaceKey' });
    }
  });
  return await runRequest(request);
}

function stableContentHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function contentSize(content: string): number {
  return new TextEncoder().encode(content).length;
}

function buildBaseFingerprint(
  path: string,
  findBaseFile: (path: string) => RepoDocFile | undefined,
  baseFileContents: Record<string, string>,
): RepoWorkspaceRecoveryBaseFingerprint | null {
  const baseFile = findBaseFile(path);
  const content = baseFileContents[path];
  if (!baseFile && typeof content !== 'string') {
    return { path, state: 'missing' };
  }
  const sha = typeof baseFile?.sha === 'string' && baseFile.sha ? baseFile.sha : undefined;
  if (sha) {
    return {
      path,
      state: 'present',
      sha,
      ...(typeof baseFile?.size === 'number' ? { size: baseFile.size } : {}),
    };
  }
  if (typeof content === 'string') {
    return {
      path,
      state: 'present',
      size: typeof baseFile?.size === 'number' ? baseFile.size : contentSize(content),
      contentHash: stableContentHash(content),
    };
  }
  return null;
}

function addExpectedFingerprint(
  expectedByPath: Map<string, RepoWorkspaceRecoveryBaseFingerprint>,
  path: string,
  findBaseFile: (path: string) => RepoDocFile | undefined,
  baseFileContents: Record<string, string>,
): boolean {
  if (expectedByPath.has(path)) return true;
  const fingerprint = buildBaseFingerprint(path, findBaseFile, baseFileContents);
  if (!fingerprint) return false;
  expectedByPath.set(path, fingerprint);
  return true;
}

export function buildRepoWorkspaceRecoverySnapshot({
  workspaceKey,
  backend,
  overlayFiles,
  deletedBaseFiles,
  renamedBaseFiles,
  findBaseFile,
  resolveBasePath,
  baseFileContents,
  now = Date.now(),
}: BuildRepoWorkspaceRecoverySnapshotArgs): RepoWorkspaceRecoverySnapshot | null {
  if (overlayFiles.length === 0 && deletedBaseFiles.length === 0 && renamedBaseFiles.length === 0) return null;

  const expectedByPath = new Map<string, RepoWorkspaceRecoveryBaseFingerprint>();
  const deletedPaths = new Set(deletedBaseFiles.map((file) => file.path));
  const renameSources = new Set(renamedBaseFiles.map((file) => file.from));

  for (const file of deletedBaseFiles) {
    if (!addExpectedFingerprint(expectedByPath, file.path, findBaseFile, baseFileContents)) return null;
  }
  for (const file of renamedBaseFiles) {
    if (!addExpectedFingerprint(expectedByPath, file.from, findBaseFile, baseFileContents)) return null;
    expectedByPath.set(file.to, { path: file.to, state: 'missing' });
  }
  for (const file of overlayFiles) {
    const basePath = resolveBasePath(file.path);
    if (basePath) {
      if (!addExpectedFingerprint(expectedByPath, basePath, findBaseFile, baseFileContents)) return null;
      continue;
    }
    if (!deletedPaths.has(file.path) && !renameSources.has(file.path)) {
      expectedByPath.set(file.path, { path: file.path, state: 'missing' });
    }
  }

  return {
    version: 1,
    workspaceKey,
    backend,
    overlayFiles,
    deletedBaseFiles,
    renamedBaseFiles,
    baseFingerprints: [...expectedByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    updatedAt: now,
  };
}

function fingerprintsMatch(
  expected: RepoWorkspaceRecoveryBaseFingerprint,
  actual: RepoWorkspaceRecoveryBaseFingerprint | null,
): boolean {
  if (!actual) return false;
  if (expected.state !== actual.state) return false;
  if (expected.state === 'missing') return true;
  if (expected.sha || actual.sha) return expected.sha === actual.sha;
  if (expected.contentHash || actual.contentHash) {
    return expected.contentHash === actual.contentHash && expected.size === actual.size;
  }
  return false;
}

export function validateRepoWorkspaceRecoverySnapshot({
  snapshot,
  findBaseFile,
  baseFileContents,
}: ValidateRepoWorkspaceRecoverySnapshotArgs): boolean {
  if (snapshot.version !== 1) return false;
  for (const expected of snapshot.baseFingerprints) {
    const actual = buildBaseFingerprint(expected.path, findBaseFile, baseFileContents);
    if (!fingerprintsMatch(expected, actual)) return false;
  }
  return true;
}

function isRecoverySnapshot(value: unknown): value is RepoWorkspaceRecoverySnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RepoWorkspaceRecoverySnapshot>;
  return (
    candidate.version === 1 &&
    typeof candidate.workspaceKey === 'string' &&
    (candidate.backend === 'repo' || candidate.backend === 'gist') &&
    Array.isArray(candidate.overlayFiles) &&
    Array.isArray(candidate.deletedBaseFiles) &&
    Array.isArray(candidate.renamedBaseFiles) &&
    Array.isArray(candidate.baseFingerprints) &&
    typeof candidate.updatedAt === 'number'
  );
}

export async function loadRepoWorkspaceRecoverySnapshot(
  workspaceKey: string,
): Promise<RepoWorkspaceRecoverySnapshot | null> {
  const database = await openRecoveryDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(RECOVERY_STORE, 'readonly');
    const store = transaction.objectStore(RECOVERY_STORE);
    const record = await runRequest(store.get(workspaceKey));
    await waitForTransaction(transaction);
    return isRecoverySnapshot(record) ? record : null;
  } finally {
    database.close();
  }
}

export async function saveRepoWorkspaceRecoverySnapshot(snapshot: RepoWorkspaceRecoverySnapshot): Promise<void> {
  const database = await openRecoveryDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(RECOVERY_STORE, 'readwrite');
    transaction.objectStore(RECOVERY_STORE).put(snapshot);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function deleteRepoWorkspaceRecoverySnapshot(workspaceKey: string): Promise<void> {
  const database = await openRecoveryDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(RECOVERY_STORE, 'readwrite');
    transaction.objectStore(RECOVERY_STORE).delete(workspaceKey);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function pruneExpiredRepoWorkspaceRecoverySnapshots(
  now = Date.now(),
  ttlMs = REPO_WORKSPACE_RECOVERY_TTL_MS,
): Promise<void> {
  const database = await openRecoveryDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(RECOVERY_STORE, 'readwrite');
    const store = transaction.objectStore(RECOVERY_STORE);
    const records = (await runRequest(store.getAll())) as unknown[];
    for (const record of records) {
      if (!isRecoverySnapshot(record) || now - record.updatedAt > ttlMs) {
        const workspaceKey = isRecoverySnapshot(record)
          ? record.workspaceKey
          : typeof record === 'object' && record && 'workspaceKey' in record
            ? String((record as { workspaceKey: unknown }).workspaceKey)
            : null;
        if (workspaceKey) store.delete(workspaceKey);
      }
    }
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}
