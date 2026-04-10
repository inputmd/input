import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import type { Terminal as GhosttyTerminal } from 'ghostty-web';
import { Power } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils.ts';
import { matchesControlShortcut, shouldBypassTerminalMetaShortcut } from '../keyboard_shortcuts.ts';
import { isLikelyBinaryBytes } from '../path_utils.ts';
import {
  buildTerminalImportDiff,
  shouldImportTerminalPath,
  type TerminalImportDiff,
  type TerminalImportOptions,
} from '../repo_workspace/terminal_sync.ts';
import {
  buildPersistedTerminalHistorySeed,
  buildTerminalHistorySyncScript,
  loadPersistedTerminalHistory,
  persistTerminalHistory,
  TERMINAL_HISTORY_SEED_FILENAME,
  TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME,
} from '../terminal_history.ts';
import {
  buildWebContainerHomeOverlayProvisionScript,
  WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL,
} from '../webcontainer_home_overlay.ts';
import { startWebContainerHostBridge, type WebContainerHostBridgeSession } from '../webcontainer_host_bridge.ts';
import { useDialogs } from './DialogProvider';

// Ctrl-C/Ctrl-\ don't reliably interrupt processes inside WebContainer
// (upstream bug). As a workaround, a second press warns that a third press
// will reset into a fresh shell.
const CTRL_C_RESET_WINDOW_MS = 1000;
const CTRL_Z_NOTICE_WINDOW_MS = 1000;
const TERMINAL_RESET_BANNER_DURATION_MS = 3000;

export interface TerminalLiveFile {
  path: string;
  content: string;
}

export interface TerminalPanelProps {
  className?: string;
  visible: boolean;
  workspaceKey: string;
  workdirName: string;
  apiKey: string | undefined;
  /**
   * Stable workspace snapshot mirrored into the WebContainer FS on mount and
   * when non-editor state changes.
   */
  baseFiles: Record<string, string>;
  /**
   * Active unsaved editor buffer overlaid on top of `baseFiles`. This stays
   * one-way (app → terminal) and is synced as a single debounced file write.
   */
  liveFile: TerminalLiveFile | null;
  /**
   * When true, terminal imports may include changes to the active editor file.
   * This should only be enabled while the editor buffer is still clean.
   */
  includeActiveEditPathInImports?: boolean;
  onToggleVisibilityShortcut?: () => void | Promise<void>;
  onImportDiff?: (args: {
    workspaceKey: string;
    diff: TerminalImportDiff;
    options?: TerminalImportOptions;
  }) => void | Promise<void>;
  registerImportHandler?: (
    handler: ((options?: TerminalImportOptions) => Promise<TerminalImportDiff | null>) | null,
  ) => void;
}

type SpawnedShell = Awaited<ReturnType<WebContainer['spawn']>>;

// Cache the WebContainer boot promise so we only ever boot once per page.
// WebContainer.boot() throws if called more than once.
let webContainerBootPromise: Promise<WebContainer> | null = null;
let webContainerBootWorkdirName: string | null = null;
let ghosttyInitPromise: Promise<void> | null = null;

