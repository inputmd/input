import type { WebContainer } from '@webcontainer/api';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { PersistedHomeInspectionSnapshot } from '../persisted_home_state.ts';
import type { PersistedHomeTransitionReason } from '../repo_workspace/persisted_home_trust.ts';
import {
  buildTerminalImportDiff,
  type TerminalImportDiff,
  type TerminalImportOptions,
} from '../repo_workspace/terminal_sync.ts';
import { WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL } from '../webcontainer_home_overlay.ts';
import type { WebContainerHostBridgeSession } from '../webcontainer_host_bridge.ts';
import type {
  WebContainerTerminalConfig,
  WebContainerTerminalImportContext,
  WebContainerTerminalPaneId,
  WebContainerTerminalPersistedHomePrompt,
} from './config.ts';
import {
  buildManagedFiles,
  DEFAULT_AUTO_IMPORT_INTERVAL_MS,
  DEFAULT_LIVE_FILE_DEBOUNCE_MS,
  snapshotTerminalTextFiles,
  writeTextFile,
} from './filesystem.ts';
import { readPersistedHomeEntriesForWorkspace } from './provisioning.ts';
import {
  didRecentHotReload,
  ensureWebContainerApiConfigured,
  getDocumentThemeMode,
  isLocalhostHostname,
  type TerminalThemeMode,
} from './runtime_shared.ts';
import { otherPaneId, type PaneId, useTerminalPaneManager } from './useTerminalPaneManager.ts';
import { type TerminalPersistedHomePromptState, useTerminalPersistedHome } from './useTerminalPersistedHome.ts';
import { useWebContainerTerminalSessionRuntime } from './useWebContainerTerminalSessionRuntime.ts';

export interface WebContainerTerminalControllerDialogs {
  showAlert: (message: string) => Promise<void>;
  showPrompt: (message: string, defaultValue?: string) => Promise<string | null>;
}

export interface UseWebContainerTerminalControllerOptions {
  config: WebContainerTerminalConfig;
  dialogs: WebContainerTerminalControllerDialogs;
  visible: boolean;
  workspaceChangesPersisted?: boolean;
  workspaceChangesNotice?: string | null;
}

export interface WebContainerTerminalPersistenceDialogState {
  error: string | null;
  loading: boolean;
  open: boolean;
  snapshot: PersistedHomeInspectionSnapshot | null;
}

export interface WebContainerTerminalController {
  activePaneId: WebContainerTerminalPaneId;
  actions: {
    closePersistenceDialog: () => void;
    closePersistedHomePrompt: () => void;
    closeSplitPane: (position: 'top' | 'bottom') => void;
    downloadFromWebContainer: () => Promise<void>;
    openPersistedHomeReconfigurePrompt: () => void;
    openPersistenceDialog: () => Promise<void>;
    openSplitTerminal: () => void;
    restartShell: () => Promise<void>;
    restartWebContainer: () => Promise<void>;
    selectPane: (paneId: WebContainerTerminalPaneId) => void;
    setPaneContainer: (paneId: WebContainerTerminalPaneId, node: HTMLDivElement | null) => void;
    settlePersistedHomePrompt: (restorePersistedHome: boolean) => void;
  };
  canDownloadFromWebContainer: boolean;
  canManageSplit: boolean;
  canResetTerminal: boolean;
  canRestartWebContainer: boolean;
  error: string | null;
  persistedHomePromptState: TerminalPersistedHomePromptState | null;
  persistenceDialog: WebContainerTerminalPersistenceDialogState;
  resetBannerPaneId: WebContainerTerminalPaneId | null;
  resetBannerText: string | null;
  splitOpen: boolean;
  status: {
    credentialSyncLabel: string;
    credentialSyncMenuNote: string;
    networkingLabel: string;
  };
  visiblePaneIds: WebContainerTerminalPaneId[];
  workspaceNotice: {
    dismiss: () => void;
    message: string | null;
    visible: boolean;
  };
}

