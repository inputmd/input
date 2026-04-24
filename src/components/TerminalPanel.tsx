import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import type { Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web';
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';
import { Power, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils.ts';
import {
  getTerminalInputOverride,
  matchesControlShortcut,
  shouldBypassTerminalMetaShortcut,
} from '../keyboard_shortcuts.ts';
import { isLikelyBinaryBytes } from '../path_utils.ts';
import {
  buildPersistedHomeSeed,
  buildPersistedHomeSyncScript,
  loadPersistedHomeEntries,
  logPersistedHomePaths,
  PERSISTED_HOME_SEED_FILENAME,
  PERSISTED_HOME_SYNC_SCRIPT_FILENAME,
  type PersistedHomeEntry,
} from '../persisted_home_state.ts';
import {
  type PersistedHomeTransitionReason,
  type PersistedHomeTrustPrompt,
  resolvePersistedHomeSessionTransition,
} from '../repo_workspace/persisted_home_trust.ts';
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
import { TerminalPersistenceDialog } from './TerminalPersistenceDialog.tsx';
import { resetTerminalSurface } from './terminal_surface_reset.ts';
import { consumeTerminalPixelWheelDelta } from './terminal_wheel.ts';
import { useTerminalPersistedHome } from './useTerminalPersistedHome.ts';

// Ctrl-C/Ctrl-\ don't reliably interrupt processes inside WebContainer
// (upstream bug). As a workaround, a second press warns that a third press
// will reset into a fresh shell.
const CTRL_C_RESET_WINDOW_MS = 1000;
const CTRL_Z_NOTICE_WINDOW_MS = 1000;
const TERMINAL_RESET_BANNER_DURATION_MS = 3000;

type TerminalThemeMode = 'dark' | 'light';

interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  selectionForeground: string;
}

const TERMINAL_THEME_BY_MODE: Record<TerminalThemeMode, TerminalTheme> = {
  dark: {
    background: '#0b0b0b',
    foreground: '#e6edf3',
    cursor: '#e6edf3',
    selectionBackground: '#1a4a32',
    selectionForeground: '#eef5f0',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    selectionBackground: '#2a7d4f',
    selectionForeground: '#ffffff',
  },
};

function getDocumentThemeMode(): TerminalThemeMode {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function getTerminalTheme(mode: TerminalThemeMode): TerminalTheme {
  return { ...TERMINAL_THEME_BY_MODE[mode] };
}

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
  baseFilesLoadError?: string | null;
  workspaceChangesPersisted?: boolean;
  workspaceChangesNotice?: string | null;
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
  persistedHomeTrustPrompt?: PersistedHomeTrustPrompt | null;
  showPersistedHomeTrustConfiguration?: boolean;
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
  ghosttyLoadPromise: Promise<Ghostty> | null;
  ghosttyModulePromise: Promise<typeof import('ghostty-web')> | null;
  lastHotReloadAt: number;
  webContainerApiModulePromise: Promise<typeof import('@webcontainer/api')> | null;
  webContainerConfiguredApiKey: string | null;
  webContainerBootPromise: Promise<WebContainer> | null;
  webContainerBootWorkdirName: string | null;
}

type TerminalPanelGlobalThis = typeof globalThis & {
  __inputTerminalPanelGlobalState__?: TerminalPanelGlobalState;
};

function getTerminalPanelGlobalState(): TerminalPanelGlobalState {
  const root = globalThis as TerminalPanelGlobalThis;
  root.__inputTerminalPanelGlobalState__ ??= {
    ghosttyLoadPromise: null,
    ghosttyModulePromise: null,
    lastHotReloadAt: 0,
    webContainerApiModulePromise: null,
    webContainerConfiguredApiKey: null,
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

async function loadWebContainerApi(): Promise<typeof import('@webcontainer/api')> {
  const globalState = getTerminalPanelGlobalState();
  if (!globalState.webContainerApiModulePromise) {
    globalState.webContainerApiModulePromise = import('@webcontainer/api');
  }
  return await globalState.webContainerApiModulePromise;
}

async function ensureWebContainerApiConfigured(
  apiKey: string | undefined,
): Promise<typeof import('@webcontainer/api')> {
  const webContainerApi = await loadWebContainerApi();
  // The WebContainer dashboard checks the Referer against its allowed-sites
  // list when configureAPIKey() is set, and it does not accept localhost.
  // On localhost, boot unauthenticated — that path works without a key.
  if (isLocalhostHostname()) {
    return webContainerApi;
  }
  if (!apiKey) {
    throw new Error('VITE_WEBCONTAINERS_API_KEY is not set.');
  }
  const globalState = getTerminalPanelGlobalState();
  if (globalState.webContainerConfiguredApiKey === apiKey) {
    return webContainerApi;
  }
  webContainerApi.configureAPIKey(apiKey);
  globalState.webContainerConfiguredApiKey = apiKey;
  return webContainerApi;
}

async function bootWebContainer(apiKey: string | undefined, workdirName: string): Promise<WebContainer> {
  const { WebContainer } = await ensureWebContainerApiConfigured(apiKey);
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

const ANSI_ESCAPE_SEQUENCE_RE = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const HOME_OVERLAY_ARCHIVE_FILENAME = '.input-home-overlay.tar';
const HOME_OVERLAY_PROVISION_FILENAME = '.input-home-overlay-provision.cjs';

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

function normalizeTerminalProcessOutput(output: string): string {
  return output.replace(ANSI_ESCAPE_SEQUENCE_RE, '').replace(/\r\n?/g, '\n').trim();
}

function buildNodeHelperExitError(label: string, exitCode: number, output: string): Error {
  const normalizedOutput = normalizeTerminalProcessOutput(output);
  return new Error(
    normalizedOutput
      ? `${label} exited with code ${exitCode}\n${normalizedOutput}`
      : `${label} exited with code ${exitCode}`,
  );
}

function formatTerminalBootError(prefix: string, err: unknown): string {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const normalizedMessage = normalizeTerminalProcessOutput(rawMessage) || 'Unknown error';
  const [firstLine, ...restLines] = normalizedMessage.split('\n');
  return `${[`${prefix}: ${firstLine}`, ...restLines.map((line) => `  ${line}`)].join('\r\n')}\r\n`;
}

function joinHomePath(homeDir: string, fileName: string): string {
  return `${homeDir.replace(/\/+$/, '')}/${fileName}`;
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
    throw buildNodeHelperExitError('node write helper', exitCode, output);
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
    throw buildNodeHelperExitError('node remove helper', exitCode, output);
  }
}

async function fetchWebContainerHomeOverlayArchive(): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL, {
    ...(isLocalhostHostname() ? { cache: 'no-store' as RequestCache } : {}),
    credentials: 'same-origin',
  });
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
): Promise<{ archiveBytes: number; homeDir: string }> {
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
          throw buildNodeHelperExitError('node overlay provision', exitCode, output);
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
  return { archiveBytes: archive.byteLength, homeDir };
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
  options?: { includePersistedHome?: boolean; bootPerf?: TerminalBootPerfLogger },
): Promise<{ entryCount: number }> {
  const entries =
    options?.includePersistedHome === false
      ? []
      : await measureBootStage(options?.bootPerf, 'persistedHome.loadEntries', () =>
          loadPersistedHomeEntries(workspaceKey),
        );
  await measureBootStage(
    options?.bootPerf,
    'persistedHome.writeSeedFile',
    () => writeContainerFile(wc, joinHomePath(homeDir, PERSISTED_HOME_SEED_FILENAME), buildPersistedHomeSeed(entries)),
    {
      entry_count: entries.length,
    },
  );
  await measureBootStage(
    options?.bootPerf,
    'persistedHome.restoreEntries',
    async () => {
      const restore = await wc.spawn('node', [scriptPath, 'restore']);
      const [output, exitCode] = await Promise.all([readStreamFully(restore.output), restore.exit]);
      if (exitCode !== 0) {
        throw buildNodeHelperExitError('node persisted home restore', exitCode, output);
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
  const globalState = getTerminalPanelGlobalState();
  const module = await (globalState.ghosttyModulePromise ??= import('ghostty-web'));
  if (!globalState.ghosttyLoadPromise) {
    globalState.ghosttyLoadPromise = module.Ghostty.load(ghosttyWasmUrl).catch((err) => {
      globalState.ghosttyLoadPromise = null;
      throw err;
    });
  }
  return {
    Terminal: module.Terminal,
    ghostty: await globalState.ghosttyLoadPromise,
  };
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
const TERMINAL_DRAG_RESIZE_INTERVAL_MS = 90;
const TERMINAL_FOLLOW_OUTPUT_LEAVE_THRESHOLD_LINES = 4;
const TERMINAL_FOLLOW_OUTPUT_RESUME_THRESHOLD_LINES = 1;
const LAYOUT_RESIZE_START_EVENT = 'input:layout-resize-start';
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
  // ghostty-web stores selections as buffer row/column coordinates. After a
  // resize reflows wrapped lines, those coordinates can point at blank cells,
  // which makes later copies return only newlines.
  if (terminal.hasSelection()) {
    terminal.clearSelection();
  }
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
  baseFilesLoadError = null,
  workspaceChangesPersisted = true,
  workspaceChangesNotice = null,
  baseFiles,
  baseFilesReady,
  liveFile,
  persistedHomeTrustPrompt = null,
  showPersistedHomeTrustConfiguration = false,
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
  const restartWebContainerRef = useRef<
    ((options?: { reason?: PersistedHomeTransitionReason }) => Promise<void>) | null
  >(null);
  const [singlePaneId, setSinglePaneId] = useState<PaneId>('primary');
  const [splitOpen, setSplitOpen] = useState(false);
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

      const writeShellInput = (data: string) => {
        const shellWriter = runtime.shellWriter;
        if (!shellWriter) return;
        shellWriter.write(data).catch((err) => {
          console.error('[terminal] input write failed', err);
        });
      };

      const handleTerminalInput = (data: string) => {
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
        writeShellInput(data);
      };

      const onContainerKeyDown = (event: KeyboardEvent) => {
        const overrideData = getTerminalInputOverride(event);
        if (overrideData !== null) {
          event.preventDefault();
          event.stopPropagation();
          handleTerminalInput(overrideData);
          return;
        }
        if (matchesControlShortcut(event, 't')) {
          event.preventDefault();
          event.stopPropagation();
          void onToggleVisibilityShortcut?.();
          return;
        }
        if (!shouldBypassTerminalMetaShortcut(event)) return;
        event.stopPropagation();
      };
      container.addEventListener('keydown', onContainerKeyDown, true);

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
        handleTerminalInput(data);
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
        container.removeEventListener('keydown', onContainerKeyDown, true);
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
          await importTerminalDiff({ silent: true });
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
        const wc = await bootPerf.measure('bootWebContainer', () => bootWebContainer(apiKey, workdirName));
        if (unmountedRef.current || webContainerSessionIdRef.current !== sessionId) {
          bootStatus = 'cancelled';
          return;
        }

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

        let overlayHomeDir: string | null = null;
        try {
          writeTerminal(logPaneId, 'Mounting binaries...\r\n', { forceFollow: true });
          const overlayResult = await provisionHomeOverlay(wc, bootPerf);
          overlayHomeDir = overlayResult.homeDir;
          bootPerf.record('overlay.summary', 0, { archive_bytes: overlayResult.archiveBytes });
        } catch (err) {
          console.error('[terminal] failed to provision home overlay', err);
          writeTerminal(logPaneId, formatTerminalBootError('[terminal] failed to provision home overlay', err), {
            forceFollow: true,
          });
        }

        try {
          writeTerminal(logPaneId, 'Restoring config files...\r\n', { forceFollow: true });
          const homeDir =
            overlayHomeDir ??
            (await bootPerf.measure('persistedHome.resolveHomeDirectory', () => resolveWebContainerHomeDirectory(wc)));
          const persistedHomeScriptPath = await bootPerf.measure('persistedHome.writeSupportScript', () =>
            preparePersistedHomeSupportFiles(wc, homeDir),
          );
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

        if (enableNetworkingBridge) {
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
      focusPane,
      getPersistedHomeActiveSessionMode,
      getPreferredPaneId,
      importTerminalDiff,
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
      setPersistedHomeActiveSessionMode(null);
      disposePersistedHomePrompt();
      releasePersistedHomeSyncSession();
      void releaseHostBridgeSession();
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
    disposePersistedHomePrompt,
    flushPersistedHomeState,
    getPersistedHomeActiveSessionMode,
    importTerminalDiff,
    releaseAllPaneShellSessions,
    releasePersistedHomeSyncSession,
    releaseHostBridgeSession,
    setPersistedHomeActiveSessionMode,
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
            {workspaceNoticeKey && dismissedWorkspaceNoticeKey !== workspaceNoticeKey ? (
              <button
                type="button"
                class="terminal-panel__notice"
                onClick={() => {
                  setDismissedWorkspaceNoticeKey(workspaceNoticeKey);
                }}
                aria-label="Hide terminal changes notice"
              >
                {workspaceChangesNotice}
              </button>
            ) : null}
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
            {persistedHomePromptState ? (
              <div
                class="terminal-panel__trust-prompt"
                role="dialog"
                aria-modal="false"
                aria-labelledby="terminal-trust-title"
                onClick={(event) => {
                  if (event.target !== event.currentTarget) return;
                  closePersistedHomePrompt();
                  focusPane();
                }}
              >
                <div class="terminal-panel__trust-prompt-card">
                  <h2 id="terminal-trust-title" class="terminal-panel__trust-prompt-title">
                    {persistedHomePromptState.title}
                  </h2>
                  <p class="terminal-panel__trust-prompt-message">{persistedHomePromptState.message}</p>
                  {persistedHomePromptState.note ? (
                    <p class="terminal-panel__trust-prompt-note">{persistedHomePromptState.note}</p>
                  ) : null}
                  <div class="terminal-panel__trust-prompt-actions">
                    <button
                      type="button"
                      onClick={() => {
                        settlePersistedHomePrompt(false);
                      }}
                    >
                      Keep credential sync off
                    </button>
                    <button
                      type="button"
                      class="button-warning"
                      onClick={() => {
                        settlePersistedHomePrompt(true);
                      }}
                    >
                      Trust this {persistedHomePromptState.target}, enable credential sync
                    </button>
                  </div>
                  <p class="terminal-panel__trust-prompt-note">This will restart running terminals.</p>
                </div>
              </div>
            ) : null}
          </div>
          <div class="terminal-panel__overlay-controls">
            <DropdownMenu.Root onOpenChange={blurOnClose}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  class="terminal-panel__credential-sync-trigger"
                  aria-label={`${credentialSyncStatusLabel}. ${networkingStatusLabel}. Terminal session settings`}
                  title={`${credentialSyncStatusLabel}. ${networkingStatusLabel}. Terminal session settings`}
                >
                  <Zap size={14} aria-hidden="true" />
                  <span>{credentialSyncStatusLabel}</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="terminal-panel__menu" side="top" align="end" sideOffset={8}>
                  <DropdownMenu.Label class="terminal-panel__menu-note">{credentialSyncMenuNote}</DropdownMenu.Label>
                  <DropdownMenu.Separator class="terminal-panel__menu-separator" />
                  <DropdownMenu.Item
                    class="terminal-panel__menu-item"
                    onSelect={() => {
                      void openPersistenceDialog();
                    }}
                  >
                    View synced data
                  </DropdownMenu.Item>
                  {showPersistedHomeTrustConfiguration ? (
                    <DropdownMenu.Item
                      class="terminal-panel__menu-item"
                      onSelect={() => {
                        openPersistedHomeReconfigurePrompt();
                      }}
                    >
                      Configure credential sync
                    </DropdownMenu.Item>
                  ) : null}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
                    Download files...
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
                        Close top terminal
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="terminal-panel__menu-item"
                        disabled={!canManageSplit}
                        onSelect={() => {
                          closeSplitPane('bottom');
                        }}
                      >
                        Close bottom terminal
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
          <TerminalPersistenceDialog
            open={persistenceDialogOpen}
            loading={persistenceDialogLoading}
            error={persistenceDialogError}
            snapshot={persistenceDialogSnapshot}
            onClose={closePersistenceDialog}
          />
        </>
      )}
    </aside>
  );
}
