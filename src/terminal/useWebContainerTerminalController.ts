import type { WebContainer } from '@webcontainer/api';
import { useCallback, useRef, useState } from 'preact/hooks';
import type { PersistedHomeTransitionReason } from '../repo_workspace/persisted_home_trust.ts';
import type { WebContainerHostBridgeSession } from '../webcontainer_host_bridge.ts';
import { buildWebContainerTerminalController } from './buildWebContainerTerminalController.ts';
import type { UseWebContainerTerminalControllerOptions, WebContainerTerminalController } from './controllerTypes.ts';
import { readPersistedHomeEntriesForWorkspace } from './provisioning.ts';
import { resolveWebContainerTerminalConfig } from './resolveWebContainerTerminalConfig.ts';
import { useTerminalControllerLifecycle } from './useTerminalControllerLifecycle.ts';
import { type PaneId, useTerminalPaneManager } from './useTerminalPaneManager.ts';
import { useTerminalPersistedHome } from './useTerminalPersistedHome.ts';
import { useTerminalThemeMode } from './useTerminalThemeMode.ts';
import { useTerminalWorkspaceSync } from './useTerminalWorkspaceSync.ts';
import { useWebContainerTerminalSessionRuntime } from './useWebContainerTerminalSessionRuntime.ts';

export type {
  UseWebContainerTerminalControllerOptions,
  WebContainerTerminalController,
  WebContainerTerminalControllerDialogs,
  WebContainerTerminalPersistenceDialogState,
} from './controllerTypes.ts';

export function useWebContainerTerminalController({
  config,
  dialogs,
  visible,
  workspaceChangesPersisted = true,
  workspaceChangesNotice = null,
}: UseWebContainerTerminalControllerOptions): WebContainerTerminalController {
  const {
    apiKey,
    autostart,
    baseFiles,
    baseFilesLoadError,
    baseFilesReady,
    bootCoep,
    bootReuseInstance,
    importFromContainerEnabled,
    importFromContainerIntervalMs,
    importOnUnmount,
    includeActiveEditPathInImports,
    initialSplit,
    liveFileContent,
    liveFilePath,
    liveSyncDebounceMs,
    maxPaneCount,
    networkEnabled,
    onImportDiff,
    onToggleVisibilityShortcut,
    overlayArchiveUrl,
    overlayEnabled,
    persistedHomeMode,
    persistedHomeTrustPrompt,
    registerImportHandler,
    stopOnUnmount,
    syncToContainerEnabled,
    upstreamProxyBaseUrl,
    workdirName,
    workspaceKey,
  } = resolveWebContainerTerminalConfig(config);
  const [error, setError] = useState<string | null>(null);
  const [dismissedWorkspaceNoticeKey, setDismissedWorkspaceNoticeKey] = useState<string | null>(null);
  const [fsReady, setFsReady] = useState(false);
  const terminalThemeMode = useTerminalThemeMode();
  const startedRef = useRef(false);
  const hostBridgeRef = useRef<WebContainerHostBridgeSession | null>(null);
  const unmountedRef = useRef(false);
  const wcRef = useRef<WebContainer | null>(null);
  const baseFilesLoadErrorRef = useRef(baseFilesLoadError);
  baseFilesLoadErrorRef.current = baseFilesLoadError;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const restartShellRef = useRef<((paneId?: PaneId, options?: { clearTerminal?: boolean }) => Promise<void>) | null>(
    null,
  );
  const restartWebContainerRef = useRef<
    ((options?: { reason?: PersistedHomeTransitionReason }) => Promise<void>) | null
  >(null);
  const lastAppliedTerminalThemeModeRef = useRef(terminalThemeMode);

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
    initialSplit,
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
    configBootCoep: bootCoep,
    configBootReuseInstance: bootReuseInstance,
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
  const primaryShellSessionId = getPaneRuntime('primary').shellSessionId;
  const secondaryShellSessionId = getPaneRuntime('secondary').shellSessionId;
  const workspaceNoticeVisible = workspaceNoticeKey !== null && dismissedWorkspaceNoticeKey !== workspaceNoticeKey;
  return buildWebContainerTerminalController({
    activePaneId,
    activeShellReady,
    activeShellSessionId,
    closePersistenceDialog,
    closePersistedHomePrompt,
    closeSplitPane,
    credentialSyncEnabled,
    dismissWorkspaceNotice() {
      setDismissedWorkspaceNoticeKey(workspaceNoticeKey);
    },
    downloadFromWebContainer,
    downloadInProgress: Boolean(downloadingPath),
    error,
    focusPane,
    fsReady,
    hasHostBridgeError: Boolean(hostBridgeError),
    maxPaneCount,
    openPersistedHomeReconfigurePrompt,
    openPersistenceDialog,
    openSplitTerminal,
    persistedHomePromptState,
    persistenceDialog: {
      error: persistenceDialogError,
      loading: persistenceDialogLoading,
      open: persistenceDialogOpen,
      snapshot: persistenceDialogSnapshot,
    },
    primaryShellSessionId,
    resetBannerPaneId,
    resetBannerText,
    restartingWebContainer,
    resettingShell,
    restartShell,
    restartWebContainer,
    secondaryShellSessionId,
    selectPane,
    setPaneContainer,
    settlePersistedHomePrompt,
    splitOpen,
    visiblePaneIds,
    workspaceChangesNotice,
    workspaceNoticeVisible,
  });
}
