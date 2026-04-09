import type { RepoDocFile } from '../document_store';
import type { RepoBatchCreateFile, RepoBatchMutation, RepoBatchUpdateFile } from '../github_app';
import { fileNameFromPath } from '../path_utils';
import type { RepoWorkspaceOverlayFile } from './types';

export interface RepoWorkspaceTextSavePlan {
  mutation: RepoBatchMutation;
  changeCount: number;
  touchedFiles: Array<{ path: string; content: string }>;
}

interface BuildRepoWorkspaceTextSavePlanArgs {
  overlayFiles: RepoWorkspaceOverlayFile[];
  currentPath: string | null;
  targetPath: string;
  currentContent: string;
  currentSavedContent: string | null;
  findBaseRepoSidebarFile: (path: string) => RepoDocFile | undefined;
}

function buildRepoWorkspaceTextSaveMessage(
  creates: RepoBatchCreateFile[],
  updates: RepoBatchUpdateFile[],
  changeCount: number,
): string {
  if (creates.length === 1 && updates.length === 0) {
    return `Create ${fileNameFromPath(creates[0]!.path)}`;
  }
  if (creates.length === 0 && updates.length === 1) {
    return `Update ${updates[0]!.path}`;
  }
  return `Apply ${changeCount} workspace changes`;
}

export function buildRepoWorkspaceTextSavePlan({
  overlayFiles,
  currentPath,
  targetPath,
  currentContent,
  currentSavedContent,
  findBaseRepoSidebarFile,
}: BuildRepoWorkspaceTextSavePlanArgs): RepoWorkspaceTextSavePlan {
  const pendingTextChangesByPath = new Map(overlayFiles.map((file) => [file.path, file.content]));
  if (currentPath) {
    if (currentContent !== currentSavedContent) {
      pendingTextChangesByPath.set(currentPath, currentContent);
    } else {
      pendingTextChangesByPath.delete(currentPath);
    }
  }

  const creates: RepoBatchCreateFile[] = [];
  const updates: RepoBatchUpdateFile[] = [];

  if (!currentPath) {
    pendingTextChangesByPath.delete(targetPath);
    creates.push({ path: targetPath, content: currentContent });
  }

  for (const [path, content] of pendingTextChangesByPath) {
    const baseFile = findBaseRepoSidebarFile(path);
    if (!baseFile) {
      creates.push({ path, content });
      continue;
    }
    updates.push({
      path,
      content,
      ...(baseFile.sha ? { expectedSha: baseFile.sha } : {}),
    });
  }

  const changeCount = creates.length + updates.length;
  return {
    mutation: {
      message: buildRepoWorkspaceTextSaveMessage(creates, updates, changeCount),
      ...(creates.length > 0 ? { creates } : {}),
      ...(updates.length > 0 ? { updates } : {}),
    },
    changeCount,
    touchedFiles: [
      ...creates.map((file) => ({ path: file.path, content: file.content })),
      ...updates.map((file) => ({ path: file.path, content: file.content })),
    ],
  };
}
