import type { WebContainer } from '@webcontainer/api';
import { useCallback, useRef, useState } from 'preact/hooks';
import type { PersistedHomeMode, PersistedHomeTransitionReason } from '../../repo_workspace/persisted_home_trust.ts';
import { resolvePersistedHomeSessionTransition } from '../../repo_workspace/persisted_home_trust.ts';
import type { TerminalImportDiff } from '../../repo_workspace/terminal_sync.ts';
import type { WebContainerHostBridgeSession } from '../../webcontainer_host_bridge.ts';
import { startWebContainerHostBridge } from '../../webcontainer_host_bridge.ts';
import type { WebContainerTerminalImportContext, WebContainerTerminalImportOptions } from './config.ts';
import {
  buildFileSystemTree,
  buildManagedFiles,
  clearWorkdir,
  terminalDownloadName,
  triggerBrowserDownload,
} from './filesystem.ts';
import {
  createPersistedHomeSupportFiles,
  createTerminalBootPerfLogger,
  formatTerminalBootError,
  provisionHomeOverlay,
  restorePersistedHomeForWorkspace,
} from './provisioning.ts';
import { bootWebContainer, resetBootWebContainerState, waitForNextAnimationFrame } from './runtime_shared.ts';
import type { PaneId } from './useTerminalPaneManager.ts';

interface RefValue<T> {
  current: T;
}

interface TerminalPaneRuntimeSnapshot {
  disposeSurface: (() => void) | null;
  shell: unknown | null;
  shellSessionId: number;
  terminal: unknown | null;
}

export interface UseWebContainerTerminalSessionRuntimeOptions {
  apiKey?: string;
  baseFilesRef: RefValue<Record<string, string>>;
  capturePersistedHomeState: (
    wc: WebContainer,
    options?: { allowPersist?: boolean; immediate?: boolean; targetWorkspaceKey?: string },
  ) => Promise<void>;
  configBootCoep?: 'credentialless' | 'none';
  configBootReuseInstance?: boolean;
  focusPane: (paneId?: PaneId) => void;
  getPaneRuntime: (paneId: PaneId) => TerminalPaneRuntimeSnapshot;
  getPersistedHomeActiveSessionMode: () => PersistedHomeMode | null;
  getPreferredPaneId: () => PaneId;
  hostBridgeRef: RefValue<WebContainerHostBridgeSession | null>;
  importTerminalDiff: (
    options?: WebContainerTerminalImportOptions,
    reason?: WebContainerTerminalImportContext['reason'],
  ) => Promise<TerminalImportDiff | null>;
  liveFileContentRef: RefValue<string | null>;
  liveFilePathRef: RefValue<string | null>;
  networkEnabled: boolean;
  overlayArchiveUrl: string;
  overlayEnabled: boolean;
  releaseAllPaneShellSessions: (options?: { invalidate?: boolean }) => void;
  releasePersistedHomeSyncSession: () => void;
  resolvePersistedHomeMode: () => Promise<PersistedHomeMode>;
  resetPaneSurface: (paneId: PaneId) => void;
  setPersistedHomeActiveSessionMode: (mode: PersistedHomeMode | null) => void;
  setPersistedHomeScriptPath: (path: string | null) => void;
  setFsReady: (ready: boolean) => void;
  showAlert: (message: string) => Promise<void>;
  showPrompt: (message: string, defaultValue?: string) => Promise<string | null>;
  spawnShellSession: (
    paneId: PaneId,
    options?: { announceReady?: boolean; clearTerminal?: boolean; syncManagedFiles?: boolean },
  ) => Promise<void>;
  startPersistedHomeSync: (wc: WebContainer) => Promise<void>;
  replaceManagedFileSnapshot: (files: Record<string, string>) => void;
  unmountedRef: RefValue<boolean>;
  upstreamProxyBaseUrl: string;
  visiblePaneIdsRef: RefValue<PaneId[]>;
  wcRef: RefValue<WebContainer | null>;
  workdirName: string;
  workspaceKeyRef: RefValue<string>;
  writeTerminal: (
    paneId: PaneId,
    data: string | Uint8Array,
    options?: { forceFollow?: boolean; newline?: boolean },
  ) => void;
}

export interface WebContainerTerminalSessionRuntime {
  downloadFromWebContainer: () => Promise<void>;
  downloadingPath: boolean;
  hostBridgeError: boolean;
  invalidateSessionRuntime: () => void;
  releaseHostBridgeSession: () => Promise<void>;
  restartShell: (paneId?: PaneId, options?: { clearTerminal?: boolean }) => Promise<void>;
  restartWebContainer: (options?: { reason?: PersistedHomeTransitionReason }) => Promise<void>;
  restartingWebContainer: boolean;
  resettingShell: boolean;
  startSession: (options?: {
    announceRestart?: boolean;
    clearTerminal?: boolean;
    forceReboot?: boolean;
    importBeforeReboot?: boolean;
    persistedHomeTransitionReason?: PersistedHomeTransitionReason;
  }) => Promise<void>;
  teardownWebContainer: (wc: WebContainer | null) => void;
}

