import type { SidebarFile, SidebarFileFilter } from '../components/Sidebar.tsx';
import type { RepoDocFile } from '../document_store.ts';
import type { GistFile } from '../github.ts';
import type { RepoFileEntry } from '../github_app.ts';
import {
  fileNameFromPath,
  isEditableTextFilePath,
  isPathInFolder,
  isSidebarTextFileName,
  isSidebarTextListPath,
  isVisibleSidebarFilePath,
} from '../path_utils.ts';
import { isMarkdownFileName } from '../util.ts';
import type {
  BuildRepoWorkspaceIdentityArgs,
  RepoWorkspaceDeletedFile,
  RepoWorkspaceFileCounts,
  RepoWorkspaceIdentity,
  RepoWorkspaceOverlayFile,
  RepoWorkspaceRename,
} from './types.ts';

function withScratchSidebarFile(files: SidebarFile[], scratchPath: string | null): SidebarFile[] {
  if (!scratchPath) return files;
  const nextFiles = files.filter((file) => file.path !== scratchPath);
  nextFiles.push({
    path: scratchPath,
    active: true,
    editable: true,
    deemphasized: false,
    virtual: true,
  });
  nextFiles.sort((a, b) => a.path.localeCompare(b.path));
  return nextFiles;
}

export function buildRepoWorkspaceIdentity({
  currentGistId,
  route,
  repoAccessMode,
  selectedRepo,
  publicRepoRef,
  currentRouteRepoRef,
}: BuildRepoWorkspaceIdentityArgs): RepoWorkspaceIdentity {
  if (currentGistId) {
    return {
      sidebarWorkspaceKey: `gist:${currentGistId}`,
      scrollWorkspaceKey: `gist:${currentGistId}`,
    };
  }
  if (repoAccessMode === 'installed' && selectedRepo) {
    return {
      sidebarWorkspaceKey: `repo:${selectedRepo}`,
      scrollWorkspaceKey: `repo:${selectedRepo.toLowerCase()}`,
    };
  }
  if (repoAccessMode === 'shared' && currentRouteRepoRef) {
    return {
      sidebarWorkspaceKey: `shared:${currentRouteRepoRef.owner}/${currentRouteRepoRef.repo}`,
      scrollWorkspaceKey: `shared:${currentRouteRepoRef.owner.toLowerCase()}/${currentRouteRepoRef.repo.toLowerCase()}`,
    };
  }
  if (repoAccessMode === 'public' && publicRepoRef) {
    return {
      sidebarWorkspaceKey: `public:${publicRepoRef.owner}/${publicRepoRef.repo}`,
      scrollWorkspaceKey: `public:${publicRepoRef.owner.toLowerCase()}/${publicRepoRef.repo.toLowerCase()}`,
    };
  }
  if (route.name === 'sharefile') {
    return {
      sidebarWorkspaceKey: `share:${route.params.owner}/${route.params.repo}/${route.params.path}`,
      scrollWorkspaceKey: `share:${route.params.owner.toLowerCase()}/${route.params.repo.toLowerCase()}`,
    };
  }
  if (route.name === 'sharetoken') {
    return {
      sidebarWorkspaceKey: `share:${route.params.token}`,
      scrollWorkspaceKey: null,
    };
  }
  return {
    sidebarWorkspaceKey: 'workspace:none',
    scrollWorkspaceKey: null,
  };
}

export function filterRepoMarkdownFiles(files: RepoDocFile[]): RepoDocFile[] {
  return files.filter((file) => isMarkdownFileName(file.path));
}

export function upsertRepoDocFile(files: RepoDocFile[], next: RepoDocFile): RepoDocFile[] {
  const existingIndex = files.findIndex((file) => file.path === next.path);
  if (existingIndex === -1) return [...files, next].sort((a, b) => a.path.localeCompare(b.path));
  const updated = [...files];
  updated[existingIndex] = next;
  return updated;
}

export function updateRepoDocFile(
  files: RepoDocFile[],
  path: string,
  updates: Partial<Pick<RepoDocFile, 'name' | 'sha' | 'size'>>,
): RepoDocFile[] {
  return files.map((file) => {
    if (file.path !== path) return file;
    return {
      ...file,
      ...updates,
    };
  });
}

