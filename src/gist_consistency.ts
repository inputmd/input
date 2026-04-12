import type { GistDetail, GistSummary } from './github';

const RECENT_CREATED_KEY_PREFIX = 'recent_created_gists';
const RECENT_DELETED_KEY_PREFIX = 'recent_deleted_gists';
const MAX_RECENT_ITEMS = 50;

interface RecentCreatedItem {
  gist: GistSummary;
  at: number;
}

interface RecentDeletedItem {
  id: string;
  at: number;
}

function createdKey(login: string): string {
  return `${RECENT_CREATED_KEY_PREFIX}:${login}`;
}

function deletedKey(login: string): string {
  return `${RECENT_DELETED_KEY_PREFIX}:${login}`;
}

function readJsonArray<T>(key: string): T[] {
  const raw = sessionStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeJsonArray<T>(key: string, items: T[]): void {
  sessionStorage.setItem(key, JSON.stringify(items));
}

function gistDetailToSummary(gist: GistDetail): GistSummary {
  const files: Record<string, { filename: string; size: number }> = {};
  for (const [name, file] of Object.entries(gist.files)) {
    files[name] = { filename: file.filename, size: file.size };
  }
  return {
    id: gist.id,
    description: gist.description,
    created_at: gist.created_at,
    updated_at: gist.updated_at,
    public: gist.public,
    owner: gist.owner ? { ...gist.owner } : null,
    files,
  };
}

export function getRecentlyCreatedGists(login: string | null): GistSummary[] {
  if (!login) return [];
  const items = readJsonArray<RecentCreatedItem>(createdKey(login));
  return items.map((item) => item.gist);
}

export function getRecentlyDeletedGistIds(login: string | null): string[] {
  if (!login) return [];
  const items = readJsonArray<RecentDeletedItem>(deletedKey(login));
  return items.map((item) => item.id);
}

export function markGistRecentlyCreated(login: string | null, gist: GistDetail): void {
  if (!login) return;
  const now = Date.now();
  const next = readJsonArray<RecentCreatedItem>(createdKey(login))
    .filter((item) => item.gist.id !== gist.id)
    .filter((item) => item.at > now - 24 * 60 * 60 * 1000);
  next.unshift({ gist: gistDetailToSummary(gist), at: now });
  writeJsonArray(createdKey(login), next.slice(0, MAX_RECENT_ITEMS));

  // If this gist was previously marked deleted, remove it there.
  const deletedNext = readJsonArray<RecentDeletedItem>(deletedKey(login))
    .filter((item) => item.id !== gist.id)
    .filter((item) => item.at > now - 24 * 60 * 60 * 1000);
  writeJsonArray(deletedKey(login), deletedNext.slice(0, MAX_RECENT_ITEMS));
}

export function markGistRecentlyDeleted(login: string | null, gistId: string): void {
  if (!login) return;
  const now = Date.now();
  const next = readJsonArray<RecentDeletedItem>(deletedKey(login))
    .filter((item) => item.id !== gistId)
    .filter((item) => item.at > now - 24 * 60 * 60 * 1000);
  next.unshift({ id: gistId, at: now });
  writeJsonArray(deletedKey(login), next.slice(0, MAX_RECENT_ITEMS));

  // If this gist was previously marked created, remove it there.
  const createdNext = readJsonArray<RecentCreatedItem>(createdKey(login))
    .filter((item) => item.gist.id !== gistId)
    .filter((item) => item.at > now - 24 * 60 * 60 * 1000);
  writeJsonArray(createdKey(login), createdNext.slice(0, MAX_RECENT_ITEMS));
}

export function reconcileRecentGists(login: string | null, apiGists: GistSummary[]): void {
  if (!login) return;
  const now = Date.now();
  const apiIds = new Set(apiGists.map((g) => g.id));
  const created = readJsonArray<RecentCreatedItem>(createdKey(login))
    .filter((item) => !apiIds.has(item.gist.id))
    .filter((item) => item.at > now - 24 * 60 * 60 * 1000);
  const deleted = readJsonArray<RecentDeletedItem>(deletedKey(login)).filter(
    (item) => item.at > now - 24 * 60 * 60 * 1000,
  );
  writeJsonArray(createdKey(login), created.slice(0, MAX_RECENT_ITEMS));
  writeJsonArray(deletedKey(login), deleted.slice(0, MAX_RECENT_ITEMS));
}
