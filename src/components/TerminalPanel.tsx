import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import type { Terminal as GhosttyTerminal } from 'ghostty-web';
import { Power } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils.ts';
import { matchesControlShortcut, shouldBypassTerminalMetaShortcut } from '../keyboard_shortcuts.ts';
import { isLikelyBinaryBytes } from '../path_utils.ts';
import {
  buildPersistedHomeSeed,
  buildPersistedHomeSyncScript,
  loadPersistedHomeEntries,
  PERSISTED_HOME_SEED_FILENAME,
  PERSISTED_HOME_SYNC_SCRIPT_FILENAME,
  type PersistedHomeEntry,
  persistPersistedHomeEntries,
} from '../persisted_home_state.ts';
import {
  buildTerminalImportDiff,
  shouldImportTerminalPath,
  type TerminalImportDiff,
  type TerminalImportOptions,
} from '../repo_workspace/terminal_sync.ts';
import {
  buildWebContainerHomeOverlayProvisionScript,
  WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL,
} from '../webcontainer_home_overlay.ts';
import { startWebContainerHostBridge, type WebContainerHostBridgeSession } from '../webcontainer_host_bridge.ts';
import { useDialogs } from './DialogProvider';
import { consumeTerminalPixelWheelDelta } from './terminal_wheel.ts';

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
   * Whether `baseFiles` is ready to be treated as authoritative. This prevents
   * transient snapshot gaps (for example during hot reload) from being
   * interpreted as mass deletions.
   */
  baseFilesReady: boolean;
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

interface TerminalPanelGlobalState {
  ghosttyInitPromise: Promise<void> | null;
  lastHotReloadAt: number;
  webContainerBootPromise: Promise<WebContainer> | null;
  webContainerBootWorkdirName: string | null;
}

type TerminalPanelGlobalThis = typeof globalThis & {
  __inputTerminalPanelGlobalState__?: TerminalPanelGlobalState;
};

function getTerminalPanelGlobalState(): TerminalPanelGlobalState {
  const root = globalThis as TerminalPanelGlobalThis;
  root.__inputTerminalPanelGlobalState__ ??= {
    ghosttyInitPromise: null,
    lastHotReloadAt: 0,
    webContainerBootPromise: null,
    webContainerBootWorkdirName: null,
  };
  return root.__inputTerminalPanelGlobalState__;
}

const HOT_RELOAD_UNMOUNT_IMPORT_GUARD_WINDOW_MS = 2000;

