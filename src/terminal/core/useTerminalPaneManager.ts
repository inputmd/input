import type { WebContainer } from '@webcontainer/api';
import type { Terminal as GhosttyTerminal } from 'ghostty-web';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { resetTerminalSurface } from '../../components/terminal_surface_reset.ts';
import { consumeTerminalPixelWheelDelta } from '../../components/terminal_wheel.ts';
import { matchesControlShortcut, shouldBypassTerminalMetaShortcut } from '../../keyboard_shortcuts.ts';
import type { WebContainerHostBridgeSession } from '../../webcontainer_host_bridge.ts';
import type { WebContainerTerminalPaneId } from './config.ts';
import { fitTerminal, getTerminalTheme, loadGhosttyWeb, type TerminalThemeMode } from './runtime_shared.ts';

const CTRL_C_RESET_WINDOW_MS = 1000;
const CTRL_Z_NOTICE_WINDOW_MS = 1000;
const TERMINAL_RESET_BANNER_DURATION_MS = 3000;
const TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'SF Mono Web', 'SF Mono', 'Fira Mono', ui-monospace, Menlo, Monaco, Consolas, monospace";
const TERMINAL_DRAG_RESIZE_INTERVAL_MS = 90;
const TERMINAL_FOLLOW_OUTPUT_LEAVE_THRESHOLD_LINES = 4;
const TERMINAL_FOLLOW_OUTPUT_RESUME_THRESHOLD_LINES = 1;
const LAYOUT_RESIZE_START_EVENT = 'input:layout-resize-start';
const LAYOUT_SETTLED_EVENT = 'input:layout-settled';

export type PaneId = WebContainerTerminalPaneId;

type SpawnedShell = Awaited<ReturnType<WebContainer['spawn']>>;
type ResetKey = 'ctrl-c' | 'ctrl-backslash';

interface RefValue<T> {
  current: T;
}

export interface PaneRuntime {
  container: HTMLDivElement | null;
  terminal: GhosttyTerminal | null;
  shell: SpawnedShell | null;
  shellWriter: WritableStreamDefaultWriter<string> | null;
  shellSessionId: number;
  disposeSurface: (() => void) | null;
}

export interface UseTerminalPaneManagerOptions {
  baseFilesLoadErrorRef: RefValue<string | null>;
  flushManagedSync: () => Promise<void>;
  hostBridgeRef: RefValue<WebContainerHostBridgeSession | null>;
  initialSplit?: boolean;
  maxPaneCount: number;
  onRequestShellRestart: (paneId: PaneId) => void;
  onToggleVisibilityShortcut?: () => void | Promise<void>;
  terminalThemeMode: TerminalThemeMode;
  unmountedRef: RefValue<boolean>;
  wcRef: RefValue<WebContainer | null>;
}

export interface TerminalPaneManager {
  activePaneId: PaneId;
  closeSplitPane: (position: 'top' | 'bottom') => void;
  disposePaneRuntime: (paneId: PaneId) => void;
  ensurePaneSurface: (paneId: PaneId) => Promise<void>;
  fitPane: (paneId: PaneId) => void;
  focusPane: (paneId?: PaneId) => void;
  getPreferredPaneId: () => PaneId;
  hideResetBanner: () => void;
  openSplitTerminal: () => void;
  paneRuntimesRef: RefValue<Record<PaneId, PaneRuntime>>;
  releaseAllPaneShellSessions: (options?: { invalidate?: boolean }) => void;
  releasePaneShellSession: (paneId: PaneId, options?: { invalidate?: boolean }) => void;
  renderBaseFilesLoadError: (paneId: PaneId) => void;
  resetBannerPaneId: PaneId | null;
  resetBannerText: string | null;
  resetPaneSurface: (paneId: PaneId) => void;
  selectPane: (paneId: PaneId) => void;
  setFollowOutput: (paneId: PaneId, followOutput: boolean) => void;
  setPaneContainer: (paneId: PaneId, node: HTMLDivElement | null) => void;
  shellReadyByPane: Record<PaneId, boolean>;
  singlePaneId: PaneId;
  spawnShellSession: (
    paneId: PaneId,
    options?: { announceReady?: boolean; clearTerminal?: boolean; syncManagedFiles?: boolean },
  ) => Promise<void>;
  splitOpen: boolean;
  visiblePaneIds: PaneId[];
  writeTerminal: (
    paneId: PaneId,
    data: string | Uint8Array,
    options?: { forceFollow?: boolean; newline?: boolean },
  ) => void;
}