export function renameRepoDocFiles(files: RepoDocFile[], renames: RepoWorkspaceRename[]): RepoDocFile[] {
  if (renames.length === 0) return files;
  const renameMap = new Map(renames.map((entry) => [entry.from, entry.to]));
  return files
    .map((file) => {
      const nextPath = renameMap.get(file.path);
      if (!nextPath) return file;
      return {
        ...file,
        name: fileNameFromPath(nextPath),
        path: nextPath,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function findRepoDocFileByPath(files: RepoDocFile[], path: string): RepoDocFile | undefined {
  return files.find((file) => file.path === path);
}

export function listRepoDocFilePaths(files: RepoDocFile[]): string[] {
  return files.map((file) => file.path);
}

export function hasRepoDocFilePath(files: RepoDocFile[], path: string): boolean {
  return files.some((file) => file.path === path);
}

export function listRepoDocFilesInFolder(files: RepoDocFile[], folderPath: string): RepoDocFile[] {
  return files.filter((file) => isPathInFolder(file.path, folderPath));
}

export function buildRepoWorkspaceSidebarSourceFiles({
  gistFiles,
  currentFileName,
  repoSidebarFiles,
  currentRepoDocPath,
  scratchSidebarPath,
}: {
  gistFiles: Record<string, GistFile> | null;
  currentFileName: string | null;
  repoSidebarFiles: RepoDocFile[];
  currentRepoDocPath: string | null;
  scratchSidebarPath: string | null;
}): SidebarFile[] {
  if (gistFiles) {
    const files = Object.keys(gistFiles).map((path) => ({
      path,
      active: path === currentFileName,
      editable: isEditableTextFilePath(path),
      deemphasized: !isSidebarTextFileName(path),
      size: gistFiles[path]?.size,
    }));
    return withScratchSidebarFile(files, scratchSidebarPath);
  }
  const files = repoSidebarFiles.map((file) => ({
    path: file.path,
    active: file.path === currentRepoDocPath,
    editable: isEditableTextFilePath(file.path),
    deemphasized: !isSidebarTextFileName(file.path),
    size: file.size,
  }));
  return withScratchSidebarFile(files, scratchSidebarPath);
}

export function applyRepoOverlayFilesToDocFiles(
  files: RepoDocFile[],
  overlayFiles: Array<{ path: string; content: string }>,
): RepoDocFile[] {
  if (overlayFiles.length === 0) return files;

  const overlayByPath = new Map(overlayFiles.map((file) => [file.path, file.content]));
  const encoder = new TextEncoder();
  const nextFiles = files.map((file) => {
    const overlayContent = overlayByPath.get(file.path);
    if (overlayContent == null) return file;
    return {
      ...file,
      size: encoder.encode(overlayContent).length,
    };
  });

  for (const [path, content] of overlayByPath) {
    if (files.some((file) => file.path === path)) continue;
    nextFiles.push({
      name: fileNameFromPath(path),
      path,
      sha: '',
      size: encoder.encode(content).length,
    });
  }

  nextFiles.sort((a, b) => a.path.localeCompare(b.path));
  return nextFiles;
}

export function findRepoRenamedBaseSourcePath(renames: RepoWorkspaceRename[], path: string): string | null {
  for (const rename of renames) {
    if (rename.to === path) return rename.from;
  }
  return null;
}

export function resolveRepoWorkspaceBasePath(options: {
  path: string;
  files: RepoDocFile[];
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRename[];
}): string | null {
  const { path, files, overlayFiles, deletedBaseFiles, renamedBaseFiles } = options;
  const pathHasOverlay = overlayFiles.some((file) => file.path === path);
  if (
    pathHasOverlay &&
    (deletedBaseFiles.some((file) => file.path === path) || renamedBaseFiles.some((file) => file.from === path))
  ) {
    return null;
  }
  if (findRepoDocFileByPath(files, path)) return path;
  return findRepoRenamedBaseSourcePath(renamedBaseFiles, path);
}

export function applyRepoWorkspaceMutationsToDocFiles(
  files: RepoDocFile[],
  options: {
    overlayFiles: Array<{ path: string; content: string }>;
    deletedBaseFiles: RepoWorkspaceDeletedFile[];
    renamedBaseFiles: RepoWorkspaceRename[];
  },
): RepoDocFile[] {
  const { overlayFiles, deletedBaseFiles, renamedBaseFiles } = options;
  if (overlayFiles.length === 0 && deletedBaseFiles.length === 0 && renamedBaseFiles.length === 0) return files;

  const deletedPaths = new Set(deletedBaseFiles.map((file) => file.path));
  const renamedPaths = new Map(renamedBaseFiles.map((file) => [file.from, file.to]));
  const nextFiles = files
    .flatMap((file) => {
      if (deletedPaths.has(file.path)) return [];
      const renamedPath = renamedPaths.get(file.path);
      if (!renamedPath) return [file];
      return [
        {
          ...file,
          name: fileNameFromPath(renamedPath),
          path: renamedPath,
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return applyRepoOverlayFilesToDocFiles(nextFiles, overlayFiles);
}

function isInputWorkspacePath(path: string): boolean {
  return path === '.input' || path.startsWith('.input/');
}

export function filterRepoWorkspaceSidebarFiles(
  files: SidebarFile[],
  sidebarFileFilter: SidebarFileFilter,
  showHiddenFiles = false,
): SidebarFile[] {
  const visibleFiles = showHiddenFiles
    ? files
    : files.filter((file) => isInputWorkspacePath(file.path) || isVisibleSidebarFilePath(file.path));
  if (sidebarFileFilter === 'markdown') {
    return visibleFiles.filter((file) => isInputWorkspacePath(file.path) || isMarkdownFileName(file.path));
  }
  if (sidebarFileFilter === 'text') {
    return visibleFiles.filter((file) => isInputWorkspacePath(file.path) || isSidebarTextListPath(file.path));
  }
  return visibleFiles;
}

export function countRepoWorkspaceSidebarFiles(files: SidebarFile[], showHiddenFiles = false): RepoWorkspaceFileCounts {
  const visibleFiles = showHiddenFiles
    ? files
    : files.filter((file) => isInputWorkspacePath(file.path) || isVisibleSidebarFilePath(file.path));
  if (visibleFiles.length === 0) return { markdown: 0, text: 0, total: 0 };
  return {
    markdown: visibleFiles.filter((file) => isMarkdownFileName(file.path)).length,
    text: visibleFiles.filter((file) => isSidebarTextListPath(file.path)).length,
    total: visibleFiles.length,
  };
}

export function buildRepoTerminalBaseFiles(entries: RepoFileEntry[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of entries) {
    files[entry.path] = entry.content;
  }
  return files;
}

export function buildGistTerminalBaseFiles(gistFiles: Record<string, GistFile> | null): Record<string, string> {
  if (!gistFiles) return {};
  const files: Record<string, string> = {};
  for (const [path, file] of Object.entries(gistFiles)) {
    if (file.truncated || file.content == null) continue;
    files[path] = file.content;
  }
  return files;
}

export function buildGistRepoDocFiles(gistFiles: Record<string, GistFile> | null): RepoDocFile[] {
  if (!gistFiles) return [];
  return Object.entries(gistFiles)
    .map(([path, file]) => ({
      name: file.filename || fileNameFromPath(path),
      path,
      sha: '',
      size: file.size,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function setRepoTerminalBaseFile(
  files: Record<string, string>,
  path: string,
  content: string,
): Record<string, string> {
  if (files[path] === content) return files;
  return { ...files, [path]: content };
}

export function removeRepoTerminalBaseFile(files: Record<string, string>, path: string): Record<string, string> {
  if (!(path in files)) return files;
  const next = { ...files };
  delete next[path];
  return next;
}

export function removeRepoTerminalBaseFiles(
  files: Record<string, string>,
  paths: readonly string[],
): Record<string, string> {
  if (paths.length === 0) return files;
  let next: Record<string, string> | null = null;
  for (const path of paths) {
    if (!(path in (next ?? files))) continue;
    if (next === null) next = { ...files };
    delete next[path];
  }
  return next ?? files;
}

export function renameRepoTerminalBaseFiles(
  files: Record<string, string>,
  renames: RepoWorkspaceRename[],
): Record<string, string> {
  if (renames.length === 0) return files;
  let next: Record<string, string> | null = null;
  for (const rename of renames) {
    const source = (next ?? files)[rename.from];
    if (typeof source !== 'string') continue;
    if (next === null) next = { ...files };
    delete next[rename.from];
    next[rename.to] = source;
  }
  return next ?? files;
}

export function applyRepoWorkspaceMutationsToTerminalFiles(
  files: Record<string, string>,
  options: {
    overlayFiles: Array<{ path: string; content: string }>;
    deletedBaseFiles: RepoWorkspaceDeletedFile[];
    renamedBaseFiles: RepoWorkspaceRename[];
  },
): Record<string, string> {
  const { overlayFiles, deletedBaseFiles, renamedBaseFiles } = options;
  if (overlayFiles.length === 0 && deletedBaseFiles.length === 0 && renamedBaseFiles.length === 0) return files;

  let nextFiles = removeRepoTerminalBaseFiles(
    files,
    deletedBaseFiles.map((file) => file.path),
  );
  nextFiles = renameRepoTerminalBaseFiles(nextFiles, renamedBaseFiles);
  for (const overlayFile of overlayFiles) {
    nextFiles = setRepoTerminalBaseFile(nextFiles, overlayFile.path, overlayFile.content);
  }
  return nextFiles;
}