export function useWebContainerTerminalController({
  config,
  dialogs,
  visible,
  workspaceChangesPersisted = true,
  workspaceChangesNotice = null,
}: UseWebContainerTerminalControllerOptions): WebContainerTerminalController {
  const workspaceKey = config.session.id;
  const workdirName = config.session.workdirName;
  const apiKey = config.session.apiKey;
  const autostart = config.session.autostart ?? true;
  const baseFiles = config.files.base;
  const baseFilesReady = config.files.ready;
  const baseFilesLoadError = config.files.baseLoadError ?? null;
  const liveFile = config.files.live ?? null;
  const importFromContainerConfig = config.files.importFromContainer;
  const syncToContainerConfig = config.files.syncToContainer;
  const persistedHomeConfig = config.persistedHome === false ? null : config.persistedHome;
  const persistedHomeMode = persistedHomeConfig?.mode ?? (persistedHomeConfig ? 'ask' : 'off');
  const includeActiveEditPathInImports = importFromContainerConfig?.includeLiveFile ?? false;
  const onImportDiff = importFromContainerConfig?.onDiff;
  const registerImportHandler = importFromContainerConfig?.registerHandler;
  const persistedHomeTrustPrompt: WebContainerTerminalPersistedHomePrompt | null = persistedHomeConfig?.prompt ?? null;
  const onToggleVisibilityShortcut = config.shortcuts?.onToggleVisibility;
  const overlayEnabled = config.overlay !== false && (config.overlay?.enabled ?? true);
  const overlayArchiveUrl =
    config.overlay === false
      ? WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL
      : (config.overlay?.archiveUrl ?? WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL);
  const networkEnabled = config.network !== false && (config.network?.enabled ?? true);
  const upstreamProxyBaseUrl =
    config.network === false ? '/api/upstream-proxy' : (config.network?.upstreamProxyBaseUrl ?? '/api/upstream-proxy');
  const importFromContainerEnabled = importFromContainerConfig?.enabled ?? Boolean(onImportDiff);
  const importFromContainerIntervalMs = importFromContainerConfig?.intervalMs ?? DEFAULT_AUTO_IMPORT_INTERVAL_MS;
  const liveSyncDebounceMs = syncToContainerConfig?.debounceMs ?? DEFAULT_LIVE_FILE_DEBOUNCE_MS;
  const syncToContainerEnabled = syncToContainerConfig?.enabled ?? true;
  const importOnUnmount = config.lifecycle?.importOnUnmount ?? true;
  const stopOnUnmount = config.lifecycle?.stopOnUnmount ?? true;
  const maxPaneCount = config.panes?.max ?? 2;
  const [error, setError] = useState<string | null>(null);
  const [dismissedWorkspaceNoticeKey, setDismissedWorkspaceNoticeKey] = useState<string | null>(null);
  const [terminalThemeMode, setTerminalThemeMode] = useState<TerminalThemeMode>(() => getDocumentThemeMode());
  const startedRef = useRef(false);
  const hostBridgeRef = useRef<WebContainerHostBridgeSession | null>(null);
  const unmountedRef = useRef(false);
  const wcRef = useRef<WebContainer | null>(null);
  const lastWrittenRef = useRef<Map<string, string>>(new Map());
  const baseFilesRef = useRef(baseFiles);
  baseFilesRef.current = baseFiles;
  const baseFilesLoadErrorRef = useRef(baseFilesLoadError);
  baseFilesLoadErrorRef.current = baseFilesLoadError;
  const baseFilesReadyRef = useRef(baseFilesReady);
  baseFilesReadyRef.current = baseFilesReady;
  const liveFilePath = liveFile?.path ?? null;
  const liveFileContent = liveFile?.content ?? null;
  const liveFilePathRef = useRef<string | null>(liveFilePath);
  liveFilePathRef.current = liveFilePath;
  const liveFileContentRef = useRef<string | null>(liveFileContent);
  liveFileContentRef.current = liveFileContent;
  const includeActiveEditPathInImportsRef = useRef(includeActiveEditPathInImports);
  includeActiveEditPathInImportsRef.current = includeActiveEditPathInImports;
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const liveSyncTimerRef = useRef<number | null>(null);
  const onImportDiffRef = useRef(onImportDiff);
  onImportDiffRef.current = onImportDiff;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const importInFlightRef = useRef<Promise<TerminalImportDiff | null> | null>(null);
  const restartShellRef = useRef<((paneId?: PaneId, options?: { clearTerminal?: boolean }) => Promise<void>) | null>(
    null,
  );
  const restartWebContainerRef = useRef<
    ((options?: { reason?: PersistedHomeTransitionReason }) => Promise<void>) | null
  >(null);
  const lastAppliedTerminalThemeModeRef = useRef<TerminalThemeMode>(terminalThemeMode);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const syncThemeMode = () => {
      setTerminalThemeMode((current) => {
        const next = getDocumentThemeMode();
        return current === next ? current : next;
      });
    };
    syncThemeMode();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          syncThemeMode();
          break;
        }
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const workspaceNoticeKey =
    !workspaceChangesPersisted && workspaceChangesNotice ? `${workspaceKey}:${workspaceChangesNotice}` : null;

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
  }, []);

  const requestShellRestart = useCallback((paneId: PaneId) => {
    void restartShellRef.current?.(paneId, { clearTerminal: true });
  }, []);

  const {
    activePaneId,
    closeSplitPane,
    disposePaneRuntime,
    ensurePaneSurface,
    fitPane,
    focusPane,
    getPreferredPaneId,
    hideResetBanner,
    openSplitTerminal,
    paneRuntimesRef,
    releaseAllPaneShellSessions,
    releasePaneShellSession,
    renderBaseFilesLoadError,
    resetBannerPaneId,
    resetBannerText,
    resetPaneSurface,
    selectPane,
    setPaneContainer,
    shellReadyByPane,
    singlePaneId,
    spawnShellSession,
    splitOpen,
    visiblePaneIds,
    writeTerminal,
  } = useTerminalPaneManager({
    baseFilesLoadErrorRef,
    flushManagedSync,
    hostBridgeRef,
    initialSplit: config.panes?.initialSplit,
    maxPaneCount,
    onRequestShellRestart: requestShellRestart,
    onToggleVisibilityShortcut,
    terminalThemeMode,
    unmountedRef,
    wcRef,
  });
  const visiblePaneIdsRef = useRef<PaneId[]>(visiblePaneIds);
  visiblePaneIdsRef.current = visiblePaneIds;
  const getPaneRuntime = useCallback((paneId: PaneId) => paneRuntimesRef.current[paneId], [paneRuntimesRef]);

  const {
    capturePersistedHomeState,
    closePersistenceDialog,
    closePersistedHomePrompt,
    credentialSyncEnabled,
    disposePersistedHomePrompt,
    flushPersistedHomeState,
    getPersistedHomeActiveSessionMode,
    openPersistenceDialog,
    openPersistedHomeReconfigurePrompt,
    persistenceDialogError,
    persistenceDialogLoading,
    persistenceDialogOpen,
    persistenceDialogSnapshot,
    persistedHomePromptState,
    releasePersistedHomeSyncSession,
    resolvePersistedHomeMode,
    setPersistedHomeActiveSessionMode,
    setPersistedHomeScriptPath,
    settlePersistedHomePrompt,
    startPersistedHomeSync,
  } = useTerminalPersistedHome({
    focusPane,
    persistedHomeMode,
    persistedHomeTrustPrompt,
    readPersistedHomeEntriesForWorkspace,
    restartWebContainerRef,
    unmountedRef,
    wcRef,
    workspaceKeyRef,
  });

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
    [flushManagedSync],
  );

  const {
    downloadFromWebContainer,
    downloadingPath,
    fsReady,
    hostBridgeError,
    invalidateSessionRuntime,
    releaseHostBridgeSession,
    restartShell: restartShellRuntime,
    restartWebContainer: restartWebContainerRuntime,
    restartingWebContainer,
    resettingShell,
    setFsReady,
    startSession,
    teardownWebContainer,
  } = useWebContainerTerminalSessionRuntime({
    apiKey,
    baseFilesRef,
    capturePersistedHomeState,
    configBootCoep: config.session.boot?.coep,
    configBootReuseInstance: config.session.boot?.reuseBootInstance,
    focusPane,
    getPaneRuntime,
    getPersistedHomeActiveSessionMode,
    getPreferredPaneId,
    hostBridgeRef,
    importTerminalDiff,
    lastWrittenRef,
    liveFileContentRef,
    liveFilePathRef,
    networkEnabled,
    overlayArchiveUrl,
    overlayEnabled,
    releaseAllPaneShellSessions,
    releasePersistedHomeSyncSession,
    resolvePersistedHomeMode,
    resetPaneSurface,
    setPersistedHomeActiveSessionMode,
    setPersistedHomeScriptPath,
    showAlert: dialogs.showAlert,
    showPrompt: dialogs.showPrompt,
    spawnShellSession,
    startPersistedHomeSync,
    unmountedRef,
    upstreamProxyBaseUrl,
    visiblePaneIdsRef,
    wcRef,
    workdirName,
    workspaceKeyRef,
    writeTerminal,
  });

  const credentialSyncStatusLabel =
    credentialSyncEnabled === null
      ? 'Sync loading...'
      : credentialSyncEnabled
        ? 'Credential sync on'
        : 'Credential sync off';
  const networkingStatusLabel = hostBridgeError ? 'Networking error' : 'Networking on';
  const credentialSyncMenuNote =
    credentialSyncEnabled === null
      ? 'Loading...'
      : credentialSyncEnabled
        ? 'Credentials and sessions are automatically synced across terminals.'
        : 'Untrusted repo, credentials and sessions will be deleted on exit.';

  useEffect(() => {
    const previousThemeMode = lastAppliedTerminalThemeModeRef.current;
    lastAppliedTerminalThemeModeRef.current = terminalThemeMode;
    if (previousThemeMode === terminalThemeMode || !startedRef.current) return;
    let cancelled = false;
    void (async () => {
      for (const paneId of ['primary', 'secondary'] as const) {
        const runtime = getPaneRuntime(paneId);
        const hadShell = Boolean(runtime.shell);
        releasePaneShellSession(paneId, { invalidate: true });
        runtime.disposeSurface?.();
        runtime.disposeSurface = null;
        if (!runtime.container) continue;
        await ensurePaneSurface(paneId);
        if (cancelled || unmountedRef.current) return;
        fitPane(paneId);
        if (!fsReady || !hadShell) continue;
        await spawnShellSession(paneId, { clearTerminal: true });
        if (cancelled || unmountedRef.current) return;
      }
      focusPane();
    })();
    return () => {
      cancelled = true;
    };
  }, [
    ensurePaneSurface,
    fitPane,
    focusPane,
    fsReady,
    getPaneRuntime,
    releasePaneShellSession,
    spawnShellSession,
    terminalThemeMode,
  ]);

  const restartShell = useCallback(
    async (paneId?: PaneId, options?: { clearTerminal?: boolean }): Promise<void> => {
      hideResetBanner();
      await restartShellRuntime(paneId, options);
    },
    [hideResetBanner, restartShellRuntime],
  );
  restartShellRef.current = restartShell;

  const restartWebContainer = useCallback(
    async (options?: { reason?: PersistedHomeTransitionReason }): Promise<void> => {
      hideResetBanner();
      await restartWebContainerRuntime(options);
    },
    [hideResetBanner, restartWebContainerRuntime],
  );
  restartWebContainerRef.current = restartWebContainer;

  useEffect(() => {
    if (!persistedHomePromptState) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closePersistedHomePrompt();
      focusPane();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closePersistedHomePrompt, focusPane, persistedHomePromptState]);

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
    if (!splitOpen) {
      disposePaneRuntime(otherPaneId(singlePaneId));
    }
  }, [disposePaneRuntime, singlePaneId, splitOpen]);

  useEffect(() => {
    if (!visible || !baseFilesLoadError) {
      if (!baseFilesLoadError) {
        renderBaseFilesLoadError('primary');
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      const paneId = visiblePaneIdsRef.current[0] ?? 'primary';
      await ensurePaneSurface(paneId);
      if (cancelled || unmountedRef.current) return;
      renderBaseFilesLoadError(paneId);
    })();
    return () => {
      cancelled = true;
    };
  }, [baseFilesLoadError, ensurePaneSurface, renderBaseFilesLoadError, visible]);

  useEffect(() => {
    if (!autostart || !visible || startedRef.current || !baseFilesReady) return;
    if (!apiKey && !isLocalhostHostname()) {
      setError('VITE_WEBCONTAINERS_API_KEY is not set.');
      return;
    }
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
      setError('Page is not cross-origin isolated. WebContainers requires COOP/COEP headers.');
      return;
    }

    setError(null);
    startedRef.current = true;

    void (async () => {
      try {
        await ensureWebContainerApiConfigured(apiKey);
        if (unmountedRef.current) return;
        await ensurePaneSurface(visiblePaneIdsRef.current[0] ?? 'primary');
        if (unmountedRef.current) return;
        await startSession({ clearTerminal: true });
      } catch (err) {
        if (unmountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to start terminal: ${message}`);
        startedRef.current = false;
      }
    })();
  }, [apiKey, autostart, baseFilesReady, ensurePaneSurface, startSession, visible]);

  useEffect(() => {
    if (!visible || !startedRef.current) return;
    let cancelled = false;
    void (async () => {
      for (const paneId of visiblePaneIds) {
        await ensurePaneSurface(paneId);
        if (cancelled || unmountedRef.current) return;
        fitPane(paneId);
      }
      if (fsReady) {
        for (const paneId of visiblePaneIds) {
          const runtime = getPaneRuntime(paneId);
          if (runtime.shell || !runtime.terminal) continue;
          await spawnShellSession(paneId);
          if (cancelled || unmountedRef.current) return;
        }
      }
      focusPane();
    })();
    return () => {
      cancelled = true;
    };
  }, [ensurePaneSurface, fitPane, focusPane, fsReady, getPaneRuntime, spawnShellSession, visible, visiblePaneIds]);

  useEffect(() => {
    if (!visible) return;
    const frameId = window.requestAnimationFrame(() => {
      for (const paneId of visiblePaneIds) {
        fitPane(paneId);
      }
      focusPane();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [fitPane, focusPane, visible, visiblePaneIds]);

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
  }, [baseFiles, liveFilePath, fsReady, baseFilesReady, syncToContainerEnabled]);

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
  }, [fsReady, liveFileContent, liveFilePath, liveSyncDebounceMs, syncToContainerEnabled]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      const skipImportOnUnmount = didRecentHotReload();
      const currentWc = wcRef.current;
      const allowPersistedHomeCapture = getPersistedHomeActiveSessionMode() === 'include';
      if (currentWc && allowPersistedHomeCapture) {
        // Pin the workspace key before the async capture — the ref can drift
        // after unmount if the parent re-renders with a new workspace.
        const targetWorkspaceKey = workspaceKeyRef.current;
        void capturePersistedHomeState(currentWc, { immediate: true, allowPersist: true, targetWorkspaceKey }).finally(
          () => {
            void flushPersistedHomeState({ force: true });
          },
        );
      } else {
        void flushPersistedHomeState({ force: true });
      }
      if (!skipImportOnUnmount && importOnUnmount && importFromContainerEnabled) {
        void importTerminalDiff({ silent: true }, 'unmount').catch((err) => {
          console.error('[terminal] import on unmount failed', err);
        });
      }
      if (liveSyncTimerRef.current !== null) {
        window.clearTimeout(liveSyncTimerRef.current);
        liveSyncTimerRef.current = null;
      }
      hideResetBanner();
      invalidateSessionRuntime();
      setPersistedHomeActiveSessionMode(null);
      disposePersistedHomePrompt();
      releasePersistedHomeSyncSession();
      void releaseHostBridgeSession();
      releaseAllPaneShellSessions({ invalidate: true });
      getPaneRuntime('primary').disposeSurface?.();
      getPaneRuntime('secondary').disposeSurface?.();
      startedRef.current = false;
      if (stopOnUnmount) {
        teardownWebContainer(wcRef.current);
      } else {
        wcRef.current = null;
      }
      setFsReady(false);
      lastWrittenRef.current = new Map();
    };
  }, [
    capturePersistedHomeState,
    disposePersistedHomePrompt,
    flushPersistedHomeState,
    getPersistedHomeActiveSessionMode,
    getPaneRuntime,
    invalidateSessionRuntime,
    importTerminalDiff,
    importFromContainerEnabled,
    importOnUnmount,
    hideResetBanner,
    releaseAllPaneShellSessions,
    releasePersistedHomeSyncSession,
    releaseHostBridgeSession,
    setPersistedHomeActiveSessionMode,
    setFsReady,
    stopOnUnmount,
    teardownWebContainer,
  ]);

  useEffect(() => {
    const handlePageHide = () => {
      const currentWc = wcRef.current;
      if (currentWc) {
        const targetWorkspaceKey = workspaceKeyRef.current;
        void capturePersistedHomeState(currentWc, { immediate: true, targetWorkspaceKey }).finally(() => {
          void flushPersistedHomeState({ force: true });
        });
        return;
      }
      void flushPersistedHomeState({ force: true });
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [capturePersistedHomeState, flushPersistedHomeState]);

  const activeShellReady = shellReadyByPane[activePaneId];
  const activeShellSessionId = getPaneRuntime(activePaneId).shellSessionId;
  const canManageSplit = maxPaneCount > 1 && !error && !restartingWebContainer && !resettingShell;
  const canResetTerminal =
    !error && fsReady && !resettingShell && !restartingWebContainer && (activeShellReady || activeShellSessionId > 0);
  const canRestartWebContainer =
    !error &&
    !resettingShell &&
    !restartingWebContainer &&
    (fsReady || getPaneRuntime('primary').shellSessionId > 0 || getPaneRuntime('secondary').shellSessionId > 0);
  const canDownloadFromWebContainer = !error && fsReady && !restartingWebContainer && !downloadingPath;
  const workspaceNoticeVisible = workspaceNoticeKey !== null && dismissedWorkspaceNoticeKey !== workspaceNoticeKey;
  return {
    activePaneId,
    actions: {
      closePersistenceDialog,
      closePersistedHomePrompt() {
        closePersistedHomePrompt();
        focusPane();
      },
      closeSplitPane,
      async downloadFromWebContainer() {
        await downloadFromWebContainer();
      },
      openPersistedHomeReconfigurePrompt,
      async openPersistenceDialog() {
        await openPersistenceDialog();
      },
      openSplitTerminal,
      async restartShell() {
        await restartShell();
      },
      async restartWebContainer() {
        await restartWebContainer();
      },
      selectPane,
      setPaneContainer,
      settlePersistedHomePrompt,
    },
    canDownloadFromWebContainer,
    canManageSplit,
    canResetTerminal,
    canRestartWebContainer,
    error,
    persistedHomePromptState,
    persistenceDialog: {
      error: persistenceDialogError,
      loading: persistenceDialogLoading,
      open: persistenceDialogOpen,
      snapshot: persistenceDialogSnapshot,
    },
    resetBannerPaneId,
    resetBannerText,
    splitOpen,
    status: {
      credentialSyncLabel: credentialSyncStatusLabel,
      credentialSyncMenuNote,
      networkingLabel: networkingStatusLabel,
    },
    visiblePaneIds,
    workspaceNotice: {
      dismiss() {
        setDismissedWorkspaceNoticeKey(workspaceNoticeKey);
      },
      message: workspaceChangesNotice,
      visible: workspaceNoticeVisible,
    },
  };
}
