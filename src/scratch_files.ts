import {
  parentFolderPath,
  safeDecodeURIComponent,
  sanitizeScratchFileNameInput,
  sanitizeTitleToFileName,
} from './path_utils';
import type { Route } from './routing';

export const DEFAULT_SCRATCH_FILENAME = 'untitled.md';
const DEFAULT_UNSAVED_FILE_LABEL = 'Unsaved file';
const GIST_NEW_FILE_DRAFT_KEY_PREFIX = 'gist_new_file_draft_v1';

export interface PendingNewGistFileState {
  title?: string;
  filename?: string;
  parentPath?: string;
}

export interface PersistedNewGistFileDraft {
  title: string;
  content: string;
  filename: string;
  parentPath: string;
}

export type ActiveScratchFile =
  | {
      backend: 'repo';
      draftPath: string;
      filePath: string;
      parentPath: string;
      filename: string;
    }
  | {
      backend: 'gist';
      gistId: string;
      draft: PersistedNewGistFileDraft | null;
      filePath: string;
      parentPath: string;
      filename: string;
    };

function gistNewFileDraftKey(
  gistId: string,
  field: 'active' | 'title' | 'content' | 'filename' | 'parentPath',
): string {
  return `${GIST_NEW_FILE_DRAFT_KEY_PREFIX}:${gistId}:${field}`;
}

export function resolveRepoNewDraftPath(route: Route): string | null {
  if (route.name !== 'reponew') return null;
  return safeDecodeURIComponent(route.params.path).replace(/^\/+/, '');
}

export function buildRepoNewDraftPath(parentPath: string): string {
  const normalizedParentPath = normalizeScratchParentPath(parentPath);
  return normalizedParentPath ? `${normalizedParentPath}/index.md` : 'index.md';
}

export function resolveRepoNewFilePath(route: Route, value: string, options?: { literal?: boolean }): string {
  const filename = options?.literal
    ? sanitizeScratchFileNameInput(value) || DEFAULT_SCRATCH_FILENAME
    : sanitizeTitleToFileName(value);
  const draftPath = resolveRepoNewDraftPath(route);
  if (!draftPath) return filename;
  const folder = parentFolderPath(draftPath);
  return folder ? `${folder}/${filename}` : filename;
}

export function readPersistedNewGistFileDraft(gistId: string): PersistedNewGistFileDraft | null {
  try {
    if (localStorage.getItem(gistNewFileDraftKey(gistId, 'active')) !== '1') return null;
    return {
      title: localStorage.getItem(gistNewFileDraftKey(gistId, 'title')) || DEFAULT_UNSAVED_FILE_LABEL,
      content: localStorage.getItem(gistNewFileDraftKey(gistId, 'content')) ?? '',
      filename: localStorage.getItem(gistNewFileDraftKey(gistId, 'filename')) || DEFAULT_SCRATCH_FILENAME,
      parentPath: localStorage.getItem(gistNewFileDraftKey(gistId, 'parentPath')) || '',
    };
  } catch {
    return null;
  }
}

export function writePersistedNewGistFileDraft(gistId: string, draft: PersistedNewGistFileDraft): void {
  try {
    localStorage.setItem(gistNewFileDraftKey(gistId, 'active'), '1');
    localStorage.setItem(gistNewFileDraftKey(gistId, 'title'), draft.title);
    localStorage.setItem(gistNewFileDraftKey(gistId, 'content'), draft.content);
    localStorage.setItem(gistNewFileDraftKey(gistId, 'filename'), draft.filename);
    localStorage.setItem(gistNewFileDraftKey(gistId, 'parentPath'), draft.parentPath);
  } catch {
    // Best effort only.
  }
}

export function clearPersistedNewGistFileDraft(gistId: string | null): void {
  if (!gistId) return;
  try {
    localStorage.removeItem(gistNewFileDraftKey(gistId, 'active'));
    localStorage.removeItem(gistNewFileDraftKey(gistId, 'title'));
    localStorage.removeItem(gistNewFileDraftKey(gistId, 'content'));
    localStorage.removeItem(gistNewFileDraftKey(gistId, 'filename'));
    localStorage.removeItem(gistNewFileDraftKey(gistId, 'parentPath'));
  } catch {
    // Best effort only.
  }
}

