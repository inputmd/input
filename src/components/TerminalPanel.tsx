import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import type { Terminal as GhosttyTerminal } from 'ghostty-web';
import { Power } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils.ts';
import { shouldBypassTerminalMetaShortcut } from '../keyboard_shortcuts.ts';
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
import { useDialogs } from './DialogProvider';

// Ctrl-C doesn't actually interrupt processes inside WebContainer (upstream
// bug). As a workaround, pressing Ctrl-C twice within this window prompts the
// user to reset the terminal session instead.
const CTRL_C_RESET_WINDOW_MS = 1000;

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

export function TerminalPanel({
  className,
  visible,
  workspaceKey,
  workdirName,
  apiKey,
  baseFiles,
  liveFile,
  onImportDiff,
  registerImportHandler,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const disposeRef = useRef<(() => void) | null>(null);
  const terminalRef = useRef<GhosttyTerminal | null>(null);
  const shellRef = useRef<SpawnedShell | null>(null);
  const shellWriterRef = useRef<WritableStreamDefaultWriter<string> | null>(null);
  const shellSessionIdRef = useRef(0);
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
  // Snapshot of what's been written to the WC FS so far. Updated only AFTER a
  // write/rm lands in the sync queue, so it remains an accurate cache for
  // skipping redundant writes even when the queue is mid-drain. Never used as
  // a baseline for import diffs — see importTerminalDiff for that.
  const lastWrittenRef = useRef<Map<string, string>>(new Map());
  // Latest props, captured each render so boot sees the freshest snapshot.
  const baseFilesRef = useRef(baseFiles);
  baseFilesRef.current = baseFiles;
  const liveFilePath = liveFile?.path ?? null;
  const liveFileContent = liveFile?.content ?? null;
  const liveFilePathRef = useRef<string | null>(liveFilePath);
  liveFilePathRef.current = liveFilePath;
  const liveFileContentRef = useRef<string | null>(liveFileContent);
  liveFileContentRef.current = liveFileContent;
  // Serial sync queue so concurrent file-prop updates can't race against each
  // other or against the initial mount.
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const liveSyncTimerRef = useRef<number | null>(null);
  const [fsReady, setFsReady] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [resettingShell, setResettingShell] = useState(false);
  const [restartingWebContainer, setRestartingWebContainer] = useState(false);
  const onImportDiffRef = useRef(onImportDiff);
  onImportDiffRef.current = onImportDiff;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const importInFlightRef = useRef<Promise<TerminalImportDiff | null> | null>(null);
  const [downloadingPath, setDownloadingPath] = useState(false);
  const { showAlert, showConfirm, showPrompt } = useDialogs();
  const showAlertRef = useRef(showAlert);
  showAlertRef.current = showAlert;
  const showConfirmRef = useRef(showConfirm);
  showConfirmRef.current = showConfirm;
  const showPromptRef = useRef(showPrompt);
  showPromptRef.current = showPrompt;
  // Timestamp of the last Ctrl-C keystroke, used to detect a double-press.
  const lastCtrlCAtRef = useRef<number>(0);
  // True while the reset-session confirm dialog is open, to suppress further
  // Ctrl-C handling until the user responds.
  const ctrlCConfirmOpenRef = useRef(false);
  const restartShellRef = useRef<(() => Promise<void>) | null>(null);
  const canResetTerminal =
    !error && fsReady && !resettingShell && !restartingWebContainer && (shellReady || shellSessionIdRef.current > 0);
  const canRestartWebContainer =
    !error && !resettingShell && !restartingWebContainer && (fsReady || shellSessionIdRef.current > 0);
  const canDownloadFromWebContainer = !error && fsReady && !restartingWebContainer && !downloadingPath;

  const releaseShellSession = useCallback(() => {
    const shell = shellRef.current;
    shellRef.current = null;
    if (shell) {
      try {
        shell.kill();
      } catch {
        // ignore
      }
    }
    const shellWriter = shellWriterRef.current;
    shellWriterRef.current = null;
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
        // Recompute the managed baseline fresh from current props instead of
        // reading a cached mirror. This avoids any window where the baseline
        // is advanced before the corresponding FS write has actually landed.
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
    async (options?: {
      resetTerminal?: boolean;
      syncManagedFiles?: boolean;
      announceReady?: boolean;
    }): Promise<void> => {
      const wc = wcRef.current;
      const terminal = terminalRef.current;
      if (!wc || !terminal) {
        throw new Error('Terminal is not ready.');
      }

      if (options?.syncManagedFiles) {
        await flushManagedSync();
      }

      const sessionId = shellSessionIdRef.current + 1;
      shellSessionIdRef.current = sessionId;
      setShellReady(false);
      releaseShellSession();

      if (options?.resetTerminal) {
        terminal.reset();
      }

      const spawnedShell = await wc.spawn('jsh', []);
      if (unmountedRef.current || shellSessionIdRef.current !== sessionId) {
        try {
          spawnedShell.kill();
        } catch {
          // ignore
        }
        return;
      }

      shellRef.current = spawnedShell;
      const shellWriter = spawnedShell.input.getWriter();
      shellWriterRef.current = shellWriter;

      try {
        spawnedShell.resize({ cols: terminal.cols, rows: terminal.rows });
      } catch {
        // some versions don't support resize before first write
      }

      if (options?.announceReady) {
        terminal.write('Shell spawned.\r\n');
      }

      // Defensive sink: never let an exception inside terminal.write() (e.g. a
      // ghostty-web parser error on an unexpected byte sequence) propagate
      // back to pipeTo, because that would cancel shell.output and break the
      // session — even though jsh is still running.
      void spawnedShell.output
        .pipeTo(
          new WritableStream({
            write(chunk) {
              if (shellSessionIdRef.current !== sessionId) return;
              try {
                terminal.write(chunk);
              } catch (err) {
                console.error('[terminal] write failed; chunk dropped', err);
              }
            },
          }),
        )
        .catch((err) => {
          if (shellSessionIdRef.current !== sessionId) return;
          console.error('[terminal] output pipe closed', err);
        });

      setShellReady(true);
    },
    [flushManagedSync, releaseShellSession],
  );

  const initializeWebContainerSession = useCallback(
    async (options?: {
      forceReboot?: boolean;
      importBeforeReboot?: boolean;
      resetTerminal?: boolean;
      announceRestart?: boolean;
    }): Promise<void> => {
      const terminal = terminalRef.current;
      if (!terminal) {
        throw new Error('Terminal is not ready.');
      }

      const previousWc = wcRef.current;
      const sessionId = webContainerSessionIdRef.current + 1;
      webContainerSessionIdRef.current = sessionId;
      restartInFlightRef.current = null;
      releaseHistorySyncSession();
      shellSessionIdRef.current += 1;
      setFsReady(false);
      setShellReady(false);

      if (options?.resetTerminal) {
        terminal.reset();
      }
      if (options?.announceRestart) {
        terminal.write('Restarting WebContainer...\r\n');
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

      releaseShellSession();

      if (options?.forceReboot) {
        teardownWebContainer(previousWc);
      }

      terminal.write('Booting WebContainer...\r\n');
      const wc = await bootWebContainer(apiKey, workdirName);
      if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
        return;
      }

      // Clear any state from a previous mount (e.g. another workspace) and
      // populate the FS with the latest workspace files before spawning a shell.
      terminal.write('Mounting workspace files...\r\n');
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

      // After mount(), the FS contains exactly initialFiles, so we can seed
      // the write-skip cache to match. This is the one place where it's safe
      // to set lastWrittenRef synchronously: the awaited mount() above is the
      // write that lands the bytes, and no other queue work is in flight yet
      // (sessionId guards above ensure prior sessions are aborted).
      lastWrittenRef.current = new Map(Object.entries(initialFiles));
      wcRef.current = wc;
      setFsReady(true);

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

      terminal.write('Spawning jsh...\r\n');
      await spawnShellSession({ announceReady: true });
      if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
        return;
      }

      try {
        await startTerminalHistorySync(wc);
      } catch (err) {
        console.error('[terminal] failed to start jsh history watcher', err);
        terminal.write(
          `[terminal] failed to start jsh history watcher: ${err instanceof Error ? err.message : String(err)}\r\n`,
        );
      }

      window.requestAnimationFrame(() => {
        try {
          terminal.focus();
        } catch {
          // ignore
        }
      });
    },
    [
      apiKey,
      captureTerminalHistory,
      importTerminalDiff,
      releaseHistorySyncSession,
      releaseShellSession,
      spawnShellSession,
      startTerminalHistorySync,
      teardownWebContainer,
      workdirName,
    ],
  );

  const restartShell = useCallback(async (): Promise<void> => {
    if (restartInFlightRef.current) {
      return await restartInFlightRef.current;
    }

    const pendingRestart = (async () => {
      const terminal = terminalRef.current;
      const wc = wcRef.current;
      if (!terminal || !wc || unmountedRef.current) return;

      setResettingShell(true);
      try {
        await spawnShellSession({ resetTerminal: true, syncManagedFiles: true });
        window.requestAnimationFrame(() => {
          try {
            terminal.focus();
          } catch {
            // ignore
          }
        });
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
  }, [spawnShellSession]);
  restartShellRef.current = restartShell;

  const restartWebContainer = useCallback(async (): Promise<void> => {
    if (restartWebContainerInFlightRef.current) {
      return await restartWebContainerInFlightRef.current;
    }

    const pendingRestart = (async () => {
      if (!terminalRef.current || unmountedRef.current) return;

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
        const terminal = terminalRef.current;
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
  }, [initializeWebContainerSession]);

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
    if (!visible) return;
    if (disposeRef.current) {
      window.requestAnimationFrame(() => {
        try {
          if (terminalRef.current && containerRef.current) {
            fitTerminal(terminalRef.current, containerRef.current);
          }
        } catch {
          // ignore
        }
      });
      return;
    }
    // Boot lazily the first time the panel becomes visible. After that we keep
    // the session mounted while hidden, but skip visible-only work.
    if (startedRef.current || !containerRef.current) return;
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

    (async () => {
      let term: GhosttyTerminal | null = null;
      let resizeObserver: ResizeObserver | null = null;
      let resizeFrameId: number | null = null;
      let layoutSettledTimeoutId: number | null = null;
      let layoutSettledHandler: (() => void) | null = null;
      let onDataDispose: { dispose: () => void } | null = null;
      let onResizeDispose: { dispose: () => void } | null = null;
      let metaKeyBypassTarget: HTMLElement | null = null;
      let metaKeyBypassHandler: ((event: KeyboardEvent) => void) | null = null;
      const cleanup = () => {
        const currentWc = wcRef.current;
        if (currentWc) {
          void captureTerminalHistory(currentWc).finally(() => {
            flushPersistedTerminalHistory();
          });
        } else {
          flushPersistedTerminalHistory();
        }
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (resizeFrameId !== null) {
          window.cancelAnimationFrame(resizeFrameId);
          resizeFrameId = null;
        }
        if (layoutSettledTimeoutId !== null) {
          window.clearTimeout(layoutSettledTimeoutId);
          layoutSettledTimeoutId = null;
        }
        if (layoutSettledHandler) {
          window.removeEventListener(LAYOUT_SETTLED_EVENT, layoutSettledHandler);
          layoutSettledHandler = null;
        }
        onDataDispose?.dispose();
        onDataDispose = null;
        onResizeDispose?.dispose();
        onResizeDispose = null;
        if (metaKeyBypassTarget && metaKeyBypassHandler) {
          metaKeyBypassTarget.removeEventListener('keydown', metaKeyBypassHandler, true);
        }
        metaKeyBypassTarget = null;
        metaKeyBypassHandler = null;
        restartInFlightRef.current = null;
        restartWebContainerInFlightRef.current = null;
        shellSessionIdRef.current += 1;
        webContainerSessionIdRef.current += 1;
        releaseHistorySyncSession();
        setShellReady(false);
        setFsReady(false);
        setRestartingWebContainer(false);
        if (terminalRef.current === term) terminalRef.current = null;
        if (disposeRef.current === cleanup) disposeRef.current = null;
        wcRef.current = null;
        releaseShellSession();
        term?.dispose();
        term = null;
      };

      try {
        const { Terminal } = await loadGhosttyWeb();

        if (unmountedRef.current) return;

        const terminal = new Terminal({
          convertEol: true,
          cursorBlink: false,
          cursorStyle: 'block',
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: 14.5,
          theme: { background: '#0b0b0b' },
        });
        term = terminal;
        if (unmountedRef.current || !containerRef.current) {
          cleanup();
          return;
        }
        terminal.open(containerRef.current);
        disposeRef.current = cleanup;
        terminalRef.current = terminal;
        fitTerminal(terminal, containerRef.current);

        // 2x scroll lines per wheel tick. Bypasses ghostty's smooth-scroll
        // animation entirely (scrollLines jumps directly).
        terminal.attachCustomWheelEventHandler((event) => {
          if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
          const charHeight = terminal.renderer?.charHeight ?? 20;
          const lines = (event.deltaY / charHeight) * 2;
          if (lines !== 0) {
            terminal.scrollLines(lines);
          }
          return true;
        });

        // Let browser shortcuts (Cmd+R, Cmd+L, Cmd+T, etc.) bypass the
        // terminal. Ghostty's textarea listener encodes Cmd-modified keys and
        // calls preventDefault, swallowing them. We install a capturing
        // listener on the panel container that runs first, and stopPropagation
        // (without preventDefault) so the browser default still fires while
        // ghostty never sees the event. Cmd+C / Cmd+V keep ghostty's clipboard
        // handling, and Cmd+K is allowed through to the terminal.
        const onMetaKeyDown = (event: KeyboardEvent) => {
          if (!shouldBypassTerminalMetaShortcut(event)) return;
          event.stopPropagation();
        };
        containerRef.current.addEventListener('keydown', onMetaKeyDown, true);
        metaKeyBypassTarget = containerRef.current;
        metaKeyBypassHandler = onMetaKeyDown;

        const scheduleFit = () => {
          if (!term || !containerRef.current) return;
          if (resizeFrameId !== null) return;
          resizeFrameId = window.requestAnimationFrame(() => {
            resizeFrameId = null;
            try {
              if (term && containerRef.current) fitTerminal(term, containerRef.current);
            } catch {
              // ignore
            }
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
        resizeObserver = new ResizeObserver(() => {
          scheduleFit();
        });
        resizeObserver.observe(containerRef.current);
        layoutSettledHandler = onLayoutSettled;
        window.addEventListener(LAYOUT_SETTLED_EVENT, onLayoutSettled);

        await initializeWebContainerSession({ resetTerminal: true });
        if (unmountedRef.current) {
          cleanup();
          return;
        }

        onDataDispose = terminal.onData((data) => {
          // Intercept Ctrl-C. WebContainer's shell doesn't actually deliver
          // SIGINT to running processes, so pressing Ctrl-C twice in quick
          // succession prompts the user to reset the session instead.
          if (data === '\x03') {
            if (ctrlCConfirmOpenRef.current) return;
            const now = Date.now();
            const previous = lastCtrlCAtRef.current;
            if (previous && now - previous <= CTRL_C_RESET_WINDOW_MS) {
              lastCtrlCAtRef.current = 0;
              ctrlCConfirmOpenRef.current = true;
              void (async () => {
                try {
                  const confirmed = await showConfirmRef.current(
                    'Ctrl-C does not interrupt running processes in this terminal. Reset the terminal session instead?',
                    {
                      intent: 'danger',
                      title: 'Reset terminal session?',
                      confirmLabel: 'Reset',
                      cancelLabel: 'Cancel',
                      defaultFocus: 'action',
                    },
                  );
                  if (confirmed) {
                    await restartShellRef.current?.();
                  }
                } finally {
                  ctrlCConfirmOpenRef.current = false;
                }
              })();
              return;
            }
            lastCtrlCAtRef.current = now;
          } else {
            lastCtrlCAtRef.current = 0;
          }
          const shellWriter = shellWriterRef.current;
          if (!shellWriter) return;
          shellWriter.write(data).catch((err) => {
            console.error('[terminal] input write failed', err);
          });
        });
        onResizeDispose = terminal.onResize(({ cols, rows }) => {
          const shell = shellRef.current;
          if (!shell) return;
          try {
            shell.resize({ cols, rows });
          } catch {
            // ignore
          }
        });
      } catch (err) {
        cleanup();
        if (unmountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to start terminal: ${message}`);
        startedRef.current = false;
      }
    })();
  }, [
    visible,
    apiKey,
    captureTerminalHistory,
    flushPersistedTerminalHistory,
    initializeWebContainerSession,
    releaseHistorySyncSession,
    releaseShellSession,
  ]);

  // Sync structural changes immediately: base snapshot updates, active file
  // path switches, and leaving edit mode. This avoids whole-tree work on each
  // keystroke while keeping the managed FS authoritative.
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

  // Debounced one-way sync for the active editor buffer. Fast typing updates a
  // single file path after the user pauses, instead of diffing the whole tree.
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
  }, [fsReady, liveFilePath, liveFileContent]);

  // Tear down the terminal surface and spawned shell only when the component fully unmounts.
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      if (!disposeRef.current) {
        const currentWc = wcRef.current;
        if (currentWc) {
          void captureTerminalHistory(currentWc).finally(() => {
            flushPersistedTerminalHistory();
          });
        } else {
          flushPersistedTerminalHistory();
        }
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
      restartInFlightRef.current = null;
      restartWebContainerInFlightRef.current = null;
      shellSessionIdRef.current += 1;
      webContainerSessionIdRef.current += 1;
      releaseHistorySyncSession();
      disposeRef.current?.();
      disposeRef.current = null;
      terminalRef.current = null;
      releaseShellSession();
      startedRef.current = false;
      wcRef.current = null;
      setFsReady(false);
      setShellReady(false);
      setResettingShell(false);
      setRestartingWebContainer(false);
      lastWrittenRef.current = new Map();
    };
  }, [
    captureTerminalHistory,
    flushPersistedTerminalHistory,
    importTerminalDiff,
    releaseHistorySyncSession,
    releaseShellSession,
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
          <div class="terminal-panel__surface" ref={containerRef} />
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
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    disabled={!canResetTerminal}
                    onSelect={() => {
                      void restartShell();
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