export function otherPaneId(paneId: PaneId): PaneId {
  return paneId === 'primary' ? 'secondary' : 'primary';
}

function resetBannerTextForKey(key: ResetKey | null): string {
  return key === 'ctrl-backslash'
    ? 'Press Ctrl-\\ again to reset this terminal'
    : 'Press Ctrl-C again to reset this terminal';
}

export function useTerminalPaneManager({
  baseFilesLoadErrorRef,
  flushManagedSync,
  hostBridgeRef,
  initialSplit = false,
  maxPaneCount,
  onRequestShellRestart,
  onToggleVisibilityShortcut,
  terminalThemeMode,
  unmountedRef,
  wcRef,
}: UseTerminalPaneManagerOptions): TerminalPaneManager {
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
  const onRequestShellRestartRef = useRef(onRequestShellRestart);
  onRequestShellRestartRef.current = onRequestShellRestart;
  const onToggleVisibilityShortcutRef = useRef(onToggleVisibilityShortcut);
  onToggleVisibilityShortcutRef.current = onToggleVisibilityShortcut;
  const [shellReadyByPane, setShellReadyByPane] = useState<Record<PaneId, boolean>>({
    primary: false,
    secondary: false,
  });
  const shellExitedByPaneRef = useRef<Record<PaneId, boolean>>({
    primary: false,
    secondary: false,
  });
  const [resetBannerPaneId, setResetBannerPaneId] = useState<PaneId | null>(null);
  const [resetBannerKey, setResetBannerKey] = useState<ResetKey | null>(null);
  const resetBannerTimerRef = useRef<number | null>(null);
  const resetWarningStateRef = useRef<{ paneId: PaneId | null; key: ResetKey | null; stage: 0 | 1 | 2; at: number }>({
    paneId: null,
    key: null,
    stage: 0,
    at: 0,
  });
  const lastCtrlZNoticeAtRef = useRef<number>(0);
  const [singlePaneId, setSinglePaneId] = useState<PaneId>('primary');
  const [splitOpen, setSplitOpen] = useState(() => Boolean(initialSplit && maxPaneCount > 1));
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
    [baseFilesLoadErrorRef, setFollowOutput, writeTerminal],
  );

  const resetPaneSurface = useCallback(
    (paneId: PaneId): void => {
      const terminal = paneRuntimesRef.current[paneId].terminal;
      if (!terminal) return;
      resetTerminalSurface(terminal);
      setFollowOutput(paneId, true);
    },
    [setFollowOutput],
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

  const spawnShellSession = useCallback(
    async (
      paneId: PaneId,
      options?: { announceReady?: boolean; clearTerminal?: boolean; syncManagedFiles?: boolean },
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
    [
      flushManagedSync,
      hideResetBanner,
      hostBridgeRef,
      releasePaneShellSession,
      setFollowOutput,
      setShellExited,
      unmountedRef,
      wcRef,
      writeTerminal,
    ],
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

      hideResetBanner();
      resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
      onRequestShellRestartRef.current(paneId);
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
          void onToggleVisibilityShortcutRef.current?.();
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
      renderBaseFilesLoadError,
      terminalThemeMode,
      unmountedRef,
      updateFollowOutputState,
      writeTerminal,
    ],
  );

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

  const setPaneContainer = useCallback((paneId: PaneId, node: HTMLDivElement | null) => {
    paneRuntimesRef.current[paneId].container = node;
  }, []);

  return {
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
    resetBannerText: resetBannerPaneId ? resetBannerTextForKey(resetBannerKey) : null,
    resetPaneSurface,
    selectPane: setActivePaneId,
    setFollowOutput,
    setPaneContainer,
    shellReadyByPane,
    singlePaneId,
    spawnShellSession,
    splitOpen,
    visiblePaneIds,
    writeTerminal,
  };
}
