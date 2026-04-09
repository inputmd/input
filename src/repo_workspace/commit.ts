import type { RepoDocFile } from '../document_store.ts';
import type { RepoBatchCreateFile, RepoBatchMutation, RepoBatchRename, RepoBatchUpdateFile } from '../github_app.ts';
import { fileNameFromPath } from '../path_utils.ts';
import type { RepoWorkspaceDeletedFile, RepoWorkspaceOverlayFile, RepoWorkspaceRenamedFile } from './types.ts';

export interface RepoWorkspaceTextSavePlan {
  mutation: RepoBatchMutation;
  changeCount: number;
  touchedFiles: Array<{ path: string; content: string }>;
}

interface BuildRepoWorkspaceTextSavePlanArgs {
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRenamedFile[];
  draftFile?: {
    currentPath: string | null;
    targetPath: string;
    currentContent: string;
    currentSavedContent: string | null;
  } | null;
  findBaseRepoSidebarFile: (path: string) => RepoDocFile | undefined;
  resolveRepoBasePath: (path: string) => string | null;
}

function buildRepoWorkspaceTextSaveMessage(
  creates: RepoBatchCreateFile[],
  updates: RepoBatchUpdateFile[],
  deletes: string[],
  renames: RepoBatchRename[],
  changeCount: number,
): string {
  if (deletes.length === 1 && creates.length === 0 && updates.length === 0 && renames.length === 0) {
    return `Delete ${deletes[0]}`;
  }
  if (renames.length === 1 && creates.length === 0 && updates.length === 0 && deletes.length === 0) {
    return `Rename ${renames[0]!.from} to ${renames[0]!.to}`;
  }
  if (creates.length === 1 && updates.length === 0 && deletes.length === 0 && renames.length === 0) {
    return `Create ${fileNameFromPath(creates[0]!.path)}`;
  }
  if (creates.length === 0 && updates.length === 1 && deletes.length === 0 && renames.length === 0) {
    return `Update ${updates[0]!.path}`;
  }
  return `Apply ${changeCount} workspace changes`;
}

export function buildRepoWorkspaceTextSavePlan({
  overlayFiles,
  deletedBaseFiles,
  renamedBaseFiles,
  draftFile = null,
  findBaseRepoSidebarFile,
  resolveRepoBasePath,
}: BuildRepoWorkspaceTextSavePlanArgs): RepoWorkspaceTextSavePlan {
  const pendingTextChangesByPath = new Map(overlayFiles.map((file) => [file.path, file.content]));
  if (draftFile) {
    if (draftFile.currentPath === null) {
      pendingTextChangesByPath.set(draftFile.targetPath, draftFile.currentContent);
    } else {
      const basePath = resolveRepoBasePath(draftFile.currentPath);
      if (!basePath) {
        pendingTextChangesByPath.set(draftFile.currentPath, draftFile.currentContent);
      } else if (draftFile.currentContent !== draftFile.currentSavedContent) {
        pendingTextChangesByPath.set(draftFile.currentPath, draftFile.currentContent);
      } else {
        pendingTextChangesByPath.delete(draftFile.currentPath);
      }
    }
  }

  const deletePaths = new Set(deletedBaseFiles.map((file) => file.path));
  const renameTargetsBySource = new Map(
    renamedBaseFiles.filter((file) => !deletePaths.has(file.from)).map((file) => [file.from, file.to]),
  );
  const createsByPath = new Map<string, string>();
  const updatesByPath = new Map<string, RepoBatchUpdateFile>();
  const renamesBySource = new Map<string, string>();

  for (const rename of renamedBaseFiles) {
    if (deletePaths.has(rename.from)) continue;
    const renamedContent = pendingTextChangesByPath.get(rename.to);
    if (renamedContent != null) {
      deletePaths.add(rename.from);
      createsByPath.set(rename.to, renamedContent);
      pendingTextChangesByPath.delete(rename.to);
    } else {
      renamesBySource.set(rename.from, rename.to);
    }
  }

  for (const [path, content] of pendingTextChangesByPath) {
    const basePath = resolveRepoBasePath(path);
    if (!basePath) {
      createsByPath.set(path, content);
      continue;
    }
    if (deletePaths.has(basePath)) continue;
    const renamedTarget = renameTargetsBySource.get(basePath);
    if (renamedTarget) {
      renamesBySource.delete(basePath);
      deletePaths.add(basePath);
      createsByPath.set(path, content);
      continue;
    }
    if (basePath !== path) {
      deletePaths.add(basePath);
      createsByPath.set(path, content);
      continue;
    }
    const baseFile = findBaseRepoSidebarFile(basePath);
    if (!baseFile) {
      createsByPath.set(path, content);
      continue;
    }
    updatesByPath.set(path, {
      path,
      content,
      ...(baseFile.sha ? { expectedSha: baseFile.sha } : {}),
    });
  }

  const creates = [...createsByPath.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const updates = [...updatesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const deletes = [...deletePaths].sort((a, b) => a.localeCompare(b));
  const renames = [...renamesBySource.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const changeCount = creates.length + updates.length + deletes.length + renames.length;
  return {
    mutation: {
      message: buildRepoWorkspaceTextSaveMessage(creates, updates, deletes, renames, changeCount),
      ...(deletes.length > 0 ? { deletes } : {}),
      ...(renames.length > 0 ? { renames } : {}),
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