function didRecentHotReload(): boolean {
  return Date.now() - getTerminalPanelGlobalState().lastHotReloadAt <= HOT_RELOAD_UNMOUNT_IMPORT_GUARD_WINDOW_MS;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    getTerminalPanelGlobalState().lastHotReloadAt = Date.now();
  });
}

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
  const globalState = getTerminalPanelGlobalState();
  if (globalState.webContainerBootPromise && globalState.webContainerBootWorkdirName === workdirName) {
    return globalState.webContainerBootPromise;
  }
  if (globalState.webContainerBootPromise && globalState.webContainerBootWorkdirName !== workdirName) {
    try {
      const wc = await globalState.webContainerBootPromise;
      wc.teardown();
    } catch {
      // ignore boot/teardown failures and attempt a clean reboot below
    } finally {
      globalState.webContainerBootPromise = null;
      globalState.webContainerBootWorkdirName = null;
    }
  }
  globalState.webContainerBootPromise = (async () => {
    const { WebContainer, configureAPIKey } = await import('@webcontainer/api');
    // The WebContainer dashboard checks the Referer against its allowed-sites
    // list when configureAPIKey() is set, and it does not accept localhost.
    // On localhost, boot unauthenticated — that path works without a key.
    if (apiKey && !isLocalhostHostname()) {
      configureAPIKey(apiKey);
    }
    return WebContainer.boot({ coep: 'credentialless', workdirName });
  })();
  globalState.webContainerBootWorkdirName = workdirName;
  try {
    return await globalState.webContainerBootPromise;
  } catch (err) {
    globalState.webContainerBootPromise = null;
    globalState.webContainerBootWorkdirName = null;
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
const PERSISTED_HOME_STATE_PERSIST_DEBOUNCE_MS = 250;

type TerminalBootPerfValue = boolean | null | number | string;
type TerminalBootPerfDetails = Record<string, TerminalBootPerfValue>;

interface TerminalBootPerfLogger {
  complete: (status: 'cancelled' | 'error' | 'ok', details?: TerminalBootPerfDetails) => void;
  measure: <T>(stage: string, fn: () => Promise<T>, details?: TerminalBootPerfDetails) => Promise<T>;
  record: (stage: string, durationMs: number, details?: TerminalBootPerfDetails) => void;
}

interface TerminalBootPerfStage {
  details?: TerminalBootPerfDetails;
  durationMs: number;
  error?: string;
  stage: string;
  status: 'error' | 'ok';
}

function joinHomePath(homeDir: string, fileName: string): string {
  return `${homeDir.replace(/\/+$/, '')}/${fileName}`;
}

function logPersistedHomePaths(level: 'log' | 'info', message: string, entries: PersistedHomeEntry[]): void {
  const paths = entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  console[level](message, paths);
}

function bootPerfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function createTerminalBootPerfLogger(workspaceKey: string, workdirName: string): TerminalBootPerfLogger {
  const bootStartedAt = bootPerfNow();
  const stages: TerminalBootPerfStage[] = [];
  let completed = false;

  const pushStage = (
    stage: string,
    durationMs: number,
    status: 'error' | 'ok',
    details?: TerminalBootPerfDetails,
    error?: string,
  ) => {
    stages.push({
      stage,
      durationMs,
      status,
      details,
      error,
    });
  };

  return {
    async measure<T>(stage: string, fn: () => Promise<T>, details?: TerminalBootPerfDetails): Promise<T> {
      const startedAt = bootPerfNow();
      try {
        const result = await fn();
        pushStage(stage, bootPerfNow() - startedAt, 'ok', details);
        return result;
      } catch (err) {
        pushStage(stage, bootPerfNow() - startedAt, 'error', details, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    record(stage: string, durationMs: number, details?: TerminalBootPerfDetails): void {
      pushStage(stage, durationMs, 'ok', details);
    },
    complete(status: 'cancelled' | 'error' | 'ok', details?: TerminalBootPerfDetails): void {
      if (completed) return;
      completed = true;
      const totalMs = bootPerfNow() - bootStartedAt;
      console.groupCollapsed(`[terminal-perf] boot ${workdirName} (${Math.round(totalMs)}ms)`);
      console.info('[terminal-perf] summary', {
        workspaceKey,
        workdirName,
        status,
        total_ms: Number(totalMs.toFixed(1)),
        ...details,
      });
      console.table(
        stages.map((entry) => ({
          stage: entry.stage,
          status: entry.status,
          duration_ms: Number(entry.durationMs.toFixed(1)),
          error: entry.error ?? '',
          ...entry.details,
        })),
      );
      console.groupEnd();
    },
  };
}

async function measureBootStage<T>(
  bootPerf: TerminalBootPerfLogger | undefined,
  stage: string,
  fn: () => Promise<T>,
  details?: TerminalBootPerfDetails,
): Promise<T> {
  if (!bootPerf) return await fn();
  return await bootPerf.measure(stage, fn, details);
}

async function resolveWebContainerHomeDirectory(wc: WebContainer): Promise<string> {
  const process = await wc.spawn('node', ['-p', 'process.env.HOME']);
  const [output, exitCode] = await Promise.all([readStreamFully(process.output), process.exit]);
  if (exitCode !== 0) {
    throw new Error(`node -p process.env.HOME exited with code ${exitCode}`);
  }
  const homeDir = output.trim();
  if (!homeDir) {
    throw new Error('WebContainer HOME is empty');
  }
  return homeDir;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function writeContainerFile(wc: WebContainer, filePath: string, content: string): Promise<void> {
  await writeContainerBytesFile(wc, filePath, new TextEncoder().encode(content));
}

async function writeContainerBytesFile(wc: WebContainer, filePath: string, content: Uint8Array): Promise<void> {
  const process = await wc.spawn('node', [
    '-e',
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "const targetPath = process.argv[1] || '';",
      "const encodedContent = process.argv[2] || '';",
      "if (!targetPath) throw new Error('Missing target path');",
      'fs.mkdirSync(path.dirname(targetPath), { recursive: true });',
      'fs.writeFileSync(targetPath, Buffer.from(encodedContent, "base64"));',
    ].join(' '),
    filePath,
    encodeBase64Bytes(content),
  ]);
  const [output, exitCode] = await Promise.all([readStreamFully(process.output), process.exit]);
  if (exitCode !== 0) {
    throw new Error(`node write helper exited with code ${exitCode}; output=${JSON.stringify(output)}`);
  }
}

async function removeContainerAbsolutePath(wc: WebContainer, filePath: string): Promise<void> {
  const process = await wc.spawn('node', [
    '-e',
    [
      "const fs = require('fs');",
      "const targetPath = process.argv[1] || '';",
      "if (!targetPath) throw new Error('Missing target path');",
      'fs.rmSync(targetPath, { force: true, recursive: true });',
    ].join(' '),
    filePath,
  ]);
  const [output, exitCode] = await Promise.all([readStreamFully(process.output), process.exit]);
  if (exitCode !== 0) {
    throw new Error(`node remove helper exited with code ${exitCode}; output=${JSON.stringify(output)}`);
  }
}

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

async function provisionHomeOverlay(
  wc: WebContainer,
  bootPerf?: TerminalBootPerfLogger,
): Promise<{ archiveBytes: number }> {
  const [archive, homeDir] = await Promise.all([
    measureBootStage(bootPerf, 'overlay.fetchArchive', () => fetchWebContainerHomeOverlayArchive()),
    measureBootStage(bootPerf, 'overlay.resolveHomeDirectory', () => resolveWebContainerHomeDirectory(wc)),
  ]);
  const archivePath = joinHomePath(homeDir, HOME_OVERLAY_ARCHIVE_FILENAME);
  const provisionScriptPath = joinHomePath(homeDir, HOME_OVERLAY_PROVISION_FILENAME);
  const provisionScript = buildWebContainerHomeOverlayProvisionScript(HOME_OVERLAY_ARCHIVE_FILENAME);
  await measureBootStage(bootPerf, 'overlay.writeArchive', () => writeContainerBytesFile(wc, archivePath, archive), {
    archive_bytes: archive.byteLength,
  });
  await measureBootStage(
    bootPerf,
    'overlay.writeProvisionScript',
    () => writeContainerFile(wc, provisionScriptPath, provisionScript),
    {
      script_bytes: provisionScript.length,
    },
  );
  try {
    await measureBootStage(
      bootPerf,
      'overlay.provisionFiles',
      async () => {
        const provision = await wc.spawn('node', [provisionScriptPath]);
        const [output, exitCode] = await Promise.all([readStreamFully(provision.output), provision.exit]);
        if (exitCode !== 0) {
          throw new Error(`node overlay provision exited with code ${exitCode}; output=${JSON.stringify(output)}`);
        }
      },
      {
        archive_bytes: archive.byteLength,
      },
    );
  } finally {
    try {
      await removeContainerAbsolutePath(wc, provisionScriptPath);
    } catch {
      // best-effort cleanup
    }
    try {
      await removeContainerAbsolutePath(wc, archivePath);
    } catch {
      // best-effort cleanup
    }
  }
  return { archiveBytes: archive.byteLength };
}

async function preparePersistedHomeSupportFiles(wc: WebContainer, homeDir: string): Promise<string> {
  const scriptPath = joinHomePath(homeDir, PERSISTED_HOME_SYNC_SCRIPT_FILENAME);
  const seedPath = joinHomePath(homeDir, PERSISTED_HOME_SEED_FILENAME);
  await writeContainerFile(wc, scriptPath, buildPersistedHomeSyncScript(seedPath));
  return scriptPath;
}

async function restorePersistedHomeForWorkspace(
  wc: WebContainer,
  workspaceKey: string,
  homeDir: string,
  scriptPath: string,
  bootPerf?: TerminalBootPerfLogger,
): Promise<{ entryCount: number }> {
  const entries = await measureBootStage(bootPerf, 'persistedHome.loadEntries', () =>
    loadPersistedHomeEntries(workspaceKey),
  );
  await measureBootStage(
    bootPerf,
    'persistedHome.writeSeedFile',
    () => writeContainerFile(wc, joinHomePath(homeDir, PERSISTED_HOME_SEED_FILENAME), buildPersistedHomeSeed(entries)),
    {
      entry_count: entries.length,
    },
  );
  await measureBootStage(
    bootPerf,
    'persistedHome.restoreEntries',
    async () => {
      const restore = await wc.spawn('node', [scriptPath, 'restore']);
      const [output, exitCode] = await Promise.all([readStreamFully(restore.output), restore.exit]);
      if (exitCode !== 0) {
        throw new Error(`node persisted home restore exited with code ${exitCode}; output=${JSON.stringify(output)}`);
      }
    },
    {
      entry_count: entries.length,
    },
  );
  logPersistedHomePaths('log', '[terminal] restored persisted home entries into terminal session', entries);
  return { entryCount: entries.length };
}

async function readPersistedHomeEntriesForWorkspace(
  wc: WebContainer,
  scriptPath: string,
): Promise<PersistedHomeEntry[]> {
  const reader = await wc.spawn('node', [scriptPath, 'snapshot']);
  const [output, exitCode] = await Promise.all([readStreamFully(reader.output), reader.exit]);
  if (exitCode !== 0) {
    throw new Error(`node persisted home snapshot exited with code ${exitCode}`);
  }
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return [];
  const parsed = JSON.parse(line) as { type?: string; entries?: unknown };
  if (parsed.type !== 'snapshot' || !Array.isArray(parsed.entries)) return [];
  return parsed.entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const path = (entry as { path?: unknown }).path;
    const content = (entry as { content?: unknown }).content;
    const mtime = (entry as { mtime?: unknown }).mtime;
    if (typeof path !== 'string' || typeof content !== 'string') return [];
    return [{ path, content, mtime: typeof mtime === 'number' && Number.isFinite(mtime) ? Math.trunc(mtime) : null }];
  });
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
  const globalState = getTerminalPanelGlobalState();
  if (!globalState.ghosttyInitPromise) {
    globalState.ghosttyInitPromise = module.init().catch((err) => {
      globalState.ghosttyInitPromise = null;
      throw err;
    });
  }
  await globalState.ghosttyInitPromise;
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
    ? 'Press Ctrl-\\ again to reset this terminal'
    : 'Press Ctrl-C again to reset this terminal';
}

export function TerminalPanel({
  className,
  visible,
  workspaceKey,
  workdirName,
  apiKey,
  baseFiles,
  baseFilesReady,
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
  const persistedHomeSyncRef = useRef<SpawnedShell | null>(null);
  const persistedHomeSyncProcessIdRef = useRef(0);
  const persistedHomeSyncOutputBufferRef = useRef('');
  const persistedHomePersistTimerRef = useRef<number | null>(null);
  const pendingPersistedHomeEntriesRef = useRef<PersistedHomeEntry[] | null>(null);
  const webContainerSessionIdRef = useRef(0);
  const restartInFlightRef = useRef<Promise<void> | null>(null);
  const restartWebContainerInFlightRef = useRef<Promise<void> | null>(null);
  const unmountedRef = useRef(false);
  const wcRef = useRef<WebContainer | null>(null);
  const lastWrittenRef = useRef<Map<string, string>>(new Map());
  const baseFilesRef = useRef(baseFiles);
  baseFilesRef.current = baseFiles;
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
  const persistedHomeScriptPathRef = useRef<string | null>(null);
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
  const restartShellRef = useRef<((paneId?: PaneId, options?: { clearTerminal?: boolean }) => Promise<void>) | null>(
    null,
  );
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

  const flushPersistedHomeState = useCallback(async () => {
    if (persistedHomePersistTimerRef.current !== null) {
      window.clearTimeout(persistedHomePersistTimerRef.current);
      persistedHomePersistTimerRef.current = null;
    }
    const pendingEntries = pendingPersistedHomeEntriesRef.current;
    if (pendingEntries === null) return;
    pendingPersistedHomeEntriesRef.current = null;
    await persistPersistedHomeEntries(workspaceKeyRef.current, pendingEntries);
    logPersistedHomePaths('info', '[terminal] updated browser persisted home entries', pendingEntries);
  }, []);

  const persistPersistedHomeStateImmediately = useCallback(async (entries: PersistedHomeEntry[]) => {
    if (persistedHomePersistTimerRef.current !== null) {
      window.clearTimeout(persistedHomePersistTimerRef.current);
      persistedHomePersistTimerRef.current = null;
    }
    pendingPersistedHomeEntriesRef.current = null;
    await persistPersistedHomeEntries(workspaceKeyRef.current, entries);
    logPersistedHomePaths('info', '[terminal] updated browser persisted home entries', entries);
  }, []);

  const schedulePersistedHomeState = useCallback((entries: PersistedHomeEntry[]) => {
    pendingPersistedHomeEntriesRef.current = entries;
    if (persistedHomePersistTimerRef.current !== null) {
      window.clearTimeout(persistedHomePersistTimerRef.current);
    }
    persistedHomePersistTimerRef.current = window.setTimeout(() => {
      persistedHomePersistTimerRef.current = null;
      const nextEntries = pendingPersistedHomeEntriesRef.current;
      if (nextEntries === null) return;
      pendingPersistedHomeEntriesRef.current = null;
      void persistPersistedHomeEntries(workspaceKeyRef.current, nextEntries).then(
        () => {
          logPersistedHomePaths('info', '[terminal] updated browser persisted home entries', nextEntries);
        },
        (err) => {
          console.error('[terminal] failed to persist managed home state', err);
        },
      );
    }, PERSISTED_HOME_STATE_PERSIST_DEBOUNCE_MS);
  }, []);

  const releasePersistedHomeSyncSession = useCallback(() => {
    persistedHomeSyncProcessIdRef.current += 1;
    persistedHomeSyncOutputBufferRef.current = '';
    const process = persistedHomeSyncRef.current;
    persistedHomeSyncRef.current = null;
    if (!process) return;
    try {
      process.kill();
    } catch {
      // ignore
    }
  }, []);

  const capturePersistedHomeState = useCallback(
    async (wc: WebContainer | null, options?: { immediate?: boolean }): Promise<void> => {
      if (!wc) return;
      const scriptPath = persistedHomeScriptPathRef.current;
      if (!scriptPath) return;
      try {
        const entries = await readPersistedHomeEntriesForWorkspace(wc, scriptPath);
        if (options?.immediate) {
          await persistPersistedHomeStateImmediately(entries);
          return;
        }
        schedulePersistedHomeState(entries);
      } catch (err) {
        console.error('[terminal] failed to capture managed home state', err);
      }
    },
    [persistPersistedHomeStateImmediately, schedulePersistedHomeState],
  );

  const startPersistedHomeSync = useCallback(
    async (wc: WebContainer): Promise<void> => {
      releasePersistedHomeSyncSession();
      const scriptPath = persistedHomeScriptPathRef.current;
      if (!scriptPath) return;
      const processId = persistedHomeSyncProcessIdRef.current + 1;
      persistedHomeSyncProcessIdRef.current = processId;
      persistedHomeSyncOutputBufferRef.current = '';

      const watcher = await wc.spawn('node', [scriptPath, 'watch']);
      if (unmountedRef.current || wcRef.current !== wc || persistedHomeSyncProcessIdRef.current !== processId) {
        try {
          watcher.kill();
        } catch {
          // ignore
        }
        return;
      }

      persistedHomeSyncRef.current = watcher;
      void watcher.output
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              if (persistedHomeSyncProcessIdRef.current !== processId) return;
              persistedHomeSyncOutputBufferRef.current += chunk;
              while (true) {
                const newlineIndex = persistedHomeSyncOutputBufferRef.current.indexOf('\n');
                if (newlineIndex === -1) break;
                const line = persistedHomeSyncOutputBufferRef.current.slice(0, newlineIndex).trim();
                persistedHomeSyncOutputBufferRef.current = persistedHomeSyncOutputBufferRef.current.slice(
                  newlineIndex + 1,
                );
                if (!line) continue;
                try {
                  const parsed = JSON.parse(line) as { type?: string; entries?: unknown };
                  if (parsed.type !== 'snapshot' || !Array.isArray(parsed.entries)) continue;
                  const entries = parsed.entries.flatMap((entry) => {
                    if (!entry || typeof entry !== 'object') return [];
                    const path = (entry as { path?: unknown }).path;
                    const content = (entry as { content?: unknown }).content;
                    const mtime = (entry as { mtime?: unknown }).mtime;
                    if (typeof path !== 'string' || typeof content !== 'string') return [];
                    return [
                      {
                        path,
                        content,
                        mtime: typeof mtime === 'number' && Number.isFinite(mtime) ? Math.trunc(mtime) : null,
                      },
                    ];
                  });
                  schedulePersistedHomeState(entries);
                } catch (err) {
                  console.error('[terminal] failed to parse managed home state event', err);
                }
              }
            },
          }),
        )
        .catch((err) => {
          if (persistedHomeSyncProcessIdRef.current !== processId) return;
          console.error('[terminal] managed home state watcher closed', err);
        });
    },
    [releasePersistedHomeSyncSession, schedulePersistedHomeState],
  );

  const teardownWebContainer = useCallback((wc: WebContainer | null) => {
    const globalState = getTerminalPanelGlobalState();
    if (!wc) {
      globalState.webContainerBootPromise = null;
      globalState.webContainerBootWorkdirName = null;
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
      globalState.webContainerBootPromise = null;
      globalState.webContainerBootWorkdirName = null;
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

      if (options?.clearTerminal) {
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
        showResetBanner(paneId, key);
        return false;
      }

      if (shellExited) {
        hideResetBanner();
        resetWarningStateRef.current = { paneId: null, key: null, stage: 0, at: 0 };
        void restartShellRef.current?.(paneId);
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
      clearTerminal?: boolean;
      announceRestart?: boolean;
    }): Promise<void> => {
      const logPaneId = getPreferredPaneId();
      const terminal = paneRuntimesRef.current[logPaneId].terminal;
      if (!terminal) {
        throw new Error('Terminal is not ready.');
      }
      const bootPerf = createTerminalBootPerfLogger(workspaceKeyRef.current, workdirName);
      let bootStatus: 'cancelled' | 'error' | 'ok' = 'ok';

      const previousWc = wcRef.current;
      const sessionId = webContainerSessionIdRef.current + 1;
      webContainerSessionIdRef.current = sessionId;
      restartInFlightRef.current = null;
      releasePersistedHomeSyncSession();
      releaseHostBridgeSession();
      releaseAllPaneShellSessions({ invalidate: true });
      setFsReady(false);
      setShellReadyByPane({ primary: false, secondary: false });

      if (options?.clearTerminal) {
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
        await capturePersistedHomeState(previousWc, { immediate: true });
      }

      if (options?.forceReboot) {
        teardownWebContainer(previousWc);
      }

      try {
        terminal.write('Booting WebContainer...\r\n');
        const wc = await bootPerf.measure('bootWebContainer', () => bootWebContainer(apiKey, workdirName));
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          bootStatus = 'cancelled';
          return;
        }

        terminal.write('Clearing workspace...\r\n');
        await bootPerf.measure('clearWorkspace', () => clearWorkdir(wc));
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          bootStatus = 'cancelled';
          return;
        }

        const initialFilesStartedAt = bootPerfNow();
        const initialFiles = buildManagedFiles(
          baseFilesRef.current,
          liveFilePathRef.current,
          liveFileContentRef.current,
        );
        const initialFileCount = Object.keys(initialFiles).length;
        const initialTree = buildFileSystemTree(initialFiles);
        bootPerf.record('prepareWorkspaceTree', bootPerfNow() - initialFilesStartedAt, {
          managed_file_count: initialFileCount,
        });

        terminal.write(`Mounting workspace files into /home/${workdirName}...\r\n`);
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

        try {
          terminal.write('Mounting installed applications...\r\n');
          const overlayResult = await provisionHomeOverlay(wc, bootPerf);
          bootPerf.record('overlay.summary', 0, { archive_bytes: overlayResult.archiveBytes });
        } catch (err) {
          console.error('[terminal] failed to provision home overlay', err);
          terminal.write(
            `[terminal] failed to provision home overlay: ${err instanceof Error ? err.message : String(err)}\r\n`,
          );
        }

        try {
          terminal.write('Restoring persisted home...\r\n');
          const homeDir = await bootPerf.measure('persistedHome.resolveHomeDirectory', () =>
            resolveWebContainerHomeDirectory(wc),
          );
          persistedHomeScriptPathRef.current = await bootPerf.measure('persistedHome.writeSupportScript', () =>
            preparePersistedHomeSupportFiles(wc, homeDir),
          );
          const persistedHomeResult = await restorePersistedHomeForWorkspace(
            wc,
            workspaceKeyRef.current,
            homeDir,
            persistedHomeScriptPathRef.current,
            bootPerf,
          );
          bootPerf.record('persistedHome.summary', 0, { entry_count: persistedHomeResult.entryCount });
        } catch (err) {
          persistedHomeScriptPathRef.current = null;
          console.error('[terminal] failed to restore managed home state', err);
          terminal.write(
            `[terminal] failed to restore managed home state: ${err instanceof Error ? err.message : String(err)}\r\n`,
          );
        }

        try {
          terminal.write('Starting networking...\r\n');
          hostBridgeRef.current = await bootPerf.measure('startHostBridge', () =>
            startWebContainerHostBridge({
              onLog(message) {
                console.error(message);
                try {
                  terminal.write(`${message}\r\n`);
                } catch {
                  // ignore
                }
              },
              wc,
            }),
          );
        } catch (err) {
          console.error('[terminal] failed to start host bridge', err);
          terminal.write(
            `[terminal] failed to start host bridge: ${err instanceof Error ? err.message : String(err)}\r\n`,
          );
        }

        terminal.write('Starting shell...\r\n');
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
          terminal.write(
            `[terminal] failed to start managed home state watcher: ${err instanceof Error ? err.message : String(err)}\r\n`,
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
      focusPane,
      getPreferredPaneId,
      importTerminalDiff,
      releaseAllPaneShellSessions,
      releaseHostBridgeSession,
      releasePersistedHomeSyncSession,
      spawnShellSession,
      startPersistedHomeSync,
      teardownWebContainer,
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
            terminal.write('\r\n');
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
          clearTerminal: true,
          forceReboot: true,
          importBeforeReboot: true,
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
    if (!fsReady || !baseFilesReady) return;
    const intervalId = window.setInterval(() => {
      void importTerminalDiff({ silent: true }).catch((err) => {
        console.error('[terminal] background import failed', err);
      });
    }, TERMINAL_AUTO_IMPORT_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [baseFilesReady, fsReady, importTerminalDiff]);

  useEffect(() => {
    if (!splitOpen) {
      disposePaneRuntime(otherPaneId(singlePaneId));
      setShellReadyByPane((current) => ({ ...current, [otherPaneId(singlePaneId)]: false }));
    }
  }, [disposePaneRuntime, singlePaneId, splitOpen]);

  useEffect(() => {
    if (!visible || startedRef.current || !baseFilesReady) return;
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
        await initializeWebContainerSession({ clearTerminal: true });
      } catch (err) {
        if (unmountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to start terminal: ${message}`);
        startedRef.current = false;
      }
    })();
  }, [apiKey, baseFilesReady, ensurePaneSurface, initializeWebContainerSession, visible]);

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
    if (!fsReady || !baseFilesReady) return;
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
  }, [baseFiles, liveFilePath, fsReady, baseFilesReady]);

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
      const skipImportOnUnmount = didRecentHotReload();
      const currentWc = wcRef.current;
      if (currentWc) {
        void capturePersistedHomeState(currentWc, { immediate: true }).finally(() => {
          void flushPersistedHomeState();
        });
      } else {
        void flushPersistedHomeState();
      }
      if (!skipImportOnUnmount) {
        void importTerminalDiff({ silent: true }).catch((err) => {
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
      releasePersistedHomeSyncSession();
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
    capturePersistedHomeState,
    flushPersistedHomeState,
    importTerminalDiff,
    releaseAllPaneShellSessions,
    releasePersistedHomeSyncSession,
    releaseHostBridgeSession,
  ]);

  useEffect(() => {
    const handlePageHide = () => {
      const currentWc = wcRef.current;
      if (currentWc) {
        void capturePersistedHomeState(currentWc, { immediate: true }).finally(() => {
          void flushPersistedHomeState();
        });
        return;
      }
      void flushPersistedHomeState();
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [capturePersistedHomeState, flushPersistedHomeState]);

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
                      void restartShellRef.current?.(undefined, { clearTerminal: true });
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
