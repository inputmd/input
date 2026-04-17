import type { WebContainer } from '@webcontainer/api';
import type { Terminal as GhosttyTerminal } from 'ghostty-web';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { resetTerminalSurface } from '../components/terminal_surface_reset.ts';
import { consumeTerminalPixelWheelDelta } from '../components/terminal_wheel.ts';
import { matchesControlShortcut, shouldBypassTerminalMetaShortcut } from '../keyboard_shortcuts.ts';
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
  fitTerminal,
  getDocumentThemeMode,
  getTerminalTheme,
  isLocalhostHostname,
  loadGhosttyWeb,
  resetBootWebContainerState,
  type TerminalThemeMode,
  waitForNextAnimationFrame,
} from './runtime_shared.ts';
import { type TerminalPersistedHomePromptState, useTerminalPersistedHome } from './useTerminalPersistedHome.ts';

// Ctrl-C/Ctrl-\ don't reliably interrupt processes inside WebContainer
// (upstream bug). As a workaround, a second press warns that a third press
// will reset into a fresh shell.
const CTRL_C_RESET_WINDOW_MS = 1000;
const CTRL_Z_NOTICE_WINDOW_MS = 1000;
const TERMINAL_RESET_BANNER_DURATION_MS = 3000;

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

type SpawnedShell = Awaited<ReturnType<WebContainer['spawn']>>;
const TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'SF Mono Web', 'SF Mono', 'Fira Mono', ui-monospace, Menlo, Monaco, Consolas, monospace";
const TERMINAL_DRAG_RESIZE_INTERVAL_MS = 90;
const TERMINAL_FOLLOW_OUTPUT_LEAVE_THRESHOLD_LINES = 4;
const TERMINAL_FOLLOW_OUTPUT_RESUME_THRESHOLD_LINES = 1;
const LAYOUT_RESIZE_START_EVENT = 'input:layout-resize-start';
const LAYOUT_SETTLED_EVENT = 'input:layout-settled';

type PaneId = WebContainerTerminalPaneId;

interface PaneRuntime {
  container: HTMLDivElement | null;
  terminal: GhosttyTerminal | null;
  shell: SpawnedShell | null;
  shellWriter: WritableStreamDefaultWriter<string> | null;
  shellSessionId: number;
  disposeSurface: (() => void) | null;
}

function otherPaneId(paneId: PaneId): PaneId {
  return paneId === 'primary' ? 'secondary' : 'primary';
}

type ResetKey = 'ctrl-c' | 'ctrl-backslash';

