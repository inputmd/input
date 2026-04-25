import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoDocFile } from '../document_store';
import type { RepoFileEntry } from '../github_app';
import { clearStoredScrollPositions } from '../scroll_positions';
import { isMarkdownFileName } from '../util';
import {
  applyRepoWorkspaceMutationsToDocFiles,
  buildGistRepoDocFiles,
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
import {
  applyTerminalImportDiffToWorkspaceChanges,
  type TerminalImportDiff,
  type TerminalImportedWorkspaceChanges,
} from './terminal_sync';
import type {
  RepoWorkspaceChangeTarget,
  RepoWorkspaceDeletedFile,
  RepoWorkspaceMutationSource,
  RepoWorkspaceOverlayFile,
  RepoWorkspaceRenamedFile,
  RepoWorkspaceState,
  UseRepoWorkspaceArgs,
} from './types';

export function useRepoWorkspace({
  workspaceIdentity,
  gistFiles,
  currentFileName,
  currentRepoDocPath,
  scratchSidebarPath,
  sidebarFileFilter,
  sidebarShowHiddenFiles,
}: UseRepoWorkspaceArgs): RepoWorkspaceState {
  const [repoMarkdownFiles, setRepoMarkdownFiles] = useState<RepoDocFile[]>([]);
  const [repoSidebarFiles, setRepoSidebarFiles] = useState<RepoDocFile[]>([]);
  const [baseSnapshotWorkspaceKey, setBaseSnapshotWorkspaceKey] = useState<string | null>(null);
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
  const gistBaseFiles = useMemo(() => buildGistRepoDocFiles(gistFiles), [gistFiles]);
  const baseRepoSidebarFiles = gistFiles ? gistBaseFiles : repoSidebarFiles;
  const baseRepoMarkdownFiles = gistFiles ? filterRepoMarkdownFiles(gistBaseFiles) : repoMarkdownFiles;
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
  // Mirror the latest workspace-changes records into refs so terminal-import
  // applies (which run inside async callbacks) can read coherent baselines
  // without waiting for React to commit, and so back-to-back applies in the
  // same tick stay consistent. The applyTerminalImportDiffToWorkspace method
  // also writes these refs synchronously.
  const overlayFilesRef = useRef<RepoWorkspaceOverlayFile[]>(overlayFiles);
  const deletedBaseFilesRef = useRef<RepoWorkspaceDeletedFile[]>(deletedBaseFiles);
  const renamedBaseFilesRef = useRef<RepoWorkspaceRenamedFile[]>(renamedBaseFiles);
  useEffect(() => {
    overlayFilesRef.current = overlayFiles;
  }, [overlayFiles]);
  useEffect(() => {
    deletedBaseFilesRef.current = deletedBaseFiles;
  }, [deletedBaseFiles]);
  useEffect(() => {
    renamedBaseFilesRef.current = renamedBaseFiles;
  }, [renamedBaseFiles]);
  const effectiveRepoSidebarFiles = useMemo(
    () =>
      applyRepoWorkspaceMutationsToDocFiles(baseRepoSidebarFiles, {
        overlayFiles,
        deletedBaseFiles,
        renamedBaseFiles,
      }),
    [baseRepoSidebarFiles, deletedBaseFiles, overlayFiles, renamedBaseFiles],
  );
  const effectiveRepoMarkdownFiles = useMemo(
    () =>
      filterRepoMarkdownFiles(
        applyRepoWorkspaceMutationsToDocFiles(baseRepoMarkdownFiles, {
          overlayFiles,
          deletedBaseFiles,
          renamedBaseFiles,
        }),
      ),
    [baseRepoMarkdownFiles, deletedBaseFiles, overlayFiles, renamedBaseFiles],
  );
  const sidebarSourceFiles = useMemo(() => {
    const sourceFiles = gistFiles
      ? buildRepoWorkspaceSidebarSourceFiles({
          gistFiles: null,
          currentFileName,
          repoSidebarFiles: effectiveRepoSidebarFiles,
          currentRepoDocPath: currentFileName,
          scratchSidebarPath,
        })
      : buildRepoWorkspaceSidebarSourceFiles({
          gistFiles,
          currentFileName,
          repoSidebarFiles: effectiveRepoSidebarFiles,
          currentRepoDocPath,
          scratchSidebarPath,
        });

    const overlayPaths = new Set(overlayFiles.map((file) => file.path));
    const basePaths = new Set(baseRepoSidebarFiles.map((file) => file.path));
    const renamedBasePathByTarget = new Map(renamedBaseFiles.map((file) => [file.to, file.from]));

    return sourceFiles.map((file) => {
      if (file.virtual) return file;
      if (overlayPaths.has(file.path)) {
        return {
          ...file,
          changeState: (basePaths.has(file.path) || renamedBasePathByTarget.has(file.path) ? 'modified' : 'new') as
            | 'modified'
            | 'new',
        };
      }
      if (renamedBasePathByTarget.has(file.path)) {
        return {
          ...file,
          changeState: 'modified' as const,
        };
      }
      return file;
    });
  }, [
    currentFileName,
    currentRepoDocPath,
    effectiveRepoSidebarFiles,
    gistFiles,
    baseRepoSidebarFiles,
    overlayFiles,
    renamedBaseFiles,
    scratchSidebarPath,
  ]);

  const sidebarFiles = useMemo(() => {
    return filterRepoWorkspaceSidebarFiles(sidebarSourceFiles, sidebarFileFilter, sidebarShowHiddenFiles);
  }, [sidebarFileFilter, sidebarShowHiddenFiles, sidebarSourceFiles]);

  const sidebarFileCounts = useMemo(
    () => countRepoWorkspaceSidebarFiles(sidebarSourceFiles, sidebarShowHiddenFiles),
    [sidebarShowHiddenFiles, sidebarSourceFiles],
  );
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
    (path: string) => findRepoDocFileByPath(baseRepoSidebarFiles, path),
    [baseRepoSidebarFiles],
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
        files: baseRepoSidebarFiles,
        overlayFiles,
        deletedBaseFiles,
        renamedBaseFiles,
      }),
    [baseRepoSidebarFiles, deletedBaseFiles, overlayFiles, renamedBaseFiles],
  );
  const listRepoSidebarFilesInFolder = useCallback(
    (folderPath: string) => listRepoDocFilesInFolder(effectiveRepoSidebarFiles, folderPath),
    [effectiveRepoSidebarFiles],
  );
  const resetRepoState = useCallback(() => {
    overlayFilesRef.current = [];
    deletedBaseFilesRef.current = [];
    renamedBaseFilesRef.current = [];
    setRepoMarkdownFiles([]);
    setRepoSidebarFiles([]);
    setBaseSnapshotWorkspaceKey(null);
    setOverlayFilesByPath({});
    setDeletedBaseFilesByPath({});
    setRenamedBaseFilesByFrom({});
    setTerminalBaseSnapshot(null);
  }, []);
  const replaceRepoSnapshot = useCallback(
    (files: RepoDocFile[], options?: { invalidateTerminal?: boolean }) => {
      setRepoSidebarFiles(files);
      setRepoMarkdownFiles(filterRepoMarkdownFiles(files));
      setBaseSnapshotWorkspaceKey(workspaceIdentity.sidebarWorkspaceKey);
      if (options?.invalidateTerminal !== false) {
        setTerminalSnapshotVersion((current) => current + 1);
      }
    },
    [workspaceIdentity.sidebarWorkspaceKey],
  );
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
  // When an overlay entry is cleared, its content is automatically absorbed
  // into the terminal base snapshot so the auto-import diff doesn't re-stage
  // the file from the WebContainer (which still has it).
  const clearRepoOverlayFile = useCallback((path: string) => {
    const entry = overlayFilesRef.current.find((f) => f.path === path);
    if (entry) {
      setTerminalBaseSnapshot((snapshot) =>
        snapshot ? { ...snapshot, files: setRepoTerminalBaseFile(snapshot.files, path, entry.content) } : snapshot,
      );
    }
    setOverlayFilesByPath((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);
  const clearRepoOverlayFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    const currentOverlay = overlayFilesRef.current;
    setTerminalBaseSnapshot((snapshot) => {
      if (!snapshot) return snapshot;
      let files = snapshot.files;
      let changed = false;
      for (const path of paths) {
        const entry = currentOverlay.find((f) => f.path === path);
        if (entry) {
          files = setRepoTerminalBaseFile(files, path, entry.content);
          changed = true;
        }
      }
      return changed ? { ...snapshot, files } : snapshot;
    });
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
    const currentOverlay = overlayFilesRef.current;
    if (currentOverlay.length > 0) {
      setTerminalBaseSnapshot((snapshot) => {
        if (!snapshot) return snapshot;
        let files = snapshot.files;
        for (const entry of currentOverlay) {
          files = setRepoTerminalBaseFile(files, entry.path, entry.content);
        }
        return { ...snapshot, files };
      });
    }
    setOverlayFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);
  const getWorkspaceChangesSnapshot = useCallback(
    (): {
      overlayFiles: RepoWorkspaceOverlayFile[];
      deletedBaseFiles: RepoWorkspaceDeletedFile[];
      renamedBaseFiles: RepoWorkspaceRenamedFile[];
    } => ({
      overlayFiles: overlayFilesRef.current,
      deletedBaseFiles: deletedBaseFilesRef.current,
      renamedBaseFiles: renamedBaseFilesRef.current,
    }),
    [],
  );
  const applyTerminalImportDiffToWorkspace = useCallback(
    (diff: TerminalImportDiff, resolveBasePath: (path: string) => string | null): TerminalImportedWorkspaceChanges => {
      const result = applyTerminalImportDiffToWorkspaceChanges({
        overlayFiles: overlayFilesRef.current,
        deletedBaseFiles: deletedBaseFilesRef.current,
        renamedBaseFiles: renamedBaseFilesRef.current,
        diff,
        resolveRepoBasePath: resolveBasePath,
      });
      // Update refs synchronously so back-to-back applies in the same tick
      // see each other's effects without waiting for React commit.
      overlayFilesRef.current = result.overlayFiles;
      deletedBaseFilesRef.current = result.deletedBaseFiles;
      renamedBaseFilesRef.current = result.renamedBaseFiles;
      // Convert back to records and dispatch state updates. React 18
      // automatic batching collapses these three setters into one render.
      const overlayRecord: Record<string, { content: string; source: RepoWorkspaceMutationSource }> = {};
      for (const file of result.overlayFiles) {
        overlayRecord[file.path] = { content: file.content, source: file.source };
      }
      const deletedRecord: Record<string, { source: RepoWorkspaceMutationSource }> = {};
      for (const file of result.deletedBaseFiles) {
        deletedRecord[file.path] = { source: file.source };
      }
      const renamedRecord: Record<string, { to: string; source: RepoWorkspaceMutationSource }> = {};
      for (const file of result.renamedBaseFiles) {
        renamedRecord[file.from] = { to: file.to, source: file.source };
      }
      setOverlayFilesByPath(overlayRecord);
      setDeletedBaseFilesByPath(deletedRecord);
      setRenamedBaseFilesByFrom(renamedRecord);
      return result;
    },
    [],
  );
  const clearAllRepoWorkspaceChanges = useCallback(() => {
    // Absorb overlay state into the terminal base snapshot so the auto-import
    // diff sees managed == actual and produces no new entries.
    const currentOverlay = overlayFilesRef.current;
    const currentDeleted = deletedBaseFilesRef.current;
    if (currentOverlay.length > 0 || currentDeleted.length > 0) {
      setTerminalBaseSnapshot((snapshot) => {
        if (!snapshot) return snapshot;
        let files = snapshot.files;
        // Overlay upserts: the WebContainer has these files — accept them.
        for (const entry of currentOverlay) {
          files = setRepoTerminalBaseFile(files, entry.path, entry.content);
        }
        // Deleted base files: the WebContainer no longer has them — remove.
        for (const entry of currentDeleted) {
          files = removeRepoTerminalBaseFile(files, entry.path);
        }
        return { ...snapshot, files };
      });
    }
    overlayFilesRef.current = [];
    deletedBaseFilesRef.current = [];
    renamedBaseFilesRef.current = [];
    setOverlayFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
    setDeletedBaseFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
    setRenamedBaseFilesByFrom((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);
  const discardRepoWorkspaceChange = useCallback((change: RepoWorkspaceChangeTarget) => {
    const overlayPaths = new Set<string>();
    const deletedPaths = new Set<string>();
    const renamedSourcePaths = new Set<string>();

    switch (change.changeType) {
      case 'create':
      case 'update':
        overlayPaths.add(change.path);
        break;
      case 'delete':
        deletedPaths.add(change.path);
        break;
      case 'rename':
        renamedSourcePaths.add(change.fromPath ?? change.path);
        break;
    }

    const currentOverlay = overlayFilesRef.current;
    const currentDeleted = deletedBaseFilesRef.current;
    if (overlayPaths.size > 0 || deletedPaths.size > 0) {
      setTerminalBaseSnapshot((snapshot) => {
        if (!snapshot) return snapshot;
        let files = snapshot.files;
        let changed = false;
        for (const entry of currentOverlay) {
          if (!overlayPaths.has(entry.path)) continue;
          files = setRepoTerminalBaseFile(files, entry.path, entry.content);
          changed = true;
        }
        for (const entry of currentDeleted) {
          if (!deletedPaths.has(entry.path)) continue;
          files = removeRepoTerminalBaseFile(files, entry.path);
          changed = true;
        }
        return changed ? { ...snapshot, files } : snapshot;
      });
    }

    if (overlayPaths.size > 0) {
      overlayFilesRef.current = overlayFilesRef.current.filter((file) => !overlayPaths.has(file.path));
      setOverlayFilesByPath((current) => {
        let next: typeof current | null = null;
        for (const path of overlayPaths) {
          if (!(next ?? current)[path]) continue;
          if (next === null) next = { ...current };
          delete next[path];
        }
        return next ?? current;
      });
    }
    if (deletedPaths.size > 0) {
      deletedBaseFilesRef.current = deletedBaseFilesRef.current.filter((file) => !deletedPaths.has(file.path));
      setDeletedBaseFilesByPath((current) => {
        let next: typeof current | null = null;
        for (const path of deletedPaths) {
          if (!(next ?? current)[path]) continue;
          if (next === null) next = { ...current };
          delete next[path];
        }
        return next ?? current;
      });
    }
    if (renamedSourcePaths.size > 0) {
      renamedBaseFilesRef.current = renamedBaseFilesRef.current.filter((file) => !renamedSourcePaths.has(file.from));
      setRenamedBaseFilesByFrom((current) => {
        let next: typeof current | null = null;
        for (const path of renamedSourcePaths) {
          if (!(next ?? current)[path]) continue;
          if (next === null) next = { ...current };
          delete next[path];
        }
        return next ?? current;
      });
    }
  }, []);
  const discardAllRepoWorkspaceChanges = useCallback(() => {
    overlayFilesRef.current = [];
    deletedBaseFilesRef.current = [];
    renamedBaseFilesRef.current = [];
    setOverlayFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
    setDeletedBaseFilesByPath((current) => (Object.keys(current).length === 0 ? current : {}));
    setRenamedBaseFilesByFrom((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);
  const restoreRepoWorkspaceChanges = useCallback(
    ({
      overlayFiles,
      deletedBaseFiles,
      renamedBaseFiles,
    }: {
      overlayFiles: RepoWorkspaceOverlayFile[];
      deletedBaseFiles: RepoWorkspaceDeletedFile[];
      renamedBaseFiles: RepoWorkspaceRenamedFile[];
    }) => {
      overlayFilesRef.current = overlayFiles;
      deletedBaseFilesRef.current = deletedBaseFiles;
      renamedBaseFilesRef.current = renamedBaseFiles;

      const overlayRecord: Record<string, { content: string; source: RepoWorkspaceMutationSource }> = {};
      for (const file of overlayFiles) {
        overlayRecord[file.path] = { content: file.content, source: file.source };
      }
      const deletedRecord: Record<string, { source: RepoWorkspaceMutationSource }> = {};
      for (const file of deletedBaseFiles) {
        deletedRecord[file.path] = { source: file.source };
      }
      const renamedRecord: Record<string, { to: string; source: RepoWorkspaceMutationSource }> = {};
      for (const file of renamedBaseFiles) {
        renamedRecord[file.from] = { to: file.to, source: file.source };
      }

      setOverlayFilesByPath(overlayRecord);
      setDeletedBaseFilesByPath(deletedRecord);
      setRenamedBaseFilesByFrom(renamedRecord);
    },
    [],
  );
  const previousWorkspaceKeyRef = useRef(workspaceIdentity.sidebarWorkspaceKey);
  useEffect(() => {
    if (previousWorkspaceKeyRef.current === workspaceIdentity.sidebarWorkspaceKey) return;
    previousWorkspaceKeyRef.current = workspaceIdentity.sidebarWorkspaceKey;
    discardAllRepoWorkspaceChanges();
    setTerminalBaseSnapshot(null);
  }, [discardAllRepoWorkspaceChanges, workspaceIdentity.sidebarWorkspaceKey]);
  const setSharedRepoFile = useCallback(
    (file: RepoDocFile) => {
      setRepoSidebarFiles([file]);
      setRepoMarkdownFiles(isMarkdownFileName(file.path) ? [file] : []);
      setBaseSnapshotWorkspaceKey(workspaceIdentity.sidebarWorkspaceKey);
    },
    [workspaceIdentity.sidebarWorkspaceKey],
  );
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
      baseSnapshotWorkspaceKey,
      terminalSnapshotVersion,
      resetRepoState,
      replaceRepoSnapshot,
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
      discardRepoWorkspaceChange,
      discardAllRepoWorkspaceChanges,
      restoreRepoWorkspaceChanges,
      getWorkspaceChangesSnapshot,
      applyTerminalImportDiffToWorkspace,
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
      applyTerminalImportDiffToWorkspace,
      clearTerminalBaseSnapshot,
      clearAllRepoWorkspaceChanges,
      discardRepoWorkspaceChange,
      clearAllRepoOverlayFiles,
      discardAllRepoWorkspaceChanges,
      restoreRepoWorkspaceChanges,
      getWorkspaceChangesSnapshot,
      clearRepoDeletedBaseFile,
      clearRepoDeletedBaseFiles,
      clearRepoOverlayFile,
      clearRepoOverlayFiles,
      clearRepoRenamedBaseFile,
      clearRepoRenamedBaseFiles,
      baseSnapshotWorkspaceKey,
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
