import type { WebContainer } from '@webcontainer/api';
import { useCallback, useEffect, useRef } from 'preact/hooks';
import {
  buildTerminalImportDiff,
  type TerminalImportDiff,
  type TerminalImportOptions,
} from '../repo_workspace/terminal_sync.ts';
import type {
  WebContainerTerminalFileDiff,
  WebContainerTerminalImportContext,
  WebContainerTerminalImportOptions,
} from './config.ts';
import { buildManagedFiles, snapshotTerminalTextFiles, writeTextFile } from './filesystem.ts';

interface RefValue<T> {
  current: T;
}

interface UseTerminalWorkspaceSyncOptions {
  baseFiles: Record<string, string>;
  baseFilesReady: boolean;
  fsReady: boolean;
  importFromContainerEnabled: boolean;
  importFromContainerIntervalMs: number | false;
  includeActiveEditPathInImports: boolean;
  liveFileContent: string | null;
  liveFilePath: string | null;
  liveSyncDebounceMs: number;
  onImportDiff?: (
    diff: WebContainerTerminalFileDiff,
    context: WebContainerTerminalImportContext,
  ) => void | Promise<void>;
  registerImportHandler?: (
    handler: ((options?: WebContainerTerminalImportOptions) => Promise<WebContainerTerminalFileDiff | null>) | null,
  ) => void;
  syncToContainerEnabled: boolean;
  unmountedRef: RefValue<boolean>;
  wcRef: RefValue<WebContainer | null>;
  workspaceKeyRef: RefValue<string>;
}

export interface TerminalWorkspaceSync {
  baseFilesRef: RefValue<Record<string, string>>;
  disposeWorkspaceSync: (options?: { importOnUnmount?: boolean }) => void;
  flushManagedSync: () => Promise<void>;
  importTerminalDiff: (
    options?: TerminalImportOptions,
    reason?: WebContainerTerminalImportContext['reason'],
  ) => Promise<TerminalImportDiff | null>;
  liveFileContentRef: RefValue<string | null>;
  liveFilePathRef: RefValue<string | null>;
  replaceManagedFileSnapshot: (files: Record<string, string>) => void;
}

