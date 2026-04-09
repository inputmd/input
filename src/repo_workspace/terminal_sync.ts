import type { RepoWorkspaceDeletedFile, RepoWorkspaceOverlayFile, RepoWorkspaceRenamedFile } from './types.ts';

export interface TerminalImportDiff {
  upserts: Record<string, string>;
  deletes: string[];
}

export interface TerminalImportOptions {
  silent?: boolean;
}

export interface TerminalImportedWorkspaceChanges {
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRenamedFile[];
  importedCount: number;
}

const TERMINAL_IMPORT_IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'coverage',
]);

export function shouldImportTerminalPath(path: string): boolean {
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  return !segments.some((segment) => TERMINAL_IMPORT_IGNORED_SEGMENTS.has(segment));
}

export function buildTerminalImportDiff(options: {
  managedFiles: Record<string, string>;
  actualFiles: Record<string, string>;
  activeEditPath?: string | null;
}): TerminalImportDiff {
  const { managedFiles, actualFiles, activeEditPath = null } = options;
  const managedEntries = Object.entries(managedFiles).filter(([path]) => path !== activeEditPath);
  const actualEntries = Object.entries(actualFiles).filter(([path]) => path !== activeEditPath);
  const managedByPath = new Map(managedEntries);
  const actualByPath = new Map(actualEntries);
  const upserts: Record<string, string> = {};
  const deletes: string[] = [];

  for (const [path, content] of actualByPath) {
    if (managedByPath.get(path) === content) continue;
    upserts[path] = content;
  }
  for (const path of managedByPath.keys()) {
    if (actualByPath.has(path)) continue;
    deletes.push(path);
  }
  deletes.sort((a, b) => a.localeCompare(b));
  return { upserts, deletes };
}

export function applyTerminalImportDiffToWorkspaceChanges(options: {
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRenamedFile[];
  diff: TerminalImportDiff;
  resolveRepoBasePath: (path: string) => string | null;
}): TerminalImportedWorkspaceChanges {
  const { overlayFiles, deletedBaseFiles, renamedBaseFiles, diff, resolveRepoBasePath } = options;
  const overlayByPath = new Map(overlayFiles.map((file) => [file.path, file]));
  const deletedByPath = new Map(deletedBaseFiles.map((file) => [file.path, file]));
  const renamedByFrom = new Map(renamedBaseFiles.map((file) => [file.from, file]));
  let importedCount = 0;

  for (const path of diff.deletes) {
    const baseRepoPath = resolveRepoBasePath(path);
    if (!baseRepoPath) {
      overlayByPath.delete(path);
      continue;
    }
    overlayByPath.delete(path);
    renamedByFrom.delete(baseRepoPath);
    deletedByPath.set(baseRepoPath, { path: baseRepoPath, source: 'terminal' });
    importedCount += 1;
  }

  for (const [path, content] of Object.entries(diff.upserts)) {
    const baseRepoPath = resolveRepoBasePath(path);
    if (baseRepoPath) {
      deletedByPath.delete(baseRepoPath);
    }
    overlayByPath.set(path, { path, content, source: 'terminal' });
    importedCount += 1;
  }

  return {
    overlayFiles: [...overlayByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    deletedBaseFiles: [...deletedByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    renamedBaseFiles: [...renamedByFrom.values()].sort((a, b) => a.from.localeCompare(b.from)),
    importedCount,
  };
}