function resetBannerTextForKey(key: ResetKey | null): string {
  return key === 'ctrl-backslash'
    ? 'Press Ctrl-\\ again to reset this terminal'
    : 'Press Ctrl-C again to reset this terminal';
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
  const paneRuntimesRef = useRef<Record<PaneId, PaneRuntime>>({
    primary: {
      container: null,
      terminal: null,
      shell: null,
      shellWriter: null,
      shellSessionId: 0,
      disposeSurface: null,
    },
    secondary: {
      container: null,
      terminal: null,
      shell: null,
      shellWriter: null,
      shellSessionId: 0,
      disposeSurface: null,
    },
  });
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
  const [shellReadyByPane, setShellReadyByPane] = useState<Record<PaneId, boolean>>({
    primary: false,
    secondary: false,
  });
  const shellExitedByPaneRef = useRef<Record<PaneId, boolean>>({
    primary: false,
    secondary: false,
  });
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
  const resetWarningStateRef = useRef<{ paneId: PaneId | null; key: ResetKey | null; stage: 0 | 1 | 2; at: number }>({
    paneId: null,
    key: null,
    stage: 0,
    at: 0,
  });
  const resetBannerTimerRef = useRef<number | null>(null);
  const [resetBannerPaneId, setResetBannerPaneId] = useState<PaneId | null>(null);
  const [resetBannerKey, setResetBannerKey] = useState<ResetKey | null>(null);
  const lastCtrlZNoticeAtRef = useRef<number>(0);
  const restartShellRef = useRef<((paneId?: PaneId, options?: { clearTerminal?: boolean }) => Promise<void>) | null>(
    null,
  );
  const restartWebContainerRef = useRef<
    ((options?: { reason?: PersistedHomeTransitionReason }) => Promise<void>) | null
  >(null);
  const [singlePaneId, setSinglePaneId] = useState<PaneId>('primary');
  const [splitOpen, setSplitOpen] = useState(() => Boolean(config.panes?.initialSplit && maxPaneCount > 1));
  const [activePaneId, setActivePaneId] = useState<PaneId>('primary');
  const followOutputByPaneRef = useRef<Record<PaneId, boolean>>({
    primary: true,
    secondary: true,
  });
  const singlePaneIdRef = useRef(singlePaneId);
  singlePaneIdRef.current = singlePaneId;
  const activePaneIdRef = useRef(activePaneId);
  activePaneIdRef.current = activePaneId;
  const visiblePaneIds = useMemo<PaneId[]>(
    () => (splitOpen ? [singlePaneId, otherPaneId(singlePaneId)] : [singlePaneId]),
    [singlePaneId, splitOpen],
  );
  const visiblePaneIdsRef = useRef<PaneId[]>(visiblePaneIds);
  visiblePaneIdsRef.current = visiblePaneIds;
  const lastBaseFilesLoadErrorRef = useRef<string | null>(null);
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

  const getPreferredPaneId = useCallback((): PaneId => {
    if (visiblePaneIdsRef.current.includes(activePaneIdRef.current)) return activePaneIdRef.current;
    return visiblePaneIdsRef.current[0] ?? 'primary';
  }, []);

  const fitPane = useCallback((paneId: PaneId) => {
    const runtime = paneRuntimesRef.current[paneId];
    if (!runtime.terminal || !runtime.container) return;
    fitTerminal(runtime.terminal, runtime.container);
  }, []);

  const updateFollowOutputState = useCallback((paneId: PaneId, viewportY?: number) => {
    const terminal = paneRuntimesRef.current[paneId].terminal;
    if (!terminal) return;
    const nextViewportY = viewportY ?? terminal.getViewportY();
    const isFollowing = followOutputByPaneRef.current[paneId];
    if (isFollowing) {
      if (nextViewportY >= TERMINAL_FOLLOW_OUTPUT_LEAVE_THRESHOLD_LINES) {
        followOutputByPaneRef.current[paneId] = false;
      }
      return;
    }
    if (nextViewportY <= TERMINAL_FOLLOW_OUTPUT_RESUME_THRESHOLD_LINES) {
      followOutputByPaneRef.current[paneId] = true;
    }
  }, []);

  const setFollowOutput = useCallback((paneId: PaneId, followOutput: boolean) => {
    followOutputByPaneRef.current[paneId] = followOutput;
  }, []);

  const writeTerminal = useCallback(
    (
      paneId: PaneId,
      data: string | Uint8Array,
      options?: {
        forceFollow?: boolean;
        newline?: boolean;
      },
    ) => {
      const terminal = paneRuntimesRef.current[paneId].terminal;
      if (!terminal) return;
      const shouldFollow = options?.forceFollow ?? followOutputByPaneRef.current[paneId];
      const previousViewportY = shouldFollow ? 0 : terminal.getViewportY();
      const previousScrollbackLength = shouldFollow ? 0 : terminal.getScrollbackLength();

      if (options?.newline) {
        terminal.writeln(data);
      } else {
        terminal.write(data);
      }

      if (shouldFollow) {
        followOutputByPaneRef.current[paneId] = true;
        return;
      }

      const nextScrollbackLength = terminal.getScrollbackLength();
      const scrollbackDelta = Math.max(0, nextScrollbackLength - previousScrollbackLength);
      const restoreViewportY = Math.max(
        0,
        Math.min(nextScrollbackLength, Math.round(previousViewportY + scrollbackDelta)),
      );
      if (Math.abs(terminal.getViewportY() - restoreViewportY) > 0.01) {
        terminal.scrollToLine(restoreViewportY);
      }
      updateFollowOutputState(paneId, restoreViewportY);
    },
    [updateFollowOutputState],
  );

  const renderBaseFilesLoadError = useCallback(
    (paneId: PaneId): void => {
      const message = baseFilesLoadErrorRef.current;
      if (!message) {
        lastBaseFilesLoadErrorRef.current = null;
        return;
      }
      if (lastBaseFilesLoadErrorRef.current === message) return;
      const terminal = paneRuntimesRef.current[paneId].terminal;
      if (!terminal) return;
      resetTerminalSurface(terminal);
      setFollowOutput(paneId, true);
      writeTerminal(paneId, `${message}\r\n`, { forceFollow: true });
      lastBaseFilesLoadErrorRef.current = message;
    },
    [setFollowOutput, writeTerminal],
  );

  const focusPane = useCallback(
    (paneId?: PaneId) => {
      const targetPaneId = paneId ?? getPreferredPaneId();
      window.requestAnimationFrame(() => {
        const terminal = paneRuntimesRef.current[targetPaneId].terminal;
        if (!terminal) return;
        try {
          terminal.focus();
        } catch {
          // ignore
        }
      });
    },
    [getPreferredPaneId],
  );

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

  const setShellExited = useCallback((paneId: PaneId, exited: boolean) => {
    shellExitedByPaneRef.current[paneId] = exited;
  }, []);

  const hideResetBanner = useCallback(() => {
    if (resetBannerTimerRef.current !== null) {
      window.clearTimeout(resetBannerTimerRef.current);
      resetBannerTimerRef.current = null;
    }
    setResetBannerPaneId(null);
    setResetBannerKey(null);
  }, []);

  const showResetBanner = useCallback((paneId: PaneId, key: ResetKey) => {
    if (resetBannerTimerRef.current !== null) {
      window.clearTimeout(resetBannerTimerRef.current);
    }
    setResetBannerPaneId(paneId);
    setResetBannerKey(key);
    resetBannerTimerRef.current = window.setTimeout(() => {
      resetBannerTimerRef.current = null;
      setResetBannerPaneId((current) => (current === paneId ? null : current));
      setResetBannerKey(null);
      if (
        resetWarningStateRef.current.paneId === paneId &&
        resetWarningStateRef.current.stage === 2 &&
        Date.now() - resetWarningStateRef.current.at >= TERMINAL_RESET_BANNER_DURATION_MS
      ) {
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
      }
    }, TERMINAL_RESET_BANNER_DURATION_MS);
  }, []);

  const releasePaneShellSession = useCallback(
    (paneId: PaneId, options?: { invalidate?: boolean }) => {
      const runtime = paneRuntimesRef.current[paneId];
      setShellExited(paneId, false);
      if (options?.invalidate) {
        runtime.shellSessionId += 1;
      }
      const shell = runtime.shell;
      runtime.shell = null;
      const shellWriter = runtime.shellWriter;
      runtime.shellWriter = null;
      setShellReadyByPane((current) => ({ ...current, [paneId]: false }));
      if (shell) {
        try {
          shell.kill();
        } catch {
          // ignore
        }
      }
      if (shellWriter) {
        try {
          void shellWriter.close().catch(() => {
            // ignore
          });
        } catch {
          // ignore
        }
        try {
          shellWriter.releaseLock();
        } catch {
          // ignore
        }
      }
    },
    [setShellExited],
  );

  const releaseAllPaneShellSessions = useCallback(
    (options?: { invalidate?: boolean }) => {
      releasePaneShellSession('primary', options);
      releasePaneShellSession('secondary', options);
    },
    [releasePaneShellSession],
  );

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

  const disposePaneRuntime = useCallback(
    (paneId: PaneId) => {
      const runtime = paneRuntimesRef.current[paneId];
      releasePaneShellSession(paneId, { invalidate: true });
      runtime.disposeSurface?.();
      runtime.disposeSurface = null;
      runtime.terminal = null;
      runtime.container = null;
      followOutputByPaneRef.current[paneId] = true;
    },
    [releasePaneShellSession],
  );

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

  const spawnShellSession = useCallback(
    async (
      paneId: PaneId,
      options?: { clearTerminal?: boolean; syncManagedFiles?: boolean; announceReady?: boolean },
    ) => {
      const wc = wcRef.current;
      const runtime = paneRuntimesRef.current[paneId];
      const terminal = runtime.terminal;
      if (!wc || !terminal) {
        throw new Error('Terminal is not ready.');
      }

      if (options?.syncManagedFiles) {
        await flushManagedSync();
      }

      const sessionId = runtime.shellSessionId + 1;
      runtime.shellSessionId = sessionId;
      releasePaneShellSession(paneId);
      setFollowOutput(paneId, true);

      if (options?.clearTerminal) {
        resetTerminalSurface(terminal);
      }

      const spawnedShell = await wc.spawn('jsh', [], {
        env: hostBridgeRef.current?.env,
        terminal: { cols: terminal.cols, rows: terminal.rows },
      });
      if (
        unmountedRef.current ||
        wcRef.current !== wc ||
        paneRuntimesRef.current[paneId] !== runtime ||
        runtime.shellSessionId !== sessionId
      ) {
        try {
          spawnedShell.kill();
        } catch {
          // ignore
        }
        return;
      }

      runtime.shell = spawnedShell;
      runtime.shellWriter = spawnedShell.input.getWriter();
      setShellExited(paneId, false);

      try {
        spawnedShell.resize({ cols: terminal.cols, rows: terminal.rows });
      } catch {
        // some versions don't support resize before first write
      }

      void spawnedShell.output
        .pipeTo(
          new WritableStream({
            write(chunk) {
              if (runtime.shellSessionId !== sessionId) return;
              try {
                writeTerminal(paneId, chunk);
              } catch (err) {
                console.error('[terminal] write failed; chunk dropped', err);
              }
            },
          }),
        )
        .catch((err) => {
          if (runtime.shellSessionId !== sessionId) return;
          console.error('[terminal] output pipe closed', err);
        });

      void spawnedShell.exit.then((exitCode) => {
        if (runtime.shellSessionId !== sessionId) return;
        runtime.shell = null;
        const shellWriter = runtime.shellWriter;
        runtime.shellWriter = null;
        if (shellWriter) {
          try {
            shellWriter.releaseLock();
          } catch {
            // ignore
          }
        }
        setShellReadyByPane((current) => ({ ...current, [paneId]: false }));
        setShellExited(paneId, true);
        hideResetBanner();
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
        try {
          writeTerminal(
            paneId,
            `Shell exited${typeof exitCode === 'number' ? ` (code ${exitCode})` : ''}. Press Ctrl-C twice to restart.`,
            { forceFollow: true, newline: true },
          );
        } catch {
          // ignore
        }
      });

      setShellReadyByPane((current) => ({ ...current, [paneId]: true }));
    },
    [flushManagedSync, hideResetBanner, releasePaneShellSession, setFollowOutput, setShellExited, writeTerminal],
  );

  const handleResetHotkey = useCallback(
    (paneId: PaneId, key: ResetKey): boolean => {
      const now = Date.now();
      const current = resetWarningStateRef.current;
      const shellExited = shellExitedByPaneRef.current[paneId];
      if (shellExited && key !== 'ctrl-c') {
        return false;
      }
      const windowMs = current.stage >= 2 ? TERMINAL_RESET_BANNER_DURATION_MS : CTRL_C_RESET_WINDOW_MS;
      const withinWindow = current.paneId === paneId && current.key === key && now - current.at <= windowMs;

      if (!withinWindow) {
        resetWarningStateRef.current = { paneId, key, stage: 1, at: now };
        showResetBanner(paneId, key);
        return false;
      }

      if (shellExited) {
        hideResetBanner();
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
        void restartShellRef.current?.(paneId, { clearTerminal: true });
        return true;
      }

      hideResetBanner();
      resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
      void restartShellRef.current?.(paneId, { clearTerminal: true });
      return true;
    },
    [hideResetBanner, showResetBanner],
  );

  const ensurePaneSurface = useCallback(
    async (paneId: PaneId): Promise<void> => {
      const runtime = paneRuntimesRef.current[paneId];
      if (runtime.terminal || !runtime.container) return;
      const container = runtime.container;
      const { Terminal, ghostty } = await loadGhosttyWeb();
      if (unmountedRef.current) return;
      if (runtime.terminal) return;
      if (!runtime.container || runtime.container !== container) return;

      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        cursorStyle: 'block',
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 14.5,
        ghostty,
        theme: getTerminalTheme(terminalThemeMode),
      });
      runtime.terminal = terminal;
      terminal.open(container);
      fitTerminal(terminal, container);
      renderBaseFilesLoadError(paneId);
      let pixelWheelRemainder = 0;

      terminal.attachCustomWheelEventHandler((event) => {
        if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
        const charHeight = terminal.renderer?.charHeight ?? 20;
        const nextScroll = consumeTerminalPixelWheelDelta(pixelWheelRemainder, event.deltaY, charHeight);
        pixelWheelRemainder = nextScroll.remainder;
        if (nextScroll.lines !== 0) {
          terminal.scrollLines(nextScroll.lines);
        }
        return true;
      });

      const onMetaKeyDown = (event: KeyboardEvent) => {
        if (matchesControlShortcut(event, 't')) {
          event.preventDefault();
          event.stopPropagation();
          void onToggleVisibilityShortcut?.();
          return;
        }
        if (!shouldBypassTerminalMetaShortcut(event)) return;
        event.stopPropagation();
      };
      container.addEventListener('keydown', onMetaKeyDown, true);

      let resizeFrameId: number | null = null;
      let dragResizeTimeoutId: number | null = null;
      let layoutSettledTimeoutId: number | null = null;
      let layoutResizeActive = false;
      const requestFit = () => {
        if (resizeFrameId !== null) return;
        resizeFrameId = window.requestAnimationFrame(() => {
          resizeFrameId = null;
          fitPane(paneId);
        });
      };
      const scheduleFit = () => {
        if (!layoutResizeActive) {
          requestFit();
          return;
        }
        if (dragResizeTimeoutId !== null || resizeFrameId !== null) return;
        dragResizeTimeoutId = window.setTimeout(() => {
          dragResizeTimeoutId = null;
          requestFit();
        }, TERMINAL_DRAG_RESIZE_INTERVAL_MS);
      };
      const onLayoutResizeStart = () => {
        layoutResizeActive = true;
      };
      const onLayoutSettled = () => {
        layoutResizeActive = false;
        if (dragResizeTimeoutId !== null) {
          window.clearTimeout(dragResizeTimeoutId);
          dragResizeTimeoutId = null;
        }
        requestFit();
        if (layoutSettledTimeoutId !== null) {
          window.clearTimeout(layoutSettledTimeoutId);
        }
        layoutSettledTimeoutId = window.setTimeout(() => {
          layoutSettledTimeoutId = null;
          requestFit();
        }, 80);
      };
      const resizeObserver = new ResizeObserver(() => {
        scheduleFit();
      });
      resizeObserver.observe(container);
      window.addEventListener(LAYOUT_RESIZE_START_EVENT, onLayoutResizeStart);
      window.addEventListener(LAYOUT_SETTLED_EVENT, onLayoutSettled);

      const onDataDispose = terminal.onData((data) => {
        setActivePaneId(paneId);
        if (data === '\x03') {
          if (handleResetHotkey(paneId, 'ctrl-c')) {
            return;
          }
        } else if (data === '\x1c') {
          if (handleResetHotkey(paneId, 'ctrl-backslash')) {
            return;
          }
        } else if (data === '\x1a') {
          resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
          const now = Date.now();
          if (now - lastCtrlZNoticeAtRef.current > CTRL_Z_NOTICE_WINDOW_MS) {
            lastCtrlZNoticeAtRef.current = now;
            try {
              writeTerminal(paneId, '[terminal] Ctrl-Z job control is not supported in this terminal.', {
                newline: true,
              });
            } catch {
              // ignore
            }
          }
          return;
        } else if (resetWarningStateRef.current.paneId === paneId) {
          resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
        }
        const shellWriter = runtime.shellWriter;
        if (!shellWriter) return;
        shellWriter.write(data).catch((err) => {
          console.error('[terminal] input write failed', err);
        });
      });

      const onResizeDispose = terminal.onResize(({ cols, rows }) => {
        const shell = runtime.shell;
        if (!shell) return;
        try {
          shell.resize({ cols, rows });
        } catch {
          // ignore
        }
      });

      const onScrollDispose = terminal.onScroll((viewportY) => {
        updateFollowOutputState(paneId, viewportY);
      });

      runtime.disposeSurface = () => {
        resizeObserver.disconnect();
        if (resizeFrameId !== null) {
          window.cancelAnimationFrame(resizeFrameId);
        }
        if (dragResizeTimeoutId !== null) {
          window.clearTimeout(dragResizeTimeoutId);
        }
        if (layoutSettledTimeoutId !== null) {
          window.clearTimeout(layoutSettledTimeoutId);
        }
        window.removeEventListener(LAYOUT_RESIZE_START_EVENT, onLayoutResizeStart);
        window.removeEventListener(LAYOUT_SETTLED_EVENT, onLayoutSettled);
        onDataDispose.dispose();
        onResizeDispose.dispose();
        onScrollDispose.dispose();
        container.removeEventListener('keydown', onMetaKeyDown, true);
        if (runtime.terminal === terminal) {
          runtime.terminal = null;
        }
        terminal.dispose();
      };
    },
    [
      fitPane,
      handleResetHotkey,
      onToggleVisibilityShortcut,
      renderBaseFilesLoadError,
      terminalThemeMode,
      updateFollowOutputState,
      writeTerminal,
    ],
  );

  useEffect(() => {
    const previousThemeMode = lastAppliedTerminalThemeModeRef.current;
    lastAppliedTerminalThemeModeRef.current = terminalThemeMode;
    if (previousThemeMode === terminalThemeMode || !startedRef.current) return;
    let cancelled = false;
    void (async () => {
      for (const paneId of ['primary', 'secondary'] as const) {
        const runtime = paneRuntimesRef.current[paneId];
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
  }, [ensurePaneSurface, fitPane, focusPane, fsReady, releasePaneShellSession, spawnShellSession, terminalThemeMode]);

  const initializeWebContainerSession = useCallback(
    async (options?: {
      forceReboot?: boolean;
      importBeforeReboot?: boolean;
      clearTerminal?: boolean;
      announceRestart?: boolean;
      persistedHomeTransitionReason?: PersistedHomeTransitionReason;
    }): Promise<void> => {
      const logPaneId = getPreferredPaneId();
      const terminal = paneRuntimesRef.current[logPaneId].terminal;
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
      setShellReadyByPane({ primary: false, secondary: false });

      if (options?.clearTerminal) {
        for (const paneId of visiblePaneIdsRef.current) {
          const paneTerminal = paneRuntimesRef.current[paneId].terminal;
          if (paneTerminal) {
            resetTerminalSurface(paneTerminal);
            setFollowOutput(paneId, true);
          }
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
      setPersistedHomeActiveSessionMode,
      setPersistedHomeScriptPath,
      setFollowOutput,
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
        const terminal = paneRuntimesRef.current[targetPaneId].terminal;
        const wc = wcRef.current;
        if (!terminal || !wc || unmountedRef.current) return;

        hideResetBanner();
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
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
    [focusPane, getPreferredPaneId, hideResetBanner, spawnShellSession, writeTerminal],
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
        if (!paneRuntimesRef.current[getPreferredPaneId()].terminal || unmountedRef.current) return;

        hideResetBanner();
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
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
          const terminal = paneRuntimesRef.current[getPreferredPaneId()].terminal;
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
    [getPreferredPaneId, hideResetBanner, initializeWebContainerSession, writeTerminal],
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

  const openSplitTerminal = useCallback(() => {
    if (splitOpen || maxPaneCount < 2) return;
    const nextPaneId = otherPaneId(singlePaneIdRef.current);
    setSplitOpen(true);
    setActivePaneId(nextPaneId);
  }, [maxPaneCount, splitOpen]);

  const closeSplitPane = useCallback(
    (position: 'top' | 'bottom') => {
      if (!splitOpen) return;
      const topPaneId = singlePaneIdRef.current;
      const bottomPaneId = otherPaneId(topPaneId);
      const removedPaneId = position === 'top' ? topPaneId : bottomPaneId;
      if (resetBannerPaneId === removedPaneId) {
        hideResetBanner();
      }
      if (resetWarningStateRef.current.paneId === removedPaneId) {
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
      }
      if (position === 'top') {
        setSinglePaneId(bottomPaneId);
        setActivePaneId(bottomPaneId);
      } else {
        setActivePaneId(topPaneId);
      }
      setSplitOpen(false);
    },
    [hideResetBanner, resetBannerPaneId, splitOpen],
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
    if (!splitOpen) {
      disposePaneRuntime(otherPaneId(singlePaneId));
      setShellReadyByPane((current) => ({ ...current, [otherPaneId(singlePaneId)]: false }));
    }
  }, [disposePaneRuntime, singlePaneId, splitOpen]);

  useEffect(() => {
    if (!visible || !baseFilesLoadError) {
      if (!baseFilesLoadError) {
        lastBaseFilesLoadErrorRef.current = null;
      }
      return;
    }
    if (lastBaseFilesLoadErrorRef.current === baseFilesLoadError) return;
    let cancelled = false;
    void (async () => {
      await ensurePaneSurface(singlePaneIdRef.current);
      if (cancelled || unmountedRef.current) return;
      renderBaseFilesLoadError(singlePaneIdRef.current);
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
        await ensurePaneSurface(singlePaneIdRef.current);
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
          const runtime = paneRuntimesRef.current[paneId];
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
  }, [ensurePaneSurface, fitPane, focusPane, fsReady, spawnShellSession, visible, visiblePaneIds]);

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
      if (resetBannerTimerRef.current !== null) {
        window.clearTimeout(resetBannerTimerRef.current);
        resetBannerTimerRef.current = null;
      }
      restartInFlightRef.current = null;
      restartWebContainerInFlightRef.current = null;
      webContainerSessionIdRef.current += 1;
      setPersistedHomeActiveSessionMode(null);
      disposePersistedHomePrompt();
      releasePersistedHomeSyncSession();
      void releaseHostBridgeSession();
      releaseAllPaneShellSessions({ invalidate: true });
      paneRuntimesRef.current.primary.disposeSurface?.();
      paneRuntimesRef.current.secondary.disposeSurface?.();
      startedRef.current = false;
      if (stopOnUnmount) {
        teardownWebContainer(wcRef.current);
      } else {
        wcRef.current = null;
      }
      setFsReady(false);
      setShellReadyByPane({ primary: false, secondary: false });
      setResetBannerPaneId(null);
      setResettingShell(false);
      setRestartingWebContainer(false);
      lastWrittenRef.current = new Map();
    };
  }, [
    capturePersistedHomeState,
    disposePersistedHomePrompt,
    flushPersistedHomeState,
    getPersistedHomeActiveSessionMode,
    importTerminalDiff,
    importFromContainerEnabled,
    importOnUnmount,
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
  const activeShellSessionId = paneRuntimesRef.current[activePaneId].shellSessionId;
  const canManageSplit = maxPaneCount > 1 && !error && !restartingWebContainer && !resettingShell;
  const canResetTerminal =
    !error && fsReady && !resettingShell && !restartingWebContainer && (activeShellReady || activeShellSessionId > 0);
  const canRestartWebContainer =
    !error &&
    !resettingShell &&
    !restartingWebContainer &&
    (fsReady ||
      paneRuntimesRef.current.primary.shellSessionId > 0 ||
      paneRuntimesRef.current.secondary.shellSessionId > 0);
  const canDownloadFromWebContainer = !error && fsReady && !restartingWebContainer && !downloadingPath;
  const workspaceNoticeVisible = workspaceNoticeKey !== null && dismissedWorkspaceNoticeKey !== workspaceNoticeKey;
  const setPaneContainer = useCallback((paneId: PaneId, node: HTMLDivElement | null) => {
    paneRuntimesRef.current[paneId].container = node;
  }, []);

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
      selectPane(paneId: PaneId) {
        setActivePaneId(paneId);
      },
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
    resetBannerText: resetBannerPaneId ? resetBannerTextForKey(resetBannerKey) : null,
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