export function useTerminalWorkspaceSync({
  baseFiles,
  baseFilesReady,
  fsReady,
  importFromContainerEnabled,
  importFromContainerIntervalMs,
  includeActiveEditPathInImports,
  liveFileContent,
  liveFilePath,
  liveSyncDebounceMs,
  onImportDiff,
  registerImportHandler,
  syncToContainerEnabled,
  unmountedRef,
  wcRef,
  workspaceKeyRef,
}: UseTerminalWorkspaceSyncOptions): TerminalWorkspaceSync {
  const lastWrittenRef = useRef<Map<string, string>>(new Map());
  const baseFilesRef = useRef(baseFiles);
  baseFilesRef.current = baseFiles;
  const baseFilesReadyRef = useRef(baseFilesReady);
  baseFilesReadyRef.current = baseFilesReady;
  const liveFilePathRef = useRef<string | null>(liveFilePath);
  liveFilePathRef.current = liveFilePath;
  const liveFileContentRef = useRef<string | null>(liveFileContent);
  liveFileContentRef.current = liveFileContent;
  const includeActiveEditPathInImportsRef = useRef(includeActiveEditPathInImports);
  includeActiveEditPathInImportsRef.current = includeActiveEditPathInImports;
  const onImportDiffRef = useRef(onImportDiff);
  onImportDiffRef.current = onImportDiff;
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const liveSyncTimerRef = useRef<number | null>(null);
  const importInFlightRef = useRef<Promise<TerminalImportDiff | null> | null>(null);

  const flushManagedSync = useCallback(async (): Promise<void> => {
    const wc = wcRef.current;
    if (!wc) return;
    if (liveSyncTimerRef.current !== null) {
      window.clearTimeout(liveSyncTimerRef.current);
      liveSyncTimerRef.current = null;
      const pendingPath = liveFilePathRef.current;
      const pendingContent = liveFileContentRef.current;
      if (pendingPath !== null && pendingContent !== null) {
        syncQueueRef.current = syncQueueRef.current.then(async () => {
          if (unmountedRef.current) return;
          try {
            await writeTextFile(wc, pendingPath, pendingContent);
            lastWrittenRef.current.set(pendingPath, pendingContent);
          } catch (err) {
            console.error('[terminal] live sync flush failed', pendingPath, err);
          }
        });
      }
    }
    await syncQueueRef.current;
  }, [unmountedRef, wcRef]);

  const importTerminalDiff = useCallback(
    async (
      options?: TerminalImportOptions,
      reason: WebContainerTerminalImportContext['reason'] = 'manual',
    ): Promise<TerminalImportDiff | null> => {
      if (importInFlightRef.current) return importInFlightRef.current;
      const pendingImport = (async (): Promise<TerminalImportDiff | null> => {
        const wc = wcRef.current;
        if (!wc || !baseFilesReadyRef.current || !onImportDiffRef.current) return null;
        await flushManagedSync();
        const managedFiles = buildManagedFiles(
          baseFilesRef.current,
          liveFilePathRef.current,
          liveFileContentRef.current,
        );
        const actualFiles = await snapshotTerminalTextFiles(wc);
        const diff = buildTerminalImportDiff({
          managedFiles,
          actualFiles,
          activeEditPath: liveFilePathRef.current,
          includeActiveEditPath: includeActiveEditPathInImportsRef.current,
        });
        if (Object.keys(diff.upserts).length === 0 && diff.deletes.length === 0) return null;
        await onImportDiffRef.current(diff, {
          options,
          reason,
          sessionId: workspaceKeyRef.current,
        });
        return diff;
      })();
      importInFlightRef.current = pendingImport;
      try {
        return await pendingImport;
      } finally {
        if (importInFlightRef.current === pendingImport) {
          importInFlightRef.current = null;
        }
      }
    },
    [flushManagedSync, wcRef, workspaceKeyRef],
  );

  const replaceManagedFileSnapshot = useCallback((files: Record<string, string>) => {
    lastWrittenRef.current = new Map(Object.entries(files));
  }, []);

  const disposeWorkspaceSync = useCallback(
    (options?: { importOnUnmount?: boolean }) => {
      if (options?.importOnUnmount) {
        void importTerminalDiff({ silent: true }, 'unmount').catch((err) => {
          console.error('[terminal] import on unmount failed', err);
        });
      } else if (liveSyncTimerRef.current !== null) {
        window.clearTimeout(liveSyncTimerRef.current);
        liveSyncTimerRef.current = null;
      }
      lastWrittenRef.current = new Map();
    },
    [importTerminalDiff],
  );

  useEffect(() => {
    registerImportHandler?.((options) => importTerminalDiff(options, 'manual'));
    return () => {
      registerImportHandler?.(null);
    };
  }, [importTerminalDiff, registerImportHandler]);

  useEffect(() => {
    if (!importFromContainerEnabled || !fsReady || !baseFilesReady || importFromContainerIntervalMs === false) return;
    const intervalId = window.setInterval(() => {
      void importTerminalDiff({ silent: true }, 'interval').catch((err) => {
        console.error('[terminal] background import failed', err);
      });
    }, importFromContainerIntervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [baseFilesReady, fsReady, importFromContainerEnabled, importFromContainerIntervalMs, importTerminalDiff]);

  useEffect(() => {
    if (!syncToContainerEnabled || !fsReady || !baseFilesReady) return;
    const wc = wcRef.current;
    if (!wc) return;
    const previous = lastWrittenRef.current;
    const next = new Map(Object.entries(buildManagedFiles(baseFiles, liveFilePath, liveFileContentRef.current)));
    const writes: Array<[string, string]> = [];
    const removes: string[] = [];
    for (const [path, contents] of next) {
      if (previous.get(path) !== contents) writes.push([path, contents]);
    }
    for (const path of previous.keys()) {
      if (!next.has(path)) removes.push(path);
    }
    if (writes.length === 0 && removes.length === 0) return;
    syncQueueRef.current = syncQueueRef.current.then(async () => {
      if (unmountedRef.current) return;
      for (const path of removes) {
        try {
          await wc.fs.rm(path, { force: true, recursive: true });
          lastWrittenRef.current.delete(path);
        } catch (err) {
          console.error('[terminal] sync rm failed', path, err);
        }
      }
      for (const [path, contents] of writes) {
        try {
          await writeTextFile(wc, path, contents);
          lastWrittenRef.current.set(path, contents);
        } catch (err) {
          console.error('[terminal] sync write failed', path, err);
        }
      }
    });
  }, [baseFiles, baseFilesReady, fsReady, liveFilePath, syncToContainerEnabled, unmountedRef, wcRef]);

  useEffect(() => {
    if (!syncToContainerEnabled || !fsReady || liveFilePath === null || liveFileContent === null) return;
    if (lastWrittenRef.current.get(liveFilePath) === liveFileContent) return;
    const wc = wcRef.current;
    if (!wc) return;
    if (liveSyncTimerRef.current !== null) {
      window.clearTimeout(liveSyncTimerRef.current);
    }
    liveSyncTimerRef.current = window.setTimeout(() => {
      liveSyncTimerRef.current = null;
      syncQueueRef.current = syncQueueRef.current.then(async () => {
        if (unmountedRef.current) return;
        try {
          await writeTextFile(wc, liveFilePath, liveFileContent);
          lastWrittenRef.current.set(liveFilePath, liveFileContent);
        } catch (err) {
          console.error('[terminal] live sync write failed', liveFilePath, err);
        }
      });
    }, liveSyncDebounceMs);
    return () => {
      if (liveSyncTimerRef.current !== null) {
        window.clearTimeout(liveSyncTimerRef.current);
        liveSyncTimerRef.current = null;
      }
    };
  }, [fsReady, liveFileContent, liveFilePath, liveSyncDebounceMs, syncToContainerEnabled, unmountedRef, wcRef]);

  return {
    baseFilesRef,
    disposeWorkspaceSync,
    flushManagedSync,
    importTerminalDiff,
    liveFileContentRef,
    liveFilePathRef,
    replaceManagedFileSnapshot,
  };
}
