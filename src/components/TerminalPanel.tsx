import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import type { Terminal as GhosttyTerminal } from 'ghostty-web';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { shouldBypassTerminalMetaShortcut } from '../keyboard_shortcuts.ts';
import { isLikelyBinaryBytes } from '../path_utils.ts';
import {
  buildTerminalImportDiff,
  shouldImportTerminalPath,
  type TerminalImportDiff,
  type TerminalImportOptions,
} from '../repo_workspace/terminal_sync.ts';

export interface TerminalLiveFile {
  path: string;
  content: string;
}

export interface TerminalPanelProps {
  className?: string;
  visible: boolean;
  workspaceKey: string;
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

// Cache the WebContainer boot promise so we only ever boot once per page.
// WebContainer.boot() throws if called more than once.
let webContainerBootPromise: Promise<WebContainer> | null = null;
let ghosttyInitPromise: Promise<void> | null = null;

function isLocalhostHostname(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function bootWebContainer(apiKey: string | undefined): Promise<WebContainer> {
  if (webContainerBootPromise) return webContainerBootPromise;
  webContainerBootPromise = (async () => {
    const { WebContainer, configureAPIKey } = await import('@webcontainer/api');
    // The WebContainer dashboard checks the Referer against its allowed-sites
    // list when configureAPIKey() is set, and it does not accept localhost.
    // On localhost, boot unauthenticated — that path works without a key.
    if (apiKey && !isLocalhostHostname()) {
      configureAPIKey(apiKey);
    }
    return WebContainer.boot({ coep: 'credentialless', workdirName: 'workspace' });
  })();
  try {
    return await webContainerBootPromise;
  } catch (err) {
    webContainerBootPromise = null;
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

async function writeHomeJshrc(wc: WebContainer): Promise<void> {
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const home = process.env.HOME || '';",
    "const target = path.join(home, '.jshrc');",
    `fs.writeFileSync(target, Buffer.from(${JSON.stringify(btoa(SAMPLE_JSHRC))}, 'base64').toString('utf8'));`,
  ].join(' ');
  const bootstrap = await wc.spawn('node', ['-e', script]);
  const [output, exitCode] = await Promise.all([readStreamFully(bootstrap.output), bootstrap.exit]);
  if (exitCode !== 0) {
    throw new Error(`node bootstrap exited with code ${exitCode}; output=${JSON.stringify(output)}`);
  }
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

async function snapshotTerminalTextFiles(
  wc: WebContainer,
  path = '.',
  relativePath = '',
): Promise<Record<string, string>> {
  const normalizedRelativePath = relativePath.replace(/^\/+|\/+$/g, '');
  if (normalizedRelativePath && !shouldImportTerminalPath(normalizedRelativePath)) {
    return {};
  }

  try {
    const entries = await wc.fs.readdir(path);
    const files: Record<string, string> = {};
    for (const entry of entries) {
      const childRelativePath = normalizedRelativePath ? `${normalizedRelativePath}/${entry}` : entry;
      if (!shouldImportTerminalPath(childRelativePath)) continue;
      const childPath = path === '.' ? entry : `${path}/${entry}`;
      Object.assign(files, await snapshotTerminalTextFiles(wc, childPath, childRelativePath));
    }
    return files;
  } catch {
    if (!normalizedRelativePath || !shouldImportTerminalPath(normalizedRelativePath)) return {};
    const bytes = await readTerminalFileBytes(wc, path);
    if (!bytes || bytes.length > TERMINAL_IMPORT_MAX_FILE_BYTES || isLikelyBinaryBytes(bytes)) return {};
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
const SAMPLE_JSHRC = ['export PATH="$HOME/.local/bin:$PATH"', 'npm config set prefix ~/.local', ''].join('\n');
const TERMINAL_SCROLLBAR_RESERVATION_PX = 15;
const TERMINAL_MIN_COLS = 2;
const TERMINAL_MIN_ROWS = 1;
const LAYOUT_SETTLED_EVENT = 'input:layout-settled';

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
  const unmountedRef = useRef(false);
  const wcRef = useRef<WebContainer | null>(null);
  // Snapshot of paths/contents currently in the WC FS, used to compute diffs
  // for incremental sync. Reset on each (re)mount of the panel.
  const mirroredFilesRef = useRef<Map<string, string>>(new Map());
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
  const onImportDiffRef = useRef(onImportDiff);
  onImportDiffRef.current = onImportDiff;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const importInFlightRef = useRef<Promise<TerminalImportDiff | null> | null>(null);

  const flushManagedSync = useCallback(async (): Promise<void> => {
    const wc = wcRef.current;
    if (!wc) return;
    if (liveSyncTimerRef.current !== null) {
      window.clearTimeout(liveSyncTimerRef.current);
      liveSyncTimerRef.current = null;
      const pendingPath = liveFilePathRef.current;
      const pendingContent = liveFileContentRef.current;
      if (pendingPath !== null && pendingContent !== null) {
        mirroredFilesRef.current.set(pendingPath, pendingContent);
        syncQueueRef.current = syncQueueRef.current.then(async () => {
          if (unmountedRef.current) return;
          try {
            await writeTextFile(wc, pendingPath, pendingContent);
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
        const managedFiles = Object.fromEntries(mirroredFilesRef.current.entries());
        const actualFiles = await snapshotTerminalTextFiles(wc);
        const diff = buildTerminalImportDiff({
          managedFiles,
          actualFiles,
          activeEditPath: liveFilePathRef.current,
        });
        if (Object.keys(diff.upserts).length === 0 && diff.deletes.length === 0) return null;
        mirroredFilesRef.current = new Map(Object.entries(actualFiles));
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
      let shell: {
        output: ReadableStream<string>;
        input: WritableStream<string>;
        kill: () => void;
        resize: (size: { cols: number; rows: number }) => void;
      } | null = null;
      let writer: WritableStreamDefaultWriter<string> | null = null;
      let onDataDispose: { dispose: () => void } | null = null;
      let onResizeDispose: { dispose: () => void } | null = null;
      let metaKeyBypassTarget: HTMLElement | null = null;
      let metaKeyBypassHandler: ((event: KeyboardEvent) => void) | null = null;
      const cleanup = () => {
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
        if (terminalRef.current === term) terminalRef.current = null;
        if (disposeRef.current === cleanup) disposeRef.current = null;
        wcRef.current = null;
        if (writer) {
          try {
            writer.close();
          } catch {
            // ignore
          }
          try {
            writer.releaseLock();
          } catch {
            // ignore
          }
          writer = null;
        }
        if (shell) {
          try {
            shell.kill();
          } catch {
            // ignore
          }
          shell = null;
        }
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

        terminal.write('Booting WebContainer...\r\n');
        const wc = await bootWebContainer(apiKey);
        if (unmountedRef.current) {
          cleanup();
          return;
        }

        // Clear any state from a previous mount (e.g. another workspace) and
        // populate the FS with this workspace's files. Read the files snapshot
        // through the ref so we always get the latest value at this instant,
        // not the value captured when the boot effect first ran.
        terminal.write('Mounting workspace files...\r\n');
        await clearWorkdir(wc);
        if (unmountedRef.current) {
          cleanup();
          return;
        }
        const initialFiles = buildManagedFiles(
          baseFilesRef.current,
          liveFilePathRef.current,
          liveFileContentRef.current,
        );
        try {
          await wc.mount(buildFileSystemTree(initialFiles));
        } catch (mountErr) {
          console.error('[terminal] initial mount failed', mountErr);
        }
        if (unmountedRef.current) {
          cleanup();
          return;
        }
        mirroredFilesRef.current = new Map(Object.entries(initialFiles));
        wcRef.current = wc;
        setFsReady(true);

        try {
          await writeHomeJshrc(wc);
        } catch (err) {
          console.error('[terminal] failed to write ~/.jshrc', err);
          terminal.write(
            `[terminal] failed to write ~/.jshrc: ${err instanceof Error ? err.message : String(err)}\r\n`,
          );
        }

        terminal.write('Spawning jsh...\r\n');
        const spawnedShell = await wc.spawn('jsh', []);
        shell = spawnedShell;
        if (unmountedRef.current) {
          cleanup();
          return;
        }
        terminal.write('Shell spawned.\r\n');

        try {
          spawnedShell.resize({ cols: terminal.cols, rows: terminal.rows });
        } catch {
          // some versions don't support resize before first write
        }

        // Defensive sink: never let an exception inside terminal.write() (e.g. a
        // ghostty-web parser error on an unexpected byte sequence) propagate
        // back to pipeTo, because that would cancel shell.output and break the
        // session — even though jsh is still running.
        void spawnedShell.output
          .pipeTo(
            new WritableStream({
              write(chunk) {
                try {
                  terminal.write(chunk);
                } catch (err) {
                  console.error('[terminal] write failed; chunk dropped', err);
                }
              },
            }),
          )
          .catch((err) => {
            console.error('[terminal] output pipe closed', err);
          });

        const shellWriter = spawnedShell.input.getWriter();
        writer = shellWriter;
        onDataDispose = terminal.onData((data) => {
          shellWriter.write(data).catch((err) => {
            console.error('[terminal] input write failed', err);
          });
        });
        onResizeDispose = terminal.onResize(({ cols, rows }) => {
          try {
            spawnedShell.resize({ cols, rows });
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
  }, [visible, apiKey]);

  // Sync structural changes immediately: base snapshot updates, active file
  // path switches, and leaving edit mode. This avoids whole-tree work on each
  // keystroke while keeping the managed FS authoritative.
  useEffect(() => {
    if (!fsReady) return;
    const wc = wcRef.current;
    if (!wc) return;
    const previous = mirroredFilesRef.current;
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
    mirroredFilesRef.current = next;
    syncQueueRef.current = syncQueueRef.current.then(async () => {
      if (unmountedRef.current) return;
      for (const path of removes) {
        try {
          await wc.fs.rm(path, { force: true, recursive: true });
        } catch (err) {
          console.error('[terminal] sync rm failed', path, err);
        }
      }
      for (const [path, contents] of writes) {
        try {
          await writeTextFile(wc, path, contents);
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
    if (mirroredFilesRef.current.get(liveFilePath) === liveFileContent) return;
    const wc = wcRef.current;
    if (!wc) return;
    if (liveSyncTimerRef.current !== null) {
      window.clearTimeout(liveSyncTimerRef.current);
    }
    liveSyncTimerRef.current = window.setTimeout(() => {
      liveSyncTimerRef.current = null;
      mirroredFilesRef.current.set(liveFilePath, liveFileContent);
      syncQueueRef.current = syncQueueRef.current.then(async () => {
        if (unmountedRef.current) return;
        try {
          await writeTextFile(wc, liveFilePath, liveFileContent);
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
      void importTerminalDiff({ silent: true }).catch((err) => {
        console.error('[terminal] import on unmount failed', err);
      });
      if (liveSyncTimerRef.current !== null) {
        window.clearTimeout(liveSyncTimerRef.current);
        liveSyncTimerRef.current = null;
      }
      disposeRef.current?.();
      disposeRef.current = null;
      terminalRef.current = null;
      startedRef.current = false;
      wcRef.current = null;
      mirroredFilesRef.current = new Map();
    };
  }, [importTerminalDiff]);

  return (
    <aside
      class={`terminal-panel${visible ? '' : ' terminal-panel--hidden'}${className ? ` ${className}` : ''}`}
      aria-label="Terminal"
      aria-hidden={visible ? undefined : 'true'}
    >
      {error ? (
        <div class="terminal-panel__error">{error}</div>
      ) : (
        <div class="terminal-panel__surface" ref={containerRef} />
      )}
    </aside>
  );
}