export function useWebContainerTerminalSessionRuntime({
  apiKey,
  baseFilesRef,
  capturePersistedHomeState,
  configBootCoep,
  configBootReuseInstance,
  focusPane,
  getPaneRuntime,
  getPersistedHomeActiveSessionMode,
  getPreferredPaneId,
  hostBridgeRef,
  importTerminalDiff,
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
  setFsReady,
  showAlert,
  showPrompt,
  spawnShellSession,
  startPersistedHomeSync,
  replaceManagedFileSnapshot,
  unmountedRef,
  upstreamProxyBaseUrl,
  visiblePaneIdsRef,
  wcRef,
  workdirName,
  workspaceKeyRef,
  writeTerminal,
}: UseWebContainerTerminalSessionRuntimeOptions): WebContainerTerminalSessionRuntime {
  const [downloadingPath, setDownloadingPath] = useState(false);
  const [hostBridgeError, setHostBridgeError] = useState(false);
  const [resettingShell, setResettingShell] = useState(false);
  const [restartingWebContainer, setRestartingWebContainer] = useState(false);
  const restartInFlightRef = useRef<Promise<void> | null>(null);
  const restartWebContainerInFlightRef = useRef<Promise<void> | null>(null);
  const webContainerSessionIdRef = useRef(0);

  const invalidateSessionRuntime = useCallback(() => {
    restartInFlightRef.current = null;
    restartWebContainerInFlightRef.current = null;
    webContainerSessionIdRef.current += 1;
  }, []);

  const releaseHostBridgeSession = useCallback(async () => {
    const hostBridge = hostBridgeRef.current;
    hostBridgeRef.current = null;
    await hostBridge?.stop();
  }, [hostBridgeRef]);

  const teardownWebContainer = useCallback(
    (wc: WebContainer | null) => {
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
    },
    [wcRef],
  );

  const startSession = useCallback(
    async (options?: {
      announceRestart?: boolean;
      clearTerminal?: boolean;
      forceReboot?: boolean;
      importBeforeReboot?: boolean;
      persistedHomeTransitionReason?: PersistedHomeTransitionReason;
    }): Promise<void> => {
      const logPaneId = getPreferredPaneId();
      const terminal = getPaneRuntime(logPaneId).terminal;
      if (!terminal) {
        throw new Error('Terminal is not ready.');
      }
      const bootPerf = createTerminalBootPerfLogger(workspaceKeyRef.current, workdirName);
      let bootStatus: 'cancelled' | 'error' | 'ok' = 'ok';
      const previousWorkspaceKey = workspaceKeyRef.current;
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
            coep: configBootCoep,
            reuseBootInstance: configBootReuseInstance,
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

        replaceManagedFileSnapshot(initialFiles);
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
      baseFilesRef,
      capturePersistedHomeState,
      configBootCoep,
      configBootReuseInstance,
      focusPane,
      getPaneRuntime,
      getPersistedHomeActiveSessionMode,
      getPreferredPaneId,
      hostBridgeRef,
      importTerminalDiff,
      liveFileContentRef,
      liveFilePathRef,
      networkEnabled,
      overlayArchiveUrl,
      overlayEnabled,
      replaceManagedFileSnapshot,
      releaseAllPaneShellSessions,
      releaseHostBridgeSession,
      releasePersistedHomeSyncSession,
      resolvePersistedHomeMode,
      resetPaneSurface,
      setPersistedHomeActiveSessionMode,
      setPersistedHomeScriptPath,
      setFsReady,
      spawnShellSession,
      startPersistedHomeSync,
      teardownWebContainer,
      unmountedRef,
      upstreamProxyBaseUrl,
      visiblePaneIdsRef,
      wcRef,
      workdirName,
      workspaceKeyRef,
      writeTerminal,
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
    [focusPane, getPaneRuntime, getPreferredPaneId, spawnShellSession, unmountedRef, wcRef, writeTerminal],
  );

  const restartWebContainer = useCallback(
    async (options?: { reason?: PersistedHomeTransitionReason }): Promise<void> => {
      if (restartWebContainerInFlightRef.current) {
        return await restartWebContainerInFlightRef.current;
      }

      webContainerSessionIdRef.current += 1;

      const pendingRestart = (async () => {
        const targetPaneId = getPreferredPaneId();
        if (!getPaneRuntime(targetPaneId).terminal || unmountedRef.current) return;

        setRestartingWebContainer(true);
        try {
          await startSession({
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
    [getPaneRuntime, getPreferredPaneId, startSession, unmountedRef, writeTerminal],
  );

  const downloadFromWebContainer = useCallback(async (): Promise<void> => {
    const wc = wcRef.current;
    if (!wc) return;
    const requestedPath = await showPrompt('Download path:', '.');
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
      await showAlert(err instanceof Error ? err.message : `Failed to download ${normalizedPath}`);
    } finally {
      setDownloadingPath(false);
    }
  }, [showAlert, showPrompt, wcRef, workdirName]);

  return {
    downloadFromWebContainer,
    downloadingPath,
    hostBridgeError,
    invalidateSessionRuntime,
    releaseHostBridgeSession,
    restartShell,
    restartWebContainer,
    restartingWebContainer,
    resettingShell,
    startSession,
    teardownWebContainer,
  };
}