function terminalDownloadName(path: string, workdirName: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return `${workdirName || 'workspace'}.zip`;
  const baseName = normalized.split('/').filter(Boolean).at(-1) ?? workdirName ?? 'download';
  return `${baseName}.zip`;
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

function isLocalhostHostname(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function bootWebContainer(apiKey: string | undefined, workdirName: string): Promise<WebContainer> {
  if (webContainerBootPromise && webContainerBootWorkdirName === workdirName) return webContainerBootPromise;
  if (webContainerBootPromise && webContainerBootWorkdirName !== workdirName) {
    try {
      const wc = await webContainerBootPromise;
      wc.teardown();
    } catch {
      // ignore boot/teardown failures and attempt a clean reboot below
    } finally {
      webContainerBootPromise = null;
      webContainerBootWorkdirName = null;
    }
  }
  webContainerBootPromise = (async () => {
    const { WebContainer, configureAPIKey } = await import('@webcontainer/api');
    // The WebContainer dashboard checks the Referer against its allowed-sites
    // list when configureAPIKey() is set, and it does not accept localhost.
    // On localhost, boot unauthenticated — that path works without a key.
    if (apiKey && !isLocalhostHostname()) {
      configureAPIKey(apiKey);
    }
    return WebContainer.boot({ coep: 'credentialless', workdirName });
  })();
  webContainerBootWorkdirName = workdirName;
  try {
    return await webContainerBootPromise;
  } catch (err) {
    webContainerBootPromise = null;
    webContainerBootWorkdirName = null;
    throw err;
  }
}

// Build a nested FileSystemTree from a flat path → contents map.
function buildFileSystemTree(files: Record<string, string>): FileSystemTree {
  const root: FileSystemTree = {};
  for (const [rawPath, contents] of Object.entries(files)) {
    const segments = rawPath.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const existing = cursor[segment];
      if (existing && 'directory' in existing) {
        cursor = existing.directory;
      } else {
        const dir: FileSystemTree = {};
        cursor[segment] = { directory: dir };
        cursor = dir;
      }
    }
    const leaf = segments[segments.length - 1];
    cursor[leaf] = { file: { contents } };
  }
  return root;
}

function buildManagedFiles(
  baseFiles: Record<string, string>,
  liveFilePath: string | null,
  liveFileContent: string | null,
): Record<string, string> {
  if (liveFilePath === null) return { ...baseFiles };
  return { ...baseFiles, [liveFilePath]: liveFileContent ?? '' };
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '' : path.slice(0, idx);
}

async function readStreamFully(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      result += value;
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}

const HOME_OVERLAY_ARCHIVE_FILENAME = '.input-home-overlay.tar';
const HOME_OVERLAY_PROVISION_FILENAME = '.input-home-overlay-provision.cjs';
const TERMINAL_HISTORY_PERSIST_DEBOUNCE_MS = 250;

async function fetchWebContainerHomeOverlayArchive(): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Failed to load WebContainer home overlay archive (${response.status})`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const archive = new Uint8Array(await response.arrayBuffer());
  if (contentType && !contentType.includes('application/x-tar') && !contentType.includes('application/octet-stream')) {
    const preview = new TextDecoder().decode(archive.subarray(0, 200)).replace(/\s+/g, ' ').trim();
    throw new Error(
      `Unexpected WebContainer home overlay response type: ${contentType}; preview=${JSON.stringify(preview)}`,
    );
  }
  if (archive.byteLength % 512 !== 0) {
    const preview = new TextDecoder().decode(archive.subarray(0, 200)).replace(/\s+/g, ' ').trim();
    throw new Error(
      `Invalid WebContainer home overlay archive size: ${archive.byteLength} bytes; preview=${JSON.stringify(preview)}`,
    );
  }
  return archive;
}

async function provisionHomeOverlay(wc: WebContainer): Promise<void> {
  const archive = await fetchWebContainerHomeOverlayArchive();
  const provisionScript = buildWebContainerHomeOverlayProvisionScript(HOME_OVERLAY_ARCHIVE_FILENAME);
  await wc.fs.writeFile(HOME_OVERLAY_ARCHIVE_FILENAME, archive);
  await wc.fs.writeFile(HOME_OVERLAY_PROVISION_FILENAME, provisionScript);
  try {
    const provision = await wc.spawn('node', [HOME_OVERLAY_PROVISION_FILENAME]);
    const [output, exitCode] = await Promise.all([readStreamFully(provision.output), provision.exit]);
    if (exitCode !== 0) {
      throw new Error(`node overlay provision exited with code ${exitCode}; output=${JSON.stringify(output)}`);
    }
  } finally {
    try {
      await wc.fs.rm(HOME_OVERLAY_PROVISION_FILENAME, { force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      await wc.fs.rm(HOME_OVERLAY_ARCHIVE_FILENAME, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function prepareTerminalHistorySupportFiles(wc: WebContainer): Promise<void> {
  await wc.fs.writeFile(
    TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME,
    buildTerminalHistorySyncScript(TERMINAL_HISTORY_SEED_FILENAME),
  );
}

async function restoreTerminalHistoryForWorkspace(wc: WebContainer, workspaceKey: string): Promise<void> {
  const content = loadPersistedTerminalHistory(workspaceKey);
  await wc.fs.writeFile(TERMINAL_HISTORY_SEED_FILENAME, buildPersistedTerminalHistorySeed(content));
  const restore = await wc.spawn('node', [TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME, 'restore'], { output: false });
  const exitCode = await restore.exit;
  if (exitCode !== 0) {
    throw new Error(`node terminal history restore exited with code ${exitCode}`);
  }
}

async function readTerminalHistoryForWorkspace(wc: WebContainer): Promise<string> {
  const reader = await wc.spawn('node', [TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME, 'read']);
  const [output, exitCode] = await Promise.all([readStreamFully(reader.output), reader.exit]);
  if (exitCode !== 0) {
    throw new Error(`node terminal history read exited with code ${exitCode}`);
  }
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return '';
  const parsed = JSON.parse(line) as { type?: string; content?: unknown };
  return parsed.type === 'history' && typeof parsed.content === 'string' ? parsed.content : '';
}

// Wipe everything in the WebContainer working directory. Used when a new
// TerminalPanel mounts (workspace remount via React key) so the previous
// workspace's files don't leak into the new one.
async function clearWorkdir(wc: WebContainer): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await wc.fs.readdir('.');
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (name) => {
      try {
        await wc.fs.rm(name, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }),
  );
}

async function writeTextFile(wc: WebContainer, path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  if (dir) {
    await wc.fs.mkdir(dir, { recursive: true });
  }
  await wc.fs.writeFile(path, contents);
}

async function readTerminalFileBytes(wc: WebContainer, path: string): Promise<Uint8Array | null> {
  try {
    const value = await (wc.fs as { readFile(path: string): Promise<unknown> }).readFile(path);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
  } catch {
    return null;
  }
  return null;
}

interface SnapshotState {
  count: number;
  truncated: boolean;
}

async function snapshotTerminalTextFiles(
  wc: WebContainer,
  path = '.',
  relativePath = '',
  depth = 0,
  state: SnapshotState = { count: 0, truncated: false },
): Promise<Record<string, string>> {
  if (state.truncated) return {};
  if (depth > TERMINAL_IMPORT_MAX_DEPTH) {
    state.truncated = true;
    console.error(`[terminal-import] truncated: depth exceeded ${TERMINAL_IMPORT_MAX_DEPTH} at ${path}`);
    return {};
  }

  const normalizedRelativePath = relativePath.replace(/^\/+|\/+$/g, '');
  if (normalizedRelativePath && !shouldImportTerminalPath(normalizedRelativePath)) {
    return {};
  }

  try {
    const entries = await wc.fs.readdir(path);
    const files: Record<string, string> = {};
    for (const entry of entries) {
      if (state.truncated) break;
      const childRelativePath = normalizedRelativePath ? `${normalizedRelativePath}/${entry}` : entry;
      if (!shouldImportTerminalPath(childRelativePath)) continue;
      const childPath = path === '.' ? entry : `${path}/${entry}`;
      Object.assign(files, await snapshotTerminalTextFiles(wc, childPath, childRelativePath, depth + 1, state));
    }
    return files;
  } catch {
    if (!normalizedRelativePath || !shouldImportTerminalPath(normalizedRelativePath)) return {};
    if (state.count >= TERMINAL_IMPORT_MAX_ENTRIES) {
      state.truncated = true;
      console.error(`[terminal-import] truncated: entry count exceeded ${TERMINAL_IMPORT_MAX_ENTRIES} at ${path}`);
      return {};
    }
    const bytes = await readTerminalFileBytes(wc, path);
    if (!bytes || bytes.length > TERMINAL_IMPORT_MAX_FILE_BYTES || isLikelyBinaryBytes(bytes)) return {};
    state.count += 1;
    return { [normalizedRelativePath]: new TextDecoder().decode(bytes) };
  }
}

async function loadGhosttyWeb() {
  const module = await import('ghostty-web');
  if (!ghosttyInitPromise) {
    ghosttyInitPromise = module.init().catch((err) => {
      ghosttyInitPromise = null;
      throw err;
    });
  }
  await ghosttyInitPromise;
  return module;
}

const TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'SF Mono Web', 'SF Mono', 'Fira Mono', ui-monospace, Menlo, Monaco, Consolas, monospace";
const LIVE_FILE_DEBOUNCE_MS = 300;
const TERMINAL_AUTO_IMPORT_INTERVAL_MS = 3000;
const TERMINAL_IMPORT_MAX_FILE_BYTES = 512 * 1024;
const TERMINAL_IMPORT_MAX_ENTRIES = 5000;
const TERMINAL_IMPORT_MAX_DEPTH = 50;
const TERMINAL_SCROLLBAR_RESERVATION_PX = 15;
const TERMINAL_MIN_COLS = 2;
const TERMINAL_MIN_ROWS = 1;
const LAYOUT_SETTLED_EVENT = 'input:layout-settled';

function waitForNextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function fitTerminal(terminal: GhosttyTerminal, container: HTMLElement): void {
  const metrics = terminal.renderer?.getMetrics?.();
  if (!metrics || metrics.width === 0 || metrics.height === 0) return;
  const styles = window.getComputedStyle(container);
  const paddingTop = Number.parseInt(styles.getPropertyValue('padding-top'), 10) || 0;
  const paddingBottom = Number.parseInt(styles.getPropertyValue('padding-bottom'), 10) || 0;
  const paddingLeft = Number.parseInt(styles.getPropertyValue('padding-left'), 10) || 0;
  const paddingRight = Number.parseInt(styles.getPropertyValue('padding-right'), 10) || 0;
  const innerWidth = container.clientWidth - paddingLeft - paddingRight - TERMINAL_SCROLLBAR_RESERVATION_PX;
  const innerHeight = container.clientHeight - paddingTop - paddingBottom;
  if (innerWidth <= 0 || innerHeight <= 0) return;
  const cols = Math.max(TERMINAL_MIN_COLS, Math.floor(innerWidth / metrics.width));
  const rows = Math.max(TERMINAL_MIN_ROWS, Math.floor(innerHeight / metrics.height));
  if (cols === terminal.cols && rows === terminal.rows) return;
  terminal.resize(cols, rows);
}

type PaneId = 'primary' | 'secondary';

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
    ? 'Press Ctrl-\\ again to quit to a new shell'
    : 'Press Ctrl-C again to quit to a new shell';
}

export function TerminalPanel({
  className,
  visible,
  workspaceKey,
  workdirName,
  apiKey,
  baseFiles,
  liveFile,
  includeActiveEditPathInImports = false,
  onToggleVisibilityShortcut,
  onImportDiff,
  registerImportHandler,
}: TerminalPanelProps) {
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
  const startedRef = useRef(false);
  const hostBridgeRef = useRef<WebContainerHostBridgeSession | null>(null);
  const historySyncRef = useRef<SpawnedShell | null>(null);
  const historySyncProcessIdRef = useRef(0);
  const historySyncOutputBufferRef = useRef('');
  const historyPersistTimerRef = useRef<number | null>(null);
  const pendingHistoryContentRef = useRef<string | null>(null);
  const webContainerSessionIdRef = useRef(0);
  const restartInFlightRef = useRef<Promise<void> | null>(null);
  const restartWebContainerInFlightRef = useRef<Promise<void> | null>(null);
  const unmountedRef = useRef(false);
  const wcRef = useRef<WebContainer | null>(null);
  const lastWrittenRef = useRef<Map<string, string>>(new Map());
  const baseFilesRef = useRef(baseFiles);
  baseFilesRef.current = baseFiles;
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
  const { showAlert, showPrompt } = useDialogs();
  const showAlertRef = useRef(showAlert);
  showAlertRef.current = showAlert;
  const showPromptRef = useRef(showPrompt);
  showPromptRef.current = showPrompt;
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
  const restartShellRef = useRef<((paneId?: PaneId) => Promise<void>) | null>(null);
  const [singlePaneId, setSinglePaneId] = useState<PaneId>('primary');
  const [splitOpen, setSplitOpen] = useState(false);
  const [activePaneId, setActivePaneId] = useState<PaneId>('primary');
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

  const getPreferredPaneId = useCallback((): PaneId => {
    if (visiblePaneIdsRef.current.includes(activePaneIdRef.current)) return activePaneIdRef.current;
    return visiblePaneIdsRef.current[0] ?? 'primary';
  }, []);

  const fitPane = useCallback((paneId: PaneId) => {
    const runtime = paneRuntimesRef.current[paneId];
    if (!runtime.terminal || !runtime.container) return;
    fitTerminal(runtime.terminal, runtime.container);
  }, []);

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

  const releaseHostBridgeSession = useCallback(() => {
    const hostBridge = hostBridgeRef.current;
    hostBridgeRef.current = null;
    hostBridge?.stop();
  }, []);

  const flushPersistedTerminalHistory = useCallback(() => {
    if (historyPersistTimerRef.current !== null) {
      window.clearTimeout(historyPersistTimerRef.current);
      historyPersistTimerRef.current = null;
    }
    const pendingContent = pendingHistoryContentRef.current;
    if (pendingContent === null) return;
    pendingHistoryContentRef.current = null;
    persistTerminalHistory(workspaceKeyRef.current, pendingContent);
  }, []);

  const schedulePersistedTerminalHistory = useCallback((content: string) => {
    pendingHistoryContentRef.current = content;
    if (historyPersistTimerRef.current !== null) {
      window.clearTimeout(historyPersistTimerRef.current);
    }
    historyPersistTimerRef.current = window.setTimeout(() => {
      historyPersistTimerRef.current = null;
      const nextContent = pendingHistoryContentRef.current;
      if (nextContent === null) return;
      pendingHistoryContentRef.current = null;
      persistTerminalHistory(workspaceKeyRef.current, nextContent);
    }, TERMINAL_HISTORY_PERSIST_DEBOUNCE_MS);
  }, []);

  const releaseHistorySyncSession = useCallback(() => {
    historySyncProcessIdRef.current += 1;
    historySyncOutputBufferRef.current = '';
    const process = historySyncRef.current;
    historySyncRef.current = null;
    if (!process) return;
    try {
      process.kill();
    } catch {
      // ignore
    }
  }, []);

  const captureTerminalHistory = useCallback(
    async (wc: WebContainer | null): Promise<void> => {
      if (!wc) return;
      try {
        const content = await readTerminalHistoryForWorkspace(wc);
        schedulePersistedTerminalHistory(content);
      } catch (err) {
        console.error('[terminal] failed to capture jsh history', err);
      }
    },
    [schedulePersistedTerminalHistory],
  );

  const startTerminalHistorySync = useCallback(
    async (wc: WebContainer): Promise<void> => {
      releaseHistorySyncSession();
      const processId = historySyncProcessIdRef.current + 1;
      historySyncProcessIdRef.current = processId;
      historySyncOutputBufferRef.current = '';

      const watcher = await wc.spawn('node', [TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME, 'watch']);
      if (unmountedRef.current || wcRef.current !== wc || historySyncProcessIdRef.current !== processId) {
        try {
          watcher.kill();
        } catch {
          // ignore
        }
        return;
      }

      historySyncRef.current = watcher;
      void watcher.output
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              if (historySyncProcessIdRef.current !== processId) return;
              historySyncOutputBufferRef.current += chunk;
              while (true) {
                const newlineIndex = historySyncOutputBufferRef.current.indexOf('\n');
                if (newlineIndex === -1) break;
                const line = historySyncOutputBufferRef.current.slice(0, newlineIndex).trim();
                historySyncOutputBufferRef.current = historySyncOutputBufferRef.current.slice(newlineIndex + 1);
                if (!line) continue;
                try {
                  const parsed = JSON.parse(line) as { type?: string; content?: unknown };
                  if (parsed.type === 'history' && typeof parsed.content === 'string') {
                    schedulePersistedTerminalHistory(parsed.content);
                  }
                } catch (err) {
                  console.error('[terminal] failed to parse jsh history event', err);
                }
              }
            },
          }),
        )
        .catch((err) => {
          if (historySyncProcessIdRef.current !== processId) return;
          console.error('[terminal] jsh history watcher closed', err);
        });
    },
    [releaseHistorySyncSession, schedulePersistedTerminalHistory],
  );

  const teardownWebContainer = useCallback((wc: WebContainer | null) => {
    if (!wc) {
      webContainerBootPromise = null;
      webContainerBootWorkdirName = null;
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
      webContainerBootPromise = null;
      webContainerBootWorkdirName = null;
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
    async (options?: TerminalImportOptions): Promise<TerminalImportDiff | null> => {
      if (importInFlightRef.current) return importInFlightRef.current;
      const pendingImport = (async (): Promise<TerminalImportDiff | null> => {
        const wc = wcRef.current;
        if (!wc || !onImportDiffRef.current) return null;
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
        await onImportDiffRef.current({
          workspaceKey: workspaceKeyRef.current,
          diff,
          options,
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
      options?: { resetTerminal?: boolean; syncManagedFiles?: boolean; announceReady?: boolean },
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

      if (options?.resetTerminal) {
        terminal.reset();
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
                terminal.write(chunk);
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
          terminal.writeln(
            `Shell exited${typeof exitCode === 'number' ? ` (code ${exitCode})` : ''}. Press Ctrl-C twice to restart.`,
          );
        } catch {
          // ignore
        }
      });

      setShellReadyByPane((current) => ({ ...current, [paneId]: true }));
    },
    [flushManagedSync, hideResetBanner, releasePaneShellSession, setShellExited],
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
        return false;
      }

      if (shellExited) {
        hideResetBanner();
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
        void restartShellRef.current?.(paneId);
        return true;
      }

      if (current.stage < 2) {
        resetWarningStateRef.current = { paneId, key, stage: 2, at: now };
        showResetBanner(paneId, key);
        return true;
      }

      hideResetBanner();
      resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
      void restartShellRef.current?.(paneId);
      return true;
    },
    [hideResetBanner, showResetBanner],
  );

  const ensurePaneSurface = useCallback(
    async (paneId: PaneId): Promise<void> => {
      const runtime = paneRuntimesRef.current[paneId];
      if (runtime.terminal || !runtime.container) return;
      const container = runtime.container;
      const { Terminal } = await loadGhosttyWeb();
      if (unmountedRef.current) return;
      if (runtime.terminal) return;
      if (!runtime.container || runtime.container !== container) return;

      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        cursorStyle: 'block',
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 14.5,
        theme: { background: '#0b0b0b' },
      });
      runtime.terminal = terminal;
      terminal.open(container);
      fitTerminal(terminal, container);

      terminal.attachCustomWheelEventHandler((event) => {
        if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
        const charHeight = terminal.renderer?.charHeight ?? 20;
        const lines = (event.deltaY / charHeight) * 2;
        if (lines !== 0) {
          terminal.scrollLines(lines);
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
      let layoutSettledTimeoutId: number | null = null;
      const scheduleFit = () => {
        if (resizeFrameId !== null) return;
        resizeFrameId = window.requestAnimationFrame(() => {
          resizeFrameId = null;
          fitPane(paneId);
        });
      };
      const onLayoutSettled = () => {
        scheduleFit();
        if (layoutSettledTimeoutId !== null) {
          window.clearTimeout(layoutSettledTimeoutId);
        }
        layoutSettledTimeoutId = window.setTimeout(() => {
          layoutSettledTimeoutId = null;
          scheduleFit();
        }, 80);
      };
      const resizeObserver = new ResizeObserver(() => {
        scheduleFit();
      });
      resizeObserver.observe(container);
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
              terminal.writeln('[terminal] Ctrl-Z job control is not supported in this terminal.');
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

      runtime.disposeSurface = () => {
        resizeObserver.disconnect();
        if (resizeFrameId !== null) {
          window.cancelAnimationFrame(resizeFrameId);
        }
        if (layoutSettledTimeoutId !== null) {
          window.clearTimeout(layoutSettledTimeoutId);
        }
        window.removeEventListener(LAYOUT_SETTLED_EVENT, onLayoutSettled);
        onDataDispose.dispose();
        onResizeDispose.dispose();
        container.removeEventListener('keydown', onMetaKeyDown, true);
        if (runtime.terminal === terminal) {
          runtime.terminal = null;
        }
        terminal.dispose();
      };
    },
    [fitPane, handleResetHotkey, onToggleVisibilityShortcut],
  );

  const initializeWebContainerSession = useCallback(
    async (options?: {
      forceReboot?: boolean;
      importBeforeReboot?: boolean;
      resetTerminal?: boolean;
      announceRestart?: boolean;
    }): Promise<void> => {
      const logPaneId = getPreferredPaneId();
      const terminal = paneRuntimesRef.current[logPaneId].terminal;
      if (!terminal) {
        throw new Error('Terminal is not ready.');
      }

      const previousWc = wcRef.current;
      const sessionId = webContainerSessionIdRef.current + 1;
      webContainerSessionIdRef.current = sessionId;
      restartInFlightRef.current = null;
      releaseHistorySyncSession();
      releaseHostBridgeSession();
      releaseAllPaneShellSessions({ invalidate: true });
      setFsReady(false);
      setShellReadyByPane({ primary: false, secondary: false });

      if (options?.resetTerminal) {
        for (const paneId of visiblePaneIdsRef.current) {
          paneRuntimesRef.current[paneId].terminal?.reset();
        }
      }
      if (options?.announceRestart) {
        terminal.write('Restarting...\r\n');
      }

      if (options?.importBeforeReboot && previousWc) {
        try {
          await importTerminalDiff({ silent: true });
          await waitForNextAnimationFrame();
        } catch (err) {
          console.error('[terminal] import before restart failed', err);
        }
      }

      if (previousWc) {
        await captureTerminalHistory(previousWc);
      }

      if (options?.forceReboot) {
        teardownWebContainer(previousWc);
      }

      terminal.write('Booting...\r\n');
      const wc = await bootWebContainer(apiKey, workdirName);
      if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
        return;
      }

      terminal.write(`Mounting /home/${workdirName}...\r\n`);
      await clearWorkdir(wc);
      if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
        return;
      }

      const initialFiles = buildManagedFiles(baseFilesRef.current, liveFilePathRef.current, liveFileContentRef.current);
      try {
        await wc.mount(buildFileSystemTree(initialFiles));
      } catch (mountErr) {
        console.error('[terminal] initial mount failed', mountErr);
      }
      if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
        return;
      }

      lastWrittenRef.current = new Map(Object.entries(initialFiles));
      wcRef.current = wc;

      try {
        await provisionHomeOverlay(wc);
      } catch (err) {
        console.error('[terminal] failed to provision home overlay', err);
        terminal.write(
          `[terminal] failed to provision home overlay: ${err instanceof Error ? err.message : String(err)}\r\n`,
        );
      }

      try {
        await prepareTerminalHistorySupportFiles(wc);
        await restoreTerminalHistoryForWorkspace(wc, workspaceKeyRef.current);
      } catch (err) {
        console.error('[terminal] failed to restore jsh history', err);
        terminal.write(
          `[terminal] failed to restore jsh history: ${err instanceof Error ? err.message : String(err)}\r\n`,
        );
      }

      try {
        terminal.write('Starting networking...\r\n');
        hostBridgeRef.current = await startWebContainerHostBridge({
          onLog(message) {
            console.error(message);
            try {
              terminal.write(`${message}\r\n`);
            } catch {
              // ignore
            }
          },
          wc,
        });
      } catch (err) {
        console.error('[terminal] failed to start host bridge', err);
        terminal.write(
          `[terminal] failed to start host bridge: ${err instanceof Error ? err.message : String(err)}\r\n`,
        );
      }

      for (const [index, paneId] of visiblePaneIdsRef.current.entries()) {
        await spawnShellSession(paneId, { announceReady: index === 0 });
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          return;
        }
      }

      try {
        await startTerminalHistorySync(wc);
      } catch (err) {
        console.error('[terminal] failed to start jsh history watcher', err);
        terminal.write(
          `[terminal] failed to start jsh history watcher: ${err instanceof Error ? err.message : String(err)}\r\n`,
        );
      }

      setFsReady(true);
      focusPane(logPaneId);
    },
    [
      apiKey,
      captureTerminalHistory,
      focusPane,
      getPreferredPaneId,
      importTerminalDiff,
      releaseAllPaneShellSessions,
      releaseHostBridgeSession,
      releaseHistorySyncSession,
      spawnShellSession,
      startTerminalHistorySync,
      teardownWebContainer,
      workdirName,
    ],
  );

  const restartShell = useCallback(
    async (paneId?: PaneId): Promise<void> => {
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
          await spawnShellSession(targetPaneId, { resetTerminal: true, syncManagedFiles: true });
          focusPane(targetPaneId);
        } catch (err) {
          console.error('[terminal] reset failed', err);
          const message = err instanceof Error ? err.message : String(err);
          try {
            terminal.writeln(`[terminal] failed to reset shell: ${message}`);
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
    [focusPane, getPreferredPaneId, hideResetBanner, spawnShellSession],
  );
  restartShellRef.current = restartShell;

  const restartWebContainer = useCallback(async (): Promise<void> => {
    if (restartWebContainerInFlightRef.current) {
      return await restartWebContainerInFlightRef.current;
    }

    const pendingRestart = (async () => {
      if (!paneRuntimesRef.current[getPreferredPaneId()].terminal || unmountedRef.current) return;

      hideResetBanner();
      resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
      setRestartingWebContainer(true);
      try {
        await initializeWebContainerSession({
          forceReboot: true,
          importBeforeReboot: true,
          resetTerminal: true,
          announceRestart: true,
        });
      } catch (err) {
        console.error('[terminal] webcontainer restart failed', err);
        const terminal = paneRuntimesRef.current[getPreferredPaneId()].terminal;
        const message = err instanceof Error ? err.message : String(err);
        if (terminal) {
          try {
            terminal.writeln(`[terminal] failed to restart WebContainer: ${message}`);
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
  }, [getPreferredPaneId, hideResetBanner, initializeWebContainerSession]);

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
    if (splitOpen) return;
    const nextPaneId = otherPaneId(singlePaneIdRef.current);
    setSplitOpen(true);
    setActivePaneId(nextPaneId);
  }, [splitOpen]);

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
    registerImportHandler?.((options) => importTerminalDiff(options));
    return () => {
      registerImportHandler?.(null);
    };
  }, [importTerminalDiff, registerImportHandler]);

  useEffect(() => {
    if (!fsReady) return;
    const intervalId = window.setInterval(() => {
      void importTerminalDiff({ silent: true }).catch((err) => {
        console.error('[terminal] background import failed', err);
      });
    }, TERMINAL_AUTO_IMPORT_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [fsReady, importTerminalDiff]);

  useEffect(() => {
    if (!splitOpen) {
      disposePaneRuntime(otherPaneId(singlePaneId));
      setShellReadyByPane((current) => ({ ...current, [otherPaneId(singlePaneId)]: false }));
    }
  }, [disposePaneRuntime, singlePaneId, splitOpen]);

  useEffect(() => {
    if (!visible || startedRef.current) return;
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
        await ensurePaneSurface(singlePaneIdRef.current);
        if (unmountedRef.current) return;
        await initializeWebContainerSession({ resetTerminal: true });
      } catch (err) {
        if (unmountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to start terminal: ${message}`);
        startedRef.current = false;
      }
    })();
  }, [apiKey, ensurePaneSurface, initializeWebContainerSession, visible]);

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
    if (!fsReady) return;
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
  }, [baseFiles, liveFilePath, fsReady]);

  useEffect(() => {
    if (!fsReady || liveFilePath === null || liveFileContent === null) return;
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
    }, LIVE_FILE_DEBOUNCE_MS);
    return () => {
      if (liveSyncTimerRef.current !== null) {
        window.clearTimeout(liveSyncTimerRef.current);
        liveSyncTimerRef.current = null;
      }
    };
  }, [fsReady, liveFileContent, liveFilePath]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      const currentWc = wcRef.current;
      if (currentWc) {
        void captureTerminalHistory(currentWc).finally(() => {
          flushPersistedTerminalHistory();
        });
      } else {
        flushPersistedTerminalHistory();
      }
      void importTerminalDiff({ silent: true }).catch((err) => {
        console.error('[terminal] import on unmount failed', err);
      });
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
      releaseHistorySyncSession();
      releaseHostBridgeSession();
      releaseAllPaneShellSessions({ invalidate: true });
      paneRuntimesRef.current.primary.disposeSurface?.();
      paneRuntimesRef.current.secondary.disposeSurface?.();
      startedRef.current = false;
      wcRef.current = null;
      setFsReady(false);
      setShellReadyByPane({ primary: false, secondary: false });
      setResetBannerPaneId(null);
      setResettingShell(false);
      setRestartingWebContainer(false);
      lastWrittenRef.current = new Map();
    };
  }, [
    captureTerminalHistory,
    flushPersistedTerminalHistory,
    importTerminalDiff,
    releaseAllPaneShellSessions,
    releaseHistorySyncSession,
    releaseHostBridgeSession,
  ]);

  useEffect(() => {
    const handlePageHide = () => {
      flushPersistedTerminalHistory();
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [flushPersistedTerminalHistory]);

  const activeShellReady = shellReadyByPane[activePaneId];
  const activeShellSessionId = paneRuntimesRef.current[activePaneId].shellSessionId;
  const canManageSplit = !error && !restartingWebContainer && !resettingShell;
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

  return (
    <aside
      class={`terminal-panel${visible ? '' : ' terminal-panel--hidden'}${className ? ` ${className}` : ''}`}
      aria-label="Terminal"
      aria-hidden={visible ? undefined : 'true'}
    >
      {error ? (
        <div class="terminal-panel__error">{error}</div>
      ) : (
        <>
          <div class={`terminal-panel__stack${splitOpen ? ' terminal-panel__stack--split' : ''}`}>
            {visiblePaneIds.map((paneId, index) => (
              <div
                key={paneId}
                class={`terminal-panel__pane${activePaneId === paneId ? ' terminal-panel__pane--active' : ''}`}
                data-pane-position={index === 0 ? 'top' : 'bottom'}
                onPointerDown={() => {
                  setActivePaneId(paneId);
                }}
              >
                <div
                  class="terminal-panel__surface"
                  ref={(node) => {
                    paneRuntimesRef.current[paneId].container = node;
                  }}
                />
                {resetBannerPaneId === paneId ? (
                  <div class="terminal-panel__reset-banner" role="status" aria-live="polite">
                    {resetBannerTextForKey(resetBannerKey)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div class="terminal-panel__overlay-controls">
            <DropdownMenu.Root onOpenChange={blurOnClose}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  class="terminal-panel__menu-trigger"
                  aria-label="Terminal actions"
                  title="Terminal actions"
                >
                  <Power size={14} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="terminal-panel__menu" side="top" align="end" sideOffset={8}>
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    disabled={!canDownloadFromWebContainer}
                    onSelect={() => {
                      void downloadFromWebContainer();
                    }}
                  >
                    Download...
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="terminal-panel__menu-separator" />
                  {!splitOpen ? (
                    <DropdownMenu.Item
                      class="terminal-panel__menu-item"
                      disabled={!canManageSplit}
                      onSelect={openSplitTerminal}
                    >
                      Split terminal
                    </DropdownMenu.Item>
                  ) : (
                    <>
                      <DropdownMenu.Item
                        class="terminal-panel__menu-item"
                        disabled={!canManageSplit}
                        onSelect={() => {
                          closeSplitPane('top');
                        }}
                      >
                        Close top
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="terminal-panel__menu-item"
                        disabled={!canManageSplit}
                        onSelect={() => {
                          closeSplitPane('bottom');
                        }}
                      >
                        Close bottom
                      </DropdownMenu.Item>
                    </>
                  )}
                  <DropdownMenu.Separator class="terminal-panel__menu-separator" />
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    disabled={!canResetTerminal}
                    onSelect={() => {
                      void restartShellRef.current?.();
                    }}
                  >
                    Reset terminal
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    disabled={!canRestartWebContainer}
                    onSelect={() => {
                      void restartWebContainer();
                    }}
                  >
                    Restart WebContainer
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </>
      )}
    </aside>
  );
}
