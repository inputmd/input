import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoDocFile } from '../document_store';
import { clearStoredScrollPositions } from '../scroll_positions';
import { isMarkdownFileName } from '../util';
import {
  buildRepoWorkspaceSidebarSourceFiles,
  countRepoWorkspaceSidebarFiles,
  filterRepoMarkdownFiles,
  filterRepoWorkspaceSidebarFiles,
  findRepoDocFileByPath,
  hasRepoDocFilePath,
  listRepoDocFilePaths,
  listRepoDocFilesInFolder,
  renameRepoDocFiles,
  updateRepoDocFile,
  upsertRepoDocFile,
} from './helpers';
import type { RepoWorkspaceState, UseRepoWorkspaceArgs } from './types';

export function useRepoWorkspace({
  workspaceIdentity,
  gistFiles,
  currentFileName,
  currentRepoDocPath,
  scratchSidebarPath,
  sidebarFileFilter,
}: UseRepoWorkspaceArgs): RepoWorkspaceState {
  const [repoMarkdownFiles, setRepoMarkdownFiles] = useState<RepoDocFile[]>([]);
  const [repoSidebarFiles, setRepoSidebarFiles] = useState<RepoDocFile[]>([]);
  const [terminalSnapshotVersion, setTerminalSnapshotVersion] = useState(0);
  const previousScrollWorkspaceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const previousWorkspaceKey = previousScrollWorkspaceKeyRef.current;
    previousScrollWorkspaceKeyRef.current = workspaceIdentity.scrollWorkspaceKey;
    if (
      !previousWorkspaceKey ||
      !workspaceIdentity.scrollWorkspaceKey ||
      previousWorkspaceKey === workspaceIdentity.scrollWorkspaceKey
    ) {
      return;
    }
    clearStoredScrollPositions();
  }, [workspaceIdentity.scrollWorkspaceKey]);

  const sidebarSourceFiles = useMemo(() => {
    return buildRepoWorkspaceSidebarSourceFiles({
      gistFiles,
      currentFileName,
      repoSidebarFiles,
      currentRepoDocPath,
      scratchSidebarPath,
    });
  }, [currentFileName, currentRepoDocPath, gistFiles, repoSidebarFiles, scratchSidebarPath]);

  const sidebarFiles = useMemo(() => {
    return filterRepoWorkspaceSidebarFiles(sidebarSourceFiles, sidebarFileFilter);
  }, [sidebarFileFilter, sidebarSourceFiles]);

  const sidebarFileCounts = useMemo(() => countRepoWorkspaceSidebarFiles(sidebarSourceFiles), [sidebarSourceFiles]);
  const getRepoMarkdownPaths = useCallback(() => listRepoDocFilePaths(repoMarkdownFiles), [repoMarkdownFiles]);
  const getRepoSidebarPaths = useCallback(() => listRepoDocFilePaths(repoSidebarFiles), [repoSidebarFiles]);
  const hasRepoSidebarPath = useCallback(
    (path: string) => hasRepoDocFilePath(repoSidebarFiles, path),
    [repoSidebarFiles],
  );
  const findRepoSidebarFile = useCallback(
    (path: string) => findRepoDocFileByPath(repoSidebarFiles, path),
    [repoSidebarFiles],
  );
  const listRepoSidebarFilesInFolder = useCallback(
    (folderPath: string) => listRepoDocFilesInFolder(repoSidebarFiles, folderPath),
    [repoSidebarFiles],
  );
  const resetRepoState = useCallback(() => {
    setRepoMarkdownFiles([]);
    setRepoSidebarFiles([]);
  }, []);
  const replaceRepoSnapshot = useCallback((files: RepoDocFile[], options?: { invalidateTerminal?: boolean }) => {
    setRepoSidebarFiles(files);
    setRepoMarkdownFiles(filterRepoMarkdownFiles(files));
    if (options?.invalidateTerminal !== false) {
      setTerminalSnapshotVersion((current) => current + 1);
    }
  }, []);
  const replaceRepoMarkdownFiles = useCallback((files: RepoDocFile[]) => {
    setRepoMarkdownFiles(files);
  }, []);
  const setSharedRepoFile = useCallback((file: RepoDocFile) => {
    setRepoSidebarFiles([file]);
    setRepoMarkdownFiles(isMarkdownFileName(file.path) ? [file] : []);
  }, []);
  const upsertRepoFile = useCallback((file: RepoDocFile) => {
    setRepoSidebarFiles((current) => upsertRepoDocFile(current, file));
    setRepoMarkdownFiles((current) =>
      isMarkdownFileName(file.path)
        ? upsertRepoDocFile(current, file)
        : current.filter((candidate) => candidate.path !== file.path),
    );
    setTerminalSnapshotVersion((current) => current + 1);
  }, []);
  const updateRepoFile = useCallback((path: string, updates: Partial<Pick<RepoDocFile, 'name' | 'sha' | 'size'>>) => {
    setRepoSidebarFiles((current) => updateRepoDocFile(current, path, updates));
    setRepoMarkdownFiles((current) => updateRepoDocFile(current, path, updates));
    setTerminalSnapshotVersion((current) => current + 1);
  }, []);
  const applyRepoRenames = useCallback((renames: Array<{ from: string; to: string }>) => {
    setRepoSidebarFiles((current) => renameRepoDocFiles(current, renames));
    setRepoMarkdownFiles((current) => renameRepoDocFiles(current, renames));
    setTerminalSnapshotVersion((current) => current + 1);
  }, []);

  return useMemo(
    () => ({
      findRepoSidebarFile,
      getRepoMarkdownPaths,
      getRepoSidebarPaths,
      hasRepoSidebarPath,
      listRepoSidebarFilesInFolder,
      sidebarWorkspaceKey: workspaceIdentity.sidebarWorkspaceKey,
      sidebarFiles,
      sidebarFileCounts,
      terminalSnapshotVersion,
      resetRepoState,
      replaceRepoSnapshot,
      replaceRepoMarkdownFiles,
      setSharedRepoFile,
      upsertRepoFile,
      updateRepoFile,
      applyRepoRenames,
    }),
    [
      applyRepoRenames,
      findRepoSidebarFile,
      getRepoMarkdownPaths,
      getRepoSidebarPaths,
      hasRepoSidebarPath,
      listRepoSidebarFilesInFolder,
      replaceRepoMarkdownFiles,
      replaceRepoSnapshot,
      resetRepoState,
      setSharedRepoFile,
      sidebarFileCounts,
      sidebarFiles,
      terminalSnapshotVersion,
      updateRepoFile,
      upsertRepoFile,
      workspaceIdentity.sidebarWorkspaceKey,
    ],
  );
}
