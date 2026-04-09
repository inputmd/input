import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoDocFile } from '../document_store';
import type { RepoFileEntry } from '../github_app';
import { clearStoredScrollPositions } from '../scroll_positions';
import { isMarkdownFileName } from '../util';
import {
  applyRepoWorkspaceMutationsToDocFiles,
  buildRepoTerminalBaseFiles,
  buildRepoWorkspaceSidebarSourceFiles,
  countRepoWorkspaceSidebarFiles,
  filterRepoMarkdownFiles,
  filterRepoWorkspaceSidebarFiles,
  findRepoRenamedBaseSourcePath as findRenamedBaseSourcePath,
  findRepoDocFileByPath,
  hasRepoDocFilePath,
  listRepoDocFilePaths,
  listRepoDocFilesInFolder,
  removeRepoTerminalBaseFile,
  removeRepoTerminalBaseFiles,
  renameRepoDocFiles,
  renameRepoTerminalBaseFiles,
  resolveRepoWorkspaceBasePath,
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
  const [deletedBaseFilesByPath, setDeletedBaseFilesByPath] = useState<
    Record<string, { source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' }>
  >({});
  const [renamedBaseFilesByFrom, setRenamedBaseFilesByFrom] = useState<
    Record<string, { to: string; source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' }>
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
  const deletedBaseFiles = useMemo(
    () =>
      Object.entries(deletedBaseFilesByPath)
        .map(([path, entry]) => ({
          path,
          source: entry.source,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [deletedBaseFilesByPath],
  );
  const renamedBaseFiles = useMemo(
    () =>
      Object.entries(renamedBaseFilesByFrom)
        .map(([from, entry]) => ({
          from,
          to: entry.to,
          source: entry.source,
        }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    [renamedBaseFilesByFrom],
  );
  const hasOverlayChanges = overlayFiles.length > 0 || deletedBaseFiles.length > 0 || renamedBaseFiles.length > 0;
  const effectiveRepoSidebarFiles = useMemo(
    () =>
      applyRepoWorkspaceMutationsToDocFiles(repoSidebarFiles, {
        overlayFiles,
        deletedBaseFiles,
        renamedBaseFiles,
      }),
    [deletedBaseFiles, overlayFiles, renamedBaseFiles, repoSidebarFiles],
  );
  const effectiveRepoMarkdownFiles = useMemo(
    () =>
      filterRepoMarkdownFiles(
        applyRepoWorkspaceMutationsToDocFiles(repoMarkdownFiles, {
          overlayFiles,
          deletedBaseFiles,
          renamedBaseFiles,
        }),
      ),
    [deletedBaseFiles, overlayFiles, renamedBaseFiles, repoMarkdownFiles],
  );
  const sidebarSourceFiles = useMemo(() => {
    return buildRepoWorkspaceSidebarSourceFiles({
      gistFiles,
      currentFileName,
      repoSidebarFiles: effectiveRepoSidebarFiles,
      currentRepoDocPath,
      scratchSidebarPath,
    });
  }, [currentFileName, currentRepoDocPath, effectiveRepoSidebarFiles, gistFiles, scratchSidebarPath]);

  const sidebarFiles = useMemo(() => {
    return filterRepoWorkspaceSidebarFiles(sidebarSourceFiles, sidebarFileFilter);
  }, [sidebarFileFilter, sidebarSourceFiles]);

  const sidebarFileCounts = useMemo(() => countRepoWorkspaceSidebarFiles(sidebarSourceFiles), [sidebarSourceFiles]);
  const getRepoMarkdownPaths = useCallback(
    () => listRepoDocFilePaths(effectiveRepoMarkdownFiles),
    [effectiveRepoMarkdownFiles],
  );
  const getRepoSidebarPaths = useCallback(
    () => listRepoDocFilePaths(effectiveRepoSidebarFiles),
    [effectiveRepoSidebarFiles],
  );
  const getRepoOverlayPaths = useCallback(() => overlayFiles.map((file) => file.path), [overlayFiles]);
  const getRepoDeletedBasePaths = useCallback(() => deletedBaseFiles.map((file) => file.path), [deletedBaseFiles]);
  const getRepoRenamedBasePaths = useCallback(
    () => renamedBaseFiles.map((file) => ({ from: file.from, to: file.to })),
    [renamedBaseFiles],
  );
  const hasRepoSidebarPath = useCallback(
    (path: string) => hasRepoDocFilePath(effectiveRepoSidebarFiles, path),
    [effectiveRepoSidebarFiles],
  );
  const findBaseRepoSidebarFile = useCallback(
    (path: string) => findRepoDocFileByPath(repoSidebarFiles, path),
    [repoSidebarFiles],
  );
  const findRepoSidebarFile = useCallback(
    (path: string) => findRepoDocFileByPath(effectiveRepoSidebarFiles, path),
    [effectiveRepoSidebarFiles],
  );
  const findRepoRenamedBaseSourcePath = useCallback(
    (path: string) => findRenamedBaseSourcePath(renamedBaseFiles, path),
    [renamedBaseFiles],
  );
  const resolveRepoBasePath = useCallback(
    (path: string) =>
      resolveRepoWorkspaceBasePath({
        path,
        files: repoSidebarFiles,
        overlayFiles,
        deletedBaseFiles,
        renamedBaseFiles,
      }),
    [deletedBaseFiles, overlayFiles, renamedBaseFiles, repoSidebarFiles],
  );
  const listRepoSidebarFilesInFolder = useCallback(
    (folderPath: string) => listRepoDocFilesInFolder(effectiveRepoSidebarFiles, folderPath),
    [effectiveRepoSidebarFiles],
  );
  const resetRepoState = useCallback(() => {
    setRepoMarkdownFiles([]);
    setRepoSidebarFiles([]);
    setOverlayFilesByPath({});
    setDeletedBaseFilesByPath({});
    setRenamedBaseFilesByFrom({});
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
  const clearRepoOverlayFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setOverlayFilesByPath((current) => {
      let next: Record<string, { content: string; source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' }> | null =
        null;
      for (const path of paths) {
        if (!(next ?? current)[path]) continue;
        if (next === null) next = { ...current };
        delete next[path];
      }
      return next ?? current;
    });
  }, []);
  const stageRepoDeletedBaseFile = useCallback(
    (path: string, source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' = 'sidebar') => {
      setDeletedBaseFilesByPath((current) => {
        const existing = current[path];
        if (existing?.source === source) return current;
        return {
          ...current,
          [path]: { source },
        };
      });
    },
    [],
  );
  const clearRepoDeletedBaseFile = useCallback((path: string) => {
    setDeletedBaseFilesByPath((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);
  const clearRepoDeletedBaseFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setDeletedBaseFilesByPath((current) => {
      let next: Record<string, { source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' }> | null = null;
      for (const path of paths) {
        if (!(next ?? current)[path]) continue;
        if (next === null) next = { ...current };
        delete next[path];
      }
      return next ?? current;
    });
  }, []);
  const stageRepoRenamedBaseFile = useCallback(
    (from: string, to: string, source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' = 'sidebar') => {
      setRenamedBaseFilesByFrom((current) => {
        const existing = current[from];
        if (existing?.to === to && existing.source === source) return current;
        return {
          ...current,
          [from]: { to, source },
        };
      });
    },
    [],
  );
  const clearRepoRenamedBaseFile = useCallback((path: string) => {
    setRenamedBaseFilesByFrom((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);
  const clearRepoRenamedBaseFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setRenamedBaseFilesByFrom((current) => {
      let next: Record<string, { to: string; source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai' }> | null = null;
      for (const path of paths) {
        if (!(next ?? current)[path]) continue;
        if (next === null) next = { ...current };
        delete next[path];
      }
      return next ?? current;
    });
  }, []);
  const clearAllRepoOverlayFiles = useCallback(() => {
    setOverlayFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);
  const clearAllRepoWorkspaceChanges = useCallback(() => {
    setOverlayFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
    setDeletedBaseFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
    setRenamedBaseFilesByFrom((current) => (Object.keys(current).length === 0 ? current : {}));
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
  const applyRepoOverlayRenames = useCallback((renames: Array<{ from: string; to: string }>) => {
    if (renames.length === 0) return;
    setOverlayFilesByPath((current) => {
      let next: typeof current | null = null;
      for (const rename of renames) {
        const entry = (next ?? current)[rename.from];
        if (!entry) continue;
        if (next === null) next = { ...current };
        delete next[rename.from];
        next[rename.to] = entry;
      }
      return next ?? current;
    });
  }, []);

  return useMemo(
    () => ({
      findRepoSidebarFile,
      getRepoMarkdownPaths,
      getRepoDeletedBasePaths,
      getRepoOverlayPaths,
      getRepoRenamedBasePaths,
      getRepoSidebarPaths,
      hasRepoSidebarPath,
      hasOverlayChanges,
      findBaseRepoSidebarFile,
      listRepoSidebarFilesInFolder,
      deletedBaseFiles,
      renamedBaseFiles,
      overlayFiles,
      findRepoRenamedBaseSourcePath,
      resolveRepoBasePath,
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
      clearRepoOverlayFiles,
      stageRepoDeletedBaseFile,
      clearRepoDeletedBaseFile,
      clearRepoDeletedBaseFiles,
      stageRepoRenamedBaseFile,
      clearRepoRenamedBaseFile,
      clearRepoRenamedBaseFiles,
      clearAllRepoOverlayFiles,
      clearAllRepoWorkspaceChanges,
      setSharedRepoFile,
      upsertRepoFile,
      updateRepoFile,
      applyRepoRenames,
      applyRepoContentRenames,
      applyRepoOverlayRenames,
    }),
    [
      applyRepoOverlayRenames,
      applyRepoContentRenames,
      applyRepoRenames,
      clearTerminalBaseSnapshot,
      clearAllRepoWorkspaceChanges,
      clearAllRepoOverlayFiles,
      clearRepoDeletedBaseFile,
      clearRepoDeletedBaseFiles,
      clearRepoOverlayFile,
      clearRepoOverlayFiles,
      clearRepoRenamedBaseFile,
      clearRepoRenamedBaseFiles,
      deletedBaseFiles,
      findRepoSidebarFile,
      findBaseRepoSidebarFile,
      findRepoRenamedBaseSourcePath,
      getRepoMarkdownPaths,
      getRepoDeletedBasePaths,
      getRepoOverlayPaths,
      getRepoRenamedBasePaths,
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
      renamedBaseFiles,
      resetRepoState,
      resolveRepoBasePath,
      setRepoFileContent,
      stageRepoDeletedBaseFile,
      stageRepoOverlayFile,
      stageRepoRenamedBaseFile,
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
