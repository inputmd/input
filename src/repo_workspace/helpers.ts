import type { SidebarFile, SidebarFileFilter } from '../components/Sidebar';
import type { RepoDocFile } from '../document_store';
import type { GistFile } from '../github';
import {
  fileNameFromPath,
  isEditableTextFilePath,
  isPathInFolder,
  isSidebarTextFileName,
  isSidebarTextListPath,
  isVisibleSidebarFilePath,
} from '../path_utils';
import { isMarkdownFileName } from '../util';
import type {
  BuildRepoWorkspaceIdentityArgs,
  RepoWorkspaceFileCounts,
  RepoWorkspaceIdentity,
  RepoWorkspaceRename,
} from './types';

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

export function filterRepoWorkspaceSidebarFiles(
  files: SidebarFile[],
  sidebarFileFilter: SidebarFileFilter,
): SidebarFile[] {
  if (sidebarFileFilter === 'markdown') return files.filter((file) => isMarkdownFileName(file.path));
  if (sidebarFileFilter === 'text') return files.filter((file) => isSidebarTextListPath(file.path));
  return files;
}

export function countRepoWorkspaceSidebarFiles(files: SidebarFile[]): RepoWorkspaceFileCounts {
  const visibleFiles = files.filter((file) => isVisibleSidebarFilePath(file.path));
  if (visibleFiles.length === 0) return { markdown: 0, text: 0, total: 0 };
  return {
    markdown: visibleFiles.filter((file) => isMarkdownFileName(file.path)).length,
    text: visibleFiles.filter((file) => isSidebarTextFileName(file.path)).length,
    total: visibleFiles.length,
  };
}
