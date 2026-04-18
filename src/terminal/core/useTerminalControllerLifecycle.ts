import type { WebContainer } from '@webcontainer/api';
import { useEffect } from 'preact/hooks';
import type { PersistedHomeMode } from '../../repo_workspace/persisted_home_trust.ts';
import {
  didRecentHotReload,
  ensureWebContainerApiConfigured,
  isLocalhostHostname,
  type TerminalThemeMode,
} from './runtime_shared.ts';
import { otherPaneId, type PaneId } from './useTerminalPaneManager.ts';
import type { TerminalPersistedHomePromptState } from './useTerminalPersistedHome.ts';

interface RefValue<T> {
  current: T;
}

interface PaneRuntimeSnapshot {
  disposeSurface: (() => void) | null;
  container: HTMLDivElement | null;
  shell: unknown | null;
  terminal: unknown | null;
}

interface UseTerminalControllerLifecycleOptions {
  apiKey?: string;
  autostart: boolean;
  baseFilesLoadError: string | null;
  baseFilesReady: boolean;
  capturePersistedHomeState: (
    wc: WebContainer,
    options?: { allowPersist?: boolean; immediate?: boolean; targetWorkspaceKey?: string },
  ) => Promise<void>;
  closePersistedHomePrompt: () => void;
  disposePaneRuntime: (paneId: PaneId) => void;
  disposePersistedHomePrompt: () => void;
  disposeWorkspaceSync: (options?: { importOnUnmount?: boolean }) => void;
  ensurePaneSurface: (paneId: PaneId) => Promise<void>;
  fitPane: (paneId: PaneId) => void;
  flushPersistedHomeState: (options?: { force?: boolean }) => Promise<void>;
  focusPane: (paneId?: PaneId) => void;
  fsReady: boolean;
  getPaneRuntime: (paneId: PaneId) => PaneRuntimeSnapshot;
  getPersistedHomeActiveSessionMode: () => PersistedHomeMode | null;
  hideResetBanner: () => void;
  importFromContainerEnabled: boolean;
  importOnUnmount: boolean;
  invalidateSessionRuntime: () => void;
  persistedHomePromptState: TerminalPersistedHomePromptState | null;
  releaseAllPaneShellSessions: (options?: { invalidate?: boolean }) => void;
  releaseHostBridgeSession: () => Promise<void>;
  releasePaneShellSession: (paneId: PaneId, options?: { invalidate?: boolean }) => void;
  releasePersistedHomeSyncSession: () => void;
  renderBaseFilesLoadError: (paneId: PaneId) => void;
  setError: (message: string | null) => void;
  setFsReady: (ready: boolean) => void;
  setPersistedHomeActiveSessionMode: (mode: PersistedHomeMode | null) => void;
  singlePaneId: PaneId;
  spawnShellSession: (
    paneId: PaneId,
    options?: { announceReady?: boolean; clearTerminal?: boolean; syncManagedFiles?: boolean },
  ) => Promise<void>;
  splitOpen: boolean;
  startSession: (options?: { clearTerminal?: boolean }) => Promise<void>;
  startedRef: RefValue<boolean>;
  stopOnUnmount: boolean;
  teardownWebContainer: (wc: WebContainer | null) => void;
  terminalThemeMode: TerminalThemeMode;
  unmountedRef: RefValue<boolean>;
  visible: boolean;
  visiblePaneIds: PaneId[];
  visiblePaneIdsRef: RefValue<PaneId[]>;
  wcRef: RefValue<WebContainer | null>;
  workspaceKeyRef: RefValue<string>;
  lastAppliedTerminalThemeModeRef: RefValue<TerminalThemeMode>;
}

export function useTerminalControllerLifecycle({
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
  lastAppliedTerminalThemeModeRef,
}: UseTerminalControllerLifecycleOptions): void {
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
    unmountedRef,
    startedRef,
    lastAppliedTerminalThemeModeRef,
  ]);

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
  }, [baseFilesLoadError, ensurePaneSurface, renderBaseFilesLoadError, unmountedRef, visible, visiblePaneIdsRef]);

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
  }, [
    apiKey,
    autostart,
    baseFilesReady,
    ensurePaneSurface,
    setError,
    startSession,
    startedRef,
    unmountedRef,
    visible,
    visiblePaneIdsRef,
  ]);

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
  }, [
    ensurePaneSurface,
    fitPane,
    focusPane,
    fsReady,
    getPaneRuntime,
    spawnShellSession,
    startedRef,
    unmountedRef,
    visible,
    visiblePaneIds,
  ]);

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
    return () => {
      unmountedRef.current = true;
      const skipImportOnUnmount = didRecentHotReload();
      const currentWc = wcRef.current;
      const allowPersistedHomeCapture = getPersistedHomeActiveSessionMode() === 'include';
      if (currentWc && allowPersistedHomeCapture) {
        const targetWorkspaceKey = workspaceKeyRef.current;
        void capturePersistedHomeState(currentWc, { immediate: true, allowPersist: true, targetWorkspaceKey }).finally(
          () => {
            void flushPersistedHomeState({ force: true });
          },
        );
      } else {
        void flushPersistedHomeState({ force: true });
      }
      disposeWorkspaceSync({ importOnUnmount: !skipImportOnUnmount && importOnUnmount && importFromContainerEnabled });
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
    };
  }, [
    capturePersistedHomeState,
    disposeWorkspaceSync,
    disposePersistedHomePrompt,
    flushPersistedHomeState,
    getPaneRuntime,
    getPersistedHomeActiveSessionMode,
    hideResetBanner,
    importFromContainerEnabled,
    importOnUnmount,
    invalidateSessionRuntime,
    releaseAllPaneShellSessions,
    releaseHostBridgeSession,
    releasePersistedHomeSyncSession,
    setFsReady,
    setPersistedHomeActiveSessionMode,
    stopOnUnmount,
    teardownWebContainer,
    unmountedRef,
    wcRef,
    workspaceKeyRef,
    startedRef,
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
  }, [capturePersistedHomeState, flushPersistedHomeState, wcRef, workspaceKeyRef]);
}
