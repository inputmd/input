import type { WebContainer } from '@webcontainer/api';
import {
  buildPersistedHomeSeed,
  buildPersistedHomeSyncScript,
  loadPersistedHomeEntries,
  logPersistedHomePaths,
  PERSISTED_HOME_SEED_FILENAME,
  PERSISTED_HOME_SYNC_SCRIPT_FILENAME,
  type PersistedHomeEntry,
} from '../../persisted_home_state.ts';
import { buildWebContainerHomeOverlayProvisionScript } from '../../webcontainer_home_overlay.ts';
import { isLocalhostHostname } from './runtime_shared.ts';

const ANSI_ESCAPE_SEQUENCE_RE = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const HOME_OVERLAY_ARCHIVE_FILENAME = '.input-home-overlay.tar';
const HOME_OVERLAY_PROVISION_FILENAME = '.input-home-overlay-provision.cjs';

type TerminalBootPerfValue = boolean | null | number | string;
type TerminalBootPerfDetails = Record<string, TerminalBootPerfValue>;

export interface TerminalBootPerfLogger {
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

export function formatTerminalBootError(prefix: string, err: unknown): string {
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

export function createTerminalBootPerfLogger(workspaceKey: string, workdirName: string): TerminalBootPerfLogger {
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

async function fetchWebContainerHomeOverlayArchive(archiveUrl: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(archiveUrl, {
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

export async function provisionHomeOverlay(
  wc: WebContainer,
  archiveUrl: string,
  bootPerf?: TerminalBootPerfLogger,
): Promise<{ archiveBytes: number }> {
  const [archive, homeDir] = await Promise.all([
    measureBootStage(bootPerf, 'overlay.fetchArchive', () => fetchWebContainerHomeOverlayArchive(archiveUrl)),
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
  return { archiveBytes: archive.byteLength };
}

async function preparePersistedHomeSupportFiles(wc: WebContainer, homeDir: string): Promise<string> {
  const scriptPath = joinHomePath(homeDir, PERSISTED_HOME_SYNC_SCRIPT_FILENAME);
  const seedPath = joinHomePath(homeDir, PERSISTED_HOME_SEED_FILENAME);
  await writeContainerFile(wc, scriptPath, buildPersistedHomeSyncScript(seedPath));
  return scriptPath;
}

export async function restorePersistedHomeForWorkspace(
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

export async function createPersistedHomeSupportFiles(
  wc: WebContainer,
): Promise<{ homeDir: string; scriptPath: string }> {
  const homeDir = await resolveWebContainerHomeDirectory(wc);
  const scriptPath = await preparePersistedHomeSupportFiles(wc, homeDir);
  return { homeDir, scriptPath };
}

export async function readPersistedHomeEntriesForWorkspace(
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
