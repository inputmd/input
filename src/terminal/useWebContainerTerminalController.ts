import type { WebContainer } from '@webcontainer/api';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { PersistedHomeInspectionSnapshot } from '../persisted_home_state.ts';
import {
  type PersistedHomeTransitionReason,
  resolvePersistedHomeSessionTransition,
} from '../repo_workspace/persisted_home_trust.ts';
import {
  buildTerminalImportDiff,
  type TerminalImportDiff,
  type TerminalImportOptions,
} from '../repo_workspace/terminal_sync.ts';
import { WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL } from '../webcontainer_home_overlay.ts';
import { startWebContainerHostBridge, type WebContainerHostBridgeSession } from '../webcontainer_host_bridge.ts';
import type {
  WebContainerTerminalConfig,
  WebContainerTerminalImportContext,
  WebContainerTerminalPaneId,
  WebContainerTerminalPersistedHomePrompt,
} from './config.ts';
import {
  buildFileSystemTree,
  buildManagedFiles,
  clearWorkdir,
  DEFAULT_AUTO_IMPORT_INTERVAL_MS,
  DEFAULT_LIVE_FILE_DEBOUNCE_MS,
  snapshotTerminalTextFiles,
  terminalDownloadName,
  triggerBrowserDownload,
  writeTextFile,
} from './filesystem.ts';
import {
  createPersistedHomeSupportFiles,
  createTerminalBootPerfLogger,
  formatTerminalBootError,
  provisionHomeOverlay,
  readPersistedHomeEntriesForWorkspace,
  restorePersistedHomeForWorkspace,
} from './provisioning.ts';
import {
  bootWebContainer,
  didRecentHotReload,
  ensureWebContainerApiConfigured,
  getDocumentThemeMode,
  isLocalhostHostname,
  resetBootWebContainerState,
  type TerminalThemeMode,
  waitForNextAnimationFrame,
} from './runtime_shared.ts';
import { otherPaneId, type PaneId, useTerminalPaneManager } from './useTerminalPaneManager.ts';
import { type TerminalPersistedHomePromptState, useTerminalPersistedHome } from './useTerminalPersistedHome.ts';

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
  const [hostBridgeError, setHostBridgeError] = useState(false);
  const [dismissedWorkspaceNoticeKey, setDismissedWorkspaceNoticeKey] = useState<string | null>(null);
  const [terminalThemeMode, setTerminalThemeMode] = useState<TerminalThemeMode>(() => getDocumentThemeMode());
  const startedRef = useRef(false);
  const hostBridgeRef = useRef<WebContainerHostBridgeSession | null>(null);
  const webContainerSessionIdRef = useRef(0);
  const restartInFlightRef = useRef<Promise<void> | null>(null);
  const restartWebContainerInFlightRef = useRef<Promise<void> | null>(null);
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
  const [fsReady, setFsReady] = useState(false);
  const [resettingShell, setResettingShell] = useState(false);
  const [restartingWebContainer, setRestartingWebContainer] = useState(false);
  const onImportDiffRef = useRef(onImportDiff);
  onImportDiffRef.current = onImportDiff;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const importInFlightRef = useRef<Promise<TerminalImportDiff | null> | null>(null);
  const [downloadingPath, setDownloadingPath] = useState(false);
  const showAlertRef = useRef(dialogs.showAlert);
  showAlertRef.current = dialogs.showAlert;
  const showPromptRef = useRef(dialogs.showPrompt);
  showPromptRef.current = dialogs.showPrompt;
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

  const releaseHostBridgeSession = useCallback(async () => {
    const hostBridge = hostBridgeRef.current;
    hostBridgeRef.current = null;
    await hostBridge?.stop();
  }, []);

  const teardownWebContainer = useCallback((wc: WebContainer | null) => {
    if (!wc) {
      resetBootWebContainerState();
      return;
    }
    try {
      wc.teardown();
    } catch (err) {
      console.error('[terminal] webcontainer teardown failed', err);
    } finally {
      if (wcRef.current === wc) {
        wcRef.current = null;
      }
      resetBootWebContainerState();
    }
  }, []);

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

  const initializeWebContainerSession = useCallback(
    async (options?: {
      forceReboot?: boolean;
      importBeforeReboot?: boolean;
      clearTerminal?: boolean;
      announceRestart?: boolean;
      persistedHomeTransitionReason?: PersistedHomeTransitionReason;
    }): Promise<void> => {
      const logPaneId = getPreferredPaneId();
      const terminal = getPaneRuntime(logPaneId).terminal;
      if (!terminal) {
        throw new Error('Terminal is not ready.');
      }
      const bootPerf = createTerminalBootPerfLogger(workspaceKeyRef.current, workdirName);
      let bootStatus: 'cancelled' | 'error' | 'ok' = 'ok';
      // Snapshot the workspace key before any async work so that the previous
      // session's state is persisted under its own key, not the (potentially
      // different) key that workspaceKeyRef points to after a render.
      const previousWorkspaceKey = workspaceKeyRef.current;
      // Claim the session counter before the potentially-blocking trust prompt
      // so that any concurrent invocation will see the updated counter and the
      // stale session can be detected after the await.
      const sessionId = webContainerSessionIdRef.current + 1;
      webContainerSessionIdRef.current = sessionId;
      const configuredPersistedHomeMode = await resolvePersistedHomeMode();
      if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
        bootStatus = 'cancelled';
        return;
      }
      const persistedHomeTransition = resolvePersistedHomeSessionTransition({
        activeSessionMode: getPersistedHomeActiveSessionMode(),
        configuredMode: configuredPersistedHomeMode,
        reason: options?.persistedHomeTransitionReason,
      });
      const includePersistedHomeSync = persistedHomeTransition.includePersistedHomeSync;
      const enableNetworkingBridge = persistedHomeTransition.enableNetworkingBridge;

      const previousWc = wcRef.current;
      restartInFlightRef.current = null;
      releasePersistedHomeSyncSession();
      await releaseHostBridgeSession();
      releaseAllPaneShellSessions({ invalidate: true });
      setFsReady(false);

      if (options?.clearTerminal) {
        for (const paneId of visiblePaneIdsRef.current) {
          resetPaneSurface(paneId);
        }
      }
      if (options?.announceRestart) {
        writeTerminal(logPaneId, 'Restarting...\r\n', { forceFollow: true });
      }

      if (options?.importBeforeReboot && previousWc) {
        try {
          await importTerminalDiff({ silent: true }, 'restart');
          await waitForNextAnimationFrame();
        } catch (err) {
          console.error('[terminal] import before restart failed', err);
        }
      }

      if (previousWc && persistedHomeTransition.captureActiveSessionState) {
        await capturePersistedHomeState(previousWc, {
          immediate: true,
          allowPersist: true,
          targetWorkspaceKey: previousWorkspaceKey,
        });
      }
      setPersistedHomeActiveSessionMode(null);

      if (options?.forceReboot) {
        teardownWebContainer(previousWc);
      }

      try {
        writeTerminal(logPaneId, 'Booting container...\r\n', { forceFollow: true });
        const wc = await bootPerf.measure('bootWebContainer', () =>
          bootWebContainer(apiKey, workdirName, {
            coep: config.session.boot?.coep,
            reuseBootInstance: config.session.boot?.reuseBootInstance,
          }),
        );
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          bootStatus = 'cancelled';
          return;
        }

        await bootPerf.measure('clearWorkspace', () => clearWorkdir(wc));
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          bootStatus = 'cancelled';
          return;
        }

        const initialFilesStartedAt =
          typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
        const initialFiles = buildManagedFiles(
          baseFilesRef.current,
          liveFilePathRef.current,
          liveFileContentRef.current,
        );
        const initialFileCount = Object.keys(initialFiles).length;
        const initialTree = buildFileSystemTree(initialFiles);
        bootPerf.record(
          'prepareWorkspaceTree',
          (typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now()) - initialFilesStartedAt,
          {
            managed_file_count: initialFileCount,
          },
        );

        writeTerminal(logPaneId, 'Mounting workspace files...\r\n', { forceFollow: true });
        try {
          await bootPerf.measure('mountWorkspace', () => wc.mount(initialTree), {
            managed_file_count: initialFileCount,
          });
        } catch (mountErr) {
          console.error('[terminal] initial mount failed', mountErr);
        }
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          bootStatus = 'cancelled';
          return;
        }

        lastWrittenRef.current = new Map(Object.entries(initialFiles));
        wcRef.current = wc;

        if (overlayEnabled && overlayArchiveUrl) {
          try {
            writeTerminal(logPaneId, 'Mounting binaries...\r\n', { forceFollow: true });
            const overlayResult = await provisionHomeOverlay(wc, overlayArchiveUrl, bootPerf);
            bootPerf.record('overlay.summary', 0, { archive_bytes: overlayResult.archiveBytes });
          } catch (err) {
            console.error('[terminal] failed to provision home overlay', err);
            writeTerminal(logPaneId, formatTerminalBootError('[terminal] failed to provision home overlay', err), {
              forceFollow: true,
            });
          }
        }

        try {
          writeTerminal(logPaneId, 'Restoring config files...\r\n', { forceFollow: true });
          const persistedHomeSupport = await bootPerf.measure('persistedHome.prepareSupportFiles', () =>
            createPersistedHomeSupportFiles(wc),
          );
          const { homeDir, scriptPath: persistedHomeScriptPath } = persistedHomeSupport;
          setPersistedHomeScriptPath(persistedHomeScriptPath);
          const persistedHomeResult = await restorePersistedHomeForWorkspace(
            wc,
            workspaceKeyRef.current,
            homeDir,
            persistedHomeScriptPath,
            {
              includePersistedHome: includePersistedHomeSync,
              bootPerf,
            },
          );
          bootPerf.record('persistedHome.summary', 0, { entry_count: persistedHomeResult.entryCount });
        } catch (err) {
          setPersistedHomeScriptPath(null);
          console.error('[terminal] failed to restore managed home state', err);
          writeTerminal(logPaneId, formatTerminalBootError('[terminal] failed to restore managed home state', err), {
            forceFollow: true,
          });
        }
        setPersistedHomeActiveSessionMode(persistedHomeTransition.nextSessionMode);

        if (!includePersistedHomeSync) {
          writeTerminal(logPaneId, 'Credential sync disabled.\r\n', { forceFollow: true });
        }

        if (enableNetworkingBridge && networkEnabled) {
          try {
            writeTerminal(logPaneId, 'Starting networking...\r\n', { forceFollow: true });
            hostBridgeRef.current = await bootPerf.measure('startHostBridge', () =>
              startWebContainerHostBridge({
                onLog(message) {
                  console.error(message);
                  try {
                    writeTerminal(logPaneId, `${message}\r\n`);
                  } catch {
                    // ignore
                  }
                },
                upstreamProxyBaseUrl,
                wc,
              }),
            );
            setHostBridgeError(false);
          } catch (err) {
            console.error('[terminal] failed to start host bridge', err);
            writeTerminal(
              logPaneId,
              `[terminal] failed to start host bridge: ${err instanceof Error ? err.message : String(err)}\r\n`,
              { forceFollow: true },
            );
            setHostBridgeError(true);
          }
        } else {
          setHostBridgeError(false);
          writeTerminal(logPaneId, 'Terminal networking disabled.\r\n', { forceFollow: true });
        }

        await bootPerf.measure(
          'spawnShellSessions',
          async () => {
            for (const [index, paneId] of visiblePaneIdsRef.current.entries()) {
              await spawnShellSession(paneId, { announceReady: index === 0 });
              if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
                bootStatus = 'cancelled';
                return;
              }
            }
          },
          {
            pane_count: visiblePaneIdsRef.current.length,
          },
        );
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          bootStatus = 'cancelled';
          return;
        }

        try {
          await bootPerf.measure('startPersistedHomeWatcher', () => startPersistedHomeSync(wc));
        } catch (err) {
          console.error('[terminal] failed to start managed home state watcher', err);
          writeTerminal(
            logPaneId,
            `[terminal] failed to start managed home state watcher: ${err instanceof Error ? err.message : String(err)}\r\n`,
            { forceFollow: true },
          );
        }

        setFsReady(true);
        focusPane(logPaneId);
      } catch (err) {
        bootStatus = 'error';
        throw err;
      } finally {
        bootPerf.complete(bootStatus, {
          visible_pane_count: visiblePaneIdsRef.current.length,
        });
      }
    },
    [
      apiKey,
      capturePersistedHomeState,
      config.session.boot?.coep,
      config.session.boot?.reuseBootInstance,
      focusPane,
      getPaneRuntime,
      getPersistedHomeActiveSessionMode,
      getPreferredPaneId,
      importTerminalDiff,
      networkEnabled,
      overlayArchiveUrl,
      overlayEnabled,
      releaseAllPaneShellSessions,
      releaseHostBridgeSession,
      releasePersistedHomeSyncSession,
      resolvePersistedHomeMode,
      resetPaneSurface,
      setPersistedHomeActiveSessionMode,
      setPersistedHomeScriptPath,
      spawnShellSession,
      startPersistedHomeSync,
      teardownWebContainer,
      upstreamProxyBaseUrl,
      writeTerminal,
      workdirName,
    ],
  );

  const restartShell = useCallback(
    async (paneId?: PaneId, options?: { clearTerminal?: boolean }): Promise<void> => {
      if (restartInFlightRef.current) {
        return await restartInFlightRef.current;
      }

      const pendingRestart = (async () => {
        const targetPaneId = paneId ?? getPreferredPaneId();
        const terminal = getPaneRuntime(targetPaneId).terminal;
        const wc = wcRef.current;
        if (!terminal || !wc || unmountedRef.current) return;

        hideResetBanner();
        setResettingShell(true);
        try {
          if (!options?.clearTerminal) {
            writeTerminal(targetPaneId, '\r\n', { forceFollow: true });
          }
          await spawnShellSession(targetPaneId, {
            clearTerminal: options?.clearTerminal,
            syncManagedFiles: true,
          });
          focusPane(targetPaneId);
        } catch (err) {
          console.error('[terminal] reset failed', err);
          const message = err instanceof Error ? err.message : String(err);
          try {
            writeTerminal(targetPaneId, `[terminal] failed to reset shell: ${message}`, {
              forceFollow: true,
              newline: true,
            });
          } catch {
            // ignore
          }
        } finally {
          setResettingShell(false);
        }
      })();

      restartInFlightRef.current = pendingRestart;
      try {
        await pendingRestart;
      } finally {
        if (restartInFlightRef.current === pendingRestart) {
          restartInFlightRef.current = null;
        }
      }
    },
    [focusPane, getPaneRuntime, getPreferredPaneId, hideResetBanner, spawnShellSession, writeTerminal],
  );
  restartShellRef.current = restartShell;

  const restartWebContainer = useCallback(
    async (options?: { reason?: PersistedHomeTransitionReason }): Promise<void> => {
      if (restartWebContainerInFlightRef.current) {
        return await restartWebContainerInFlightRef.current;
      }

      // Eagerly invalidate any in-flight boot so its next stale-session check
      // detects that a restart was requested and bails out.
      webContainerSessionIdRef.current += 1;

      const pendingRestart = (async () => {
        const targetPaneId = getPreferredPaneId();
        if (!getPaneRuntime(targetPaneId).terminal || unmountedRef.current) return;

        hideResetBanner();
        setRestartingWebContainer(true);
        try {
          await initializeWebContainerSession({
            clearTerminal: true,
            forceReboot: true,
            importBeforeReboot: true,
            announceRestart: true,
            persistedHomeTransitionReason: options?.reason,
          });
        } catch (err) {
          console.error('[terminal] webcontainer restart failed', err);
          const terminal = getPaneRuntime(getPreferredPaneId()).terminal;
          const message = err instanceof Error ? err.message : String(err);
          if (terminal) {
            try {
              writeTerminal(getPreferredPaneId(), `[terminal] failed to restart WebContainer: ${message}`, {
                forceFollow: true,
                newline: true,
              });
            } catch {
              // ignore
            }
          }
        } finally {
          setRestartingWebContainer(false);
        }
      })();

      restartWebContainerInFlightRef.current = pendingRestart;
      try {
        await pendingRestart;
      } finally {
        if (restartWebContainerInFlightRef.current === pendingRestart) {
          restartWebContainerInFlightRef.current = null;
        }
      }
    },
    [getPaneRuntime, getPreferredPaneId, hideResetBanner, initializeWebContainerSession, writeTerminal],
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

  const downloadFromWebContainer = useCallback(async (): Promise<void> => {
    const wc = wcRef.current;
    if (!wc) return;
    const requestedPath = await showPromptRef.current('Download path:', '.');
    const normalizedPath = requestedPath?.trim();
    if (!normalizedPath) return;

    setDownloadingPath(true);
    try {
      const archiveBytes = await wc.export(normalizedPath, { format: 'zip' });
      const blobBytes = Uint8Array.from(archiveBytes);
      triggerBrowserDownload(
        new Blob([blobBytes], { type: 'application/zip' }),
        terminalDownloadName(normalizedPath, workdirName),
      );
    } catch (err) {
      await showAlertRef.current(err instanceof Error ? err.message : `Failed to download ${normalizedPath}`);
    } finally {
      setDownloadingPath(false);
    }
  }, [workdirName]);

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
        await initializeWebContainerSession({ clearTerminal: true });
      } catch (err) {
        if (unmountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to start terminal: ${message}`);
        startedRef.current = false;
      }
    })();
  }, [apiKey, autostart, baseFilesReady, ensurePaneSurface, initializeWebContainerSession, visible]);

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
      restartInFlightRef.current = null;
      restartWebContainerInFlightRef.current = null;
      webContainerSessionIdRef.current += 1;
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
      setResettingShell(false);
      setRestartingWebContainer(false);
      lastWrittenRef.current = new Map();
    };
  }, [
    capturePersistedHomeState,
    disposePersistedHomePrompt,
    flushPersistedHomeState,
    getPersistedHomeActiveSessionMode,
    getPaneRuntime,
    importTerminalDiff,
    importFromContainerEnabled,
    importOnUnmount,
    hideResetBanner,
    releaseAllPaneShellSessions,
    releasePersistedHomeSyncSession,
    releaseHostBridgeSession,
    setPersistedHomeActiveSessionMode,
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
