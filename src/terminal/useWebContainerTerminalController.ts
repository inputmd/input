import type { WebContainer } from '@webcontainer/api';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { PersistedHomeInspectionSnapshot } from '../persisted_home_state.ts';
import type { PersistedHomeTransitionReason } from '../repo_workspace/persisted_home_trust.ts';
import { WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL } from '../webcontainer_home_overlay.ts';
import type { WebContainerHostBridgeSession } from '../webcontainer_host_bridge.ts';
import type {
  WebContainerTerminalConfig,
  WebContainerTerminalPaneId,
  WebContainerTerminalPersistedHomePrompt,
} from './config.ts';
import { DEFAULT_AUTO_IMPORT_INTERVAL_MS, DEFAULT_LIVE_FILE_DEBOUNCE_MS } from './filesystem.ts';
import { readPersistedHomeEntriesForWorkspace } from './provisioning.ts';
import { getDocumentThemeMode, type TerminalThemeMode } from './runtime_shared.ts';
import { useTerminalControllerLifecycle } from './useTerminalControllerLifecycle.ts';
import { type PaneId, useTerminalPaneManager } from './useTerminalPaneManager.ts';
import { type TerminalPersistedHomePromptState, useTerminalPersistedHome } from './useTerminalPersistedHome.ts';
import { useTerminalWorkspaceSync } from './useTerminalWorkspaceSync.ts';
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
  const [fsReady, setFsReady] = useState(false);
  const [terminalThemeMode, setTerminalThemeMode] = useState<TerminalThemeMode>(() => getDocumentThemeMode());
  const startedRef = useRef(false);
  const hostBridgeRef = useRef<WebContainerHostBridgeSession | null>(null);
  const unmountedRef = useRef(false);
  const wcRef = useRef<WebContainer | null>(null);
  const baseFilesLoadErrorRef = useRef(baseFilesLoadError);
  baseFilesLoadErrorRef.current = baseFilesLoadError;
  const liveFilePath = liveFile?.path ?? null;
  const liveFileContent = liveFile?.content ?? null;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
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

  const {
    baseFilesRef,
    disposeWorkspaceSync,
    flushManagedSync,
    importTerminalDiff,
    liveFileContentRef,
    liveFilePathRef,
    replaceManagedFileSnapshot,
  } = useTerminalWorkspaceSync({
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
  });

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

  const {
    downloadFromWebContainer,
    downloadingPath,
    hostBridgeError,
    invalidateSessionRuntime,
    releaseHostBridgeSession,
    restartShell: restartShellRuntime,
    restartWebContainer: restartWebContainerRuntime,
    restartingWebContainer,
    resettingShell,
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
    liveFileContentRef,
    liveFilePathRef,
    networkEnabled,
    overlayArchiveUrl,
    overlayEnabled,
    releaseAllPaneShellSessions,
    releasePersistedHomeSyncSession,
    resolvePersistedHomeMode,
    resetPaneSurface,
    replaceManagedFileSnapshot,
    setPersistedHomeActiveSessionMode,
    setPersistedHomeScriptPath,
    setFsReady,
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

  useTerminalControllerLifecycle({
    apiKey,
    autostart,
    baseFilesLoadError,
    baseFilesReady,
    capturePersistedHomeState,
    closePersistedHomePrompt,
    disposePaneRuntime,
    disposePersistedHomePrompt,
    disposeWorkspaceSync,
    ensurePaneSurface,
    fitPane,
    flushPersistedHomeState,
    focusPane,
    fsReady,
    getPaneRuntime,
    getPersistedHomeActiveSessionMode,
    hideResetBanner,
    importFromContainerEnabled,
    importOnUnmount,
    invalidateSessionRuntime,
    lastAppliedTerminalThemeModeRef,
    persistedHomePromptState,
    releaseAllPaneShellSessions,
    releaseHostBridgeSession,
    releasePaneShellSession,
    releasePersistedHomeSyncSession,
    renderBaseFilesLoadError,
    setError,
    setFsReady,
    setPersistedHomeActiveSessionMode,
    singlePaneId,
    spawnShellSession,
    splitOpen,
    startSession,
    startedRef,
    stopOnUnmount,
    teardownWebContainer,
    terminalThemeMode,
    unmountedRef,
    visible,
    visiblePaneIds,
    visiblePaneIdsRef,
    wcRef,
    workspaceKeyRef,
  });

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
