import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import { isLikelyBinaryBytes } from '../../path_utils.ts';
import { shouldImportTerminalPath } from '../../repo_workspace/terminal_sync.ts';

export const DEFAULT_LIVE_FILE_DEBOUNCE_MS = 300;
export const DEFAULT_AUTO_IMPORT_INTERVAL_MS = 3000;

const TERMINAL_IMPORT_MAX_FILE_BYTES = 512 * 1024;
const TERMINAL_IMPORT_MAX_ENTRIES = 5000;
const TERMINAL_IMPORT_MAX_DEPTH = 50;

export function buildFileSystemTree(files: Record<string, string>): FileSystemTree {
  const root: FileSystemTree = {};
  for (const [rawPath, contents] of Object.entries(files)) {
    const segments = rawPath.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    let cursor = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const existing = cursor[segment];
      if (existing && 'directory' in existing) {
        cursor = existing.directory;
      } else {
        const directory: FileSystemTree = {};
        cursor[segment] = { directory };
        cursor = directory;
      }
    }
    const leaf = segments[segments.length - 1]!;
    cursor[leaf] = { file: { contents } };
  }
  return root;
}

export function buildManagedFiles(
  baseFiles: Record<string, string>,
  liveFilePath: string | null,
  liveFileContent: string | null,
): Record<string, string> {
  if (liveFilePath === null) return { ...baseFiles };
  return { ...baseFiles, [liveFilePath]: liveFileContent ?? '' };
}

export function terminalDownloadName(path: string, workdirName: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return `${workdirName || 'workspace'}.zip`;
  const baseName = normalized.split('/').filter(Boolean).at(-1) ?? workdirName ?? 'download';
  return `${baseName}.zip`;
}

export function triggerBrowserDownload(blob: Blob, fileName: string): void {
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

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index);
}

export async function clearWorkdir(wc: WebContainer): Promise<void> {
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

export async function writeTextFile(wc: WebContainer, path: string, contents: string): Promise<void> {
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

export async function snapshotTerminalTextFiles(
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