export function parsePendingNewGistFileState(state: unknown): PendingNewGistFileState | null {
  if (!state || typeof state !== 'object') return null;
  const newGistFile = (state as { newGistFile?: unknown }).newGistFile;
  if (!newGistFile || typeof newGistFile !== 'object') return null;
  const title = (newGistFile as { title?: unknown }).title;
  const filename = (newGistFile as { filename?: unknown }).filename;
  const parentPath = (newGistFile as { parentPath?: unknown }).parentPath;
  if (title !== undefined && typeof title !== 'string') return null;
  if (filename !== undefined && typeof filename !== 'string') return null;
  if (parentPath !== undefined && typeof parentPath !== 'string') return null;
  return { title, filename, parentPath };
}

export function normalizeScratchParentPath(value: string | null | undefined): string {
  const normalized = (value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return '';
  return normalized;
}

export function buildScratchFilePath(
  parentPath: string | null | undefined,
  fileName: string | null | undefined,
): string {
  const normalizedParentPath = normalizeScratchParentPath(parentPath);
  const normalizedFileName = sanitizeScratchFileNameInput(fileName ?? '') || DEFAULT_SCRATCH_FILENAME;
  return normalizedParentPath ? `${normalizedParentPath}/${normalizedFileName}` : normalizedFileName;
}

export function resolveNewGistFileDraft(
  gistId: string,
  state: unknown,
  options?: { defaultTitle?: string },
): PersistedNewGistFileDraft | null {
  const pending = parsePendingNewGistFileState(state);
  const persisted = readPersistedNewGistFileDraft(gistId);
  if (!pending && !persisted) return null;
  return {
    title: persisted?.title || pending?.title || options?.defaultTitle || DEFAULT_UNSAVED_FILE_LABEL,
    content: persisted?.content ?? '',
    filename:
      sanitizeScratchFileNameInput(persisted?.filename || pending?.filename || DEFAULT_SCRATCH_FILENAME) ||
      DEFAULT_SCRATCH_FILENAME,
    parentPath: normalizeScratchParentPath(persisted?.parentPath ?? pending?.parentPath),
  };
}

export function mergeScratchRouteState(state: unknown, newGistFile: PendingNewGistFileState): Record<string, unknown> {
  const base = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  base.newGistFile = newGistFile;
  return base;
}

export function resolveActiveScratchFile(options: {
  editingBackend: 'repo' | 'gist' | null;
  route: Route;
  routeState: unknown;
  currentRepoDocPath: string | null;
  currentGistId: string | null;
  currentFileName: string | null;
  unsavedFileLabel?: string;
}): ActiveScratchFile | null {
  if (options.editingBackend === 'repo' && options.route.name === 'reponew' && options.currentRepoDocPath === null) {
    const draftPath = resolveRepoNewDraftPath(options.route);
    if (!draftPath) return null;
    return {
      backend: 'repo',
      draftPath,
      filePath: resolveRepoNewFilePath(options.route, DEFAULT_SCRATCH_FILENAME, { literal: true }),
      parentPath: parentFolderPath(draftPath),
      filename: DEFAULT_SCRATCH_FILENAME,
    };
  }

  if (options.editingBackend === 'gist' && options.currentGistId && options.currentFileName === null) {
    const draft = resolveNewGistFileDraft(options.currentGistId, options.routeState, {
      defaultTitle: options.unsavedFileLabel,
    });
    return {
      backend: 'gist',
      gistId: options.currentGistId,
      draft,
      filePath: buildScratchFilePath(draft?.parentPath, draft?.filename),
      parentPath: draft?.parentPath || '',
      filename: draft?.filename || DEFAULT_SCRATCH_FILENAME,
    };
  }

  return null;
}
