import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoDocFile } from '../document_store';
import type { RepoFileEntry } from '../github_app';
import { clearStoredScrollPositions } from '../scroll_positions';
import { isMarkdownFileName } from '../util';
import {
  buildRepoTerminalBaseFiles,
  buildRepoWorkspaceSidebarSourceFiles,
  countRepoWorkspaceSidebarFiles,
  filterRepoMarkdownFiles,
  filterRepoWorkspaceSidebarFiles,
  findRepoDocFileByPath,
  hasRepoDocFilePath,
  listRepoDocFilePaths,
  listRepoDocFilesInFolder,
  removeRepoTerminalBaseFile,
  removeRepoTerminalBaseFiles,
  renameRepoDocFiles,
  renameRepoTerminalBaseFiles,
  setRepoTerminalBaseFile,
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
  const [overlayFilesByPath, setOverlayFilesByPath] = useState<
    Record<string, { content: string; source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' }>
  >({});
  const [terminalSnapshotVersion, setTerminalSnapshotVersion] = useState(0);
  const [terminalBaseSnapshot, setTerminalBaseSnapshot] = useState<{
    key: string;
    files: Record<string, string>;
  } | null>(null);
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
  const overlayFiles = useMemo(
    () =>
      Object.entries(overlayFilesByPath)
        .map(([path, entry]) => ({
          path,
          content: entry.content,
          source: entry.source,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [overlayFilesByPath],
  );
  const hasOverlayChanges = overlayFiles.length > 0;
  const getRepoMarkdownPaths = useCallback(() => listRepoDocFilePaths(repoMarkdownFiles), [repoMarkdownFiles]);
  const getRepoSidebarPaths = useCallback(() => listRepoDocFilePaths(repoSidebarFiles), [repoSidebarFiles]);
  const getRepoOverlayPaths = useCallback(() => overlayFiles.map((file) => file.path), [overlayFiles]);
  const hasRepoSidebarPath = useCallback(
    (path: string) => hasRepoDocFilePath(repoSidebarFiles, path),
    [repoSidebarFiles],
  );
  const findBaseRepoSidebarFile = useCallback(
    (path: string) => findRepoDocFileByPath(repoSidebarFiles, path),
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
    setOverlayFilesByPath({});
    setTerminalBaseSnapshot(null);
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
  const replaceTerminalBaseSnapshot = useCallback(
    (snapshotKey: string, files: RepoFileEntry[] | Record<string, string>) => {
      setTerminalBaseSnapshot({
        key: snapshotKey,
        files: Array.isArray(files) ? buildRepoTerminalBaseFiles(files) : { ...files },
      });
    },
    [],
  );
  const clearTerminalBaseSnapshot = useCallback(() => {
    setTerminalBaseSnapshot(null);
  }, []);
  const setRepoFileContent = useCallback((path: string, content: string) => {
    setTerminalBaseSnapshot((current) =>
      current
        ? {
            ...current,
            files: setRepoTerminalBaseFile(current.files, path, content),
          }
        : current,
    );
  }, []);
  const removeRepoFileContent = useCallback((path: string) => {
    setTerminalBaseSnapshot((current) =>
      current
        ? {
            ...current,
            files: removeRepoTerminalBaseFile(current.files, path),
          }
        : current,
    );
  }, []);
  const removeRepoFileContents = useCallback((paths: string[]) => {
    setTerminalBaseSnapshot((current) =>
      current
        ? {
            ...current,
            files: removeRepoTerminalBaseFiles(current.files, paths),
          }
        : current,
    );
  }, []);
  const stageRepoOverlayFile = useCallback(
    (path: string, content: string, source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' = 'editor') => {
      setOverlayFilesByPath((current) => {
        const existing = current[path];
        if (existing && existing.content === content && existing.source === source) return current;
        return {
          ...current,
          [path]: { content, source },
        };
      });
    },
    [],
  );
  const clearRepoOverlayFile = useCallback((path: string) => {
    setOverlayFilesByPath((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);
  const clearAllRepoOverlayFiles = useCallback(() => {
    setOverlayFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
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
  }, []);
  const updateRepoFile = useCallback((path: string, updates: Partial<Pick<RepoDocFile, 'name' | 'sha' | 'size'>>) => {
    setRepoSidebarFiles((current) => updateRepoDocFile(current, path, updates));
    setRepoMarkdownFiles((current) => updateRepoDocFile(current, path, updates));
  }, []);
  const applyRepoRenames = useCallback((renames: Array<{ from: string; to: string }>) => {
    setRepoSidebarFiles((current) => renameRepoDocFiles(current, renames));
    setRepoMarkdownFiles((current) => renameRepoDocFiles(current, renames));
  }, []);
  const applyRepoContentRenames = useCallback((renames: Array<{ from: string; to: string }>) => {
    setTerminalBaseSnapshot((current) =>
      current
        ? {
            ...current,
            files: renameRepoTerminalBaseFiles(current.files, renames),
          }
        : current,
    );
  }, []);

  return useMemo(
    () => ({
      findRepoSidebarFile,
      getRepoMarkdownPaths,
      getRepoOverlayPaths,
      getRepoSidebarPaths,
      hasRepoSidebarPath,
      hasOverlayChanges,
      findBaseRepoSidebarFile,
      listRepoSidebarFilesInFolder,
      overlayFiles,
      sidebarWorkspaceKey: workspaceIdentity.sidebarWorkspaceKey,
      sidebarFiles,
      sidebarFileCounts,
      terminalBaseFiles: terminalBaseSnapshot?.files ?? {},
      terminalBaseSnapshotKey: terminalBaseSnapshot?.key ?? null,
      terminalSnapshotVersion,
      resetRepoState,
      replaceRepoSnapshot,
      replaceRepoMarkdownFiles,
      replaceTerminalBaseSnapshot,
      clearTerminalBaseSnapshot,
      setRepoFileContent,
      removeRepoFileContent,
      removeRepoFileContents,
      stageRepoOverlayFile,
      clearRepoOverlayFile,
      clearAllRepoOverlayFiles,
      setSharedRepoFile,
      upsertRepoFile,
      updateRepoFile,
      applyRepoRenames,
      applyRepoContentRenames,
    }),
    [
      applyRepoContentRenames,
      applyRepoRenames,
      clearTerminalBaseSnapshot,
      clearAllRepoOverlayFiles,
      clearRepoOverlayFile,
      findRepoSidebarFile,
      findBaseRepoSidebarFile,
      getRepoMarkdownPaths,
      getRepoOverlayPaths,
      getRepoSidebarPaths,
      hasRepoSidebarPath,
      hasOverlayChanges,
      listRepoSidebarFilesInFolder,
      overlayFiles,
      removeRepoFileContent,
      removeRepoFileContents,
      replaceRepoMarkdownFiles,
      replaceRepoSnapshot,
      replaceTerminalBaseSnapshot,
      resetRepoState,
      setRepoFileContent,
      stageRepoOverlayFile,
      setSharedRepoFile,
      sidebarFileCounts,
      sidebarFiles,
      terminalBaseSnapshot,
      terminalSnapshotVersion,
      updateRepoFile,
      upsertRepoFile,
      workspaceIdentity.sidebarWorkspaceKey,
    ],
  );
}
