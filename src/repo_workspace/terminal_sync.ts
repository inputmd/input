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

const TERMINAL_IMPORT_IGNORED_FILENAMES = new Set([
  '.input-home-overlay-provision.cjs',
  '.input-home-overlay.tar',
  '.input-persisted-home-sync.cjs',
  '.input-persisted-home-seed.json',
  '.input-webcontainer-home-overlay.json',
]);

export function shouldImportTerminalPath(path: string): boolean {
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => TERMINAL_IMPORT_IGNORED_FILENAMES.has(segment))) return false;
  return !segments.some((segment) => TERMINAL_IMPORT_IGNORED_SEGMENTS.has(segment));
}

export function buildTerminalImportDiff(options: {
  managedFiles: Record<string, string>;
  actualFiles: Record<string, string>;
  activeEditPath?: string | null;
  includeActiveEditPath?: boolean;
}): TerminalImportDiff {
  const { managedFiles, actualFiles, activeEditPath = null, includeActiveEditPath = false } = options;
  const shouldIncludePath = (path: string) => includeActiveEditPath || path !== activeEditPath;
  const managedEntries = Object.entries(managedFiles).filter(([path]) => shouldIncludePath(path));
  const actualEntries = Object.entries(actualFiles).filter(([path]) => shouldIncludePath(path));
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
