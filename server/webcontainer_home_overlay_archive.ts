import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import tar from 'tar-stream';

interface OverlayArchiveBaseEntry {
  archivePath: string;
  mode: number;
}

interface OverlayArchiveFile extends OverlayArchiveBaseEntry {
  absolutePath: string;
  kind: 'file';
}

interface OverlayArchiveSymlink extends OverlayArchiveBaseEntry {
  kind: 'symlink';
  linkPath: string;
}

type OverlayArchiveEntry = OverlayArchiveFile | OverlayArchiveSymlink;

export interface WebContainerBridgeFiles {
  hostBridge: string;
  hostRewrite: string;
}

const DEFAULT_OVERLAY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor', 'overlay');

// The archive is built once at server startup and cached in memory for the
// lifetime of the process. Changes to files under vendor/overlay/ during dev
// will not be picked up until the server is restarted.
let archivePromise: Promise<Uint8Array<ArrayBuffer>> | null = null;
let bridgeFilesPromise: Promise<WebContainerBridgeFiles> | null = null;

async function collectOverlayArchiveFiles(rootDir: string, currentDir = rootDir): Promise<OverlayArchiveEntry[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: OverlayArchiveEntry[] = [];

  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectOverlayArchiveFiles(rootDir, absolutePath)));
      continue;
    }
    if (entry.isSymbolicLink()) {
      const linkStat = await lstat(absolutePath);
      files.push({
        archivePath: path.relative(rootDir, absolutePath).split(path.sep).join('/'),
        kind: 'symlink',
        linkPath: await readlink(absolutePath),
        mode: linkStat.mode & 0o777,
      });
      continue;
    }
    if (!entry.isFile()) continue;

    const fileStat = await lstat(absolutePath);
    files.push({
      absolutePath,
      archivePath: path.relative(rootDir, absolutePath).split(path.sep).join('/'),
      kind: 'file',
      mode: fileStat.mode & 0o777,
    });
  }

  return files;
}

export async function buildWebContainerHomeOverlayArchive(
  rootDir = DEFAULT_OVERLAY_ROOT,
): Promise<Uint8Array<ArrayBuffer>> {
  const files = await collectOverlayArchiveFiles(rootDir);
  files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  const pack = tar.pack();
  const chunks: Uint8Array[] = [];
  const archive = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    pack.on('data', (chunk: Buffer) => {
      chunks.push(new Uint8Array(chunk));
    });
    pack.on('end', () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    pack.on('error', reject);
  });

  for (const file of files) {
    if (file.kind === 'symlink') {
      await new Promise<void>((resolve, reject) => {
        pack.entry(
          {
            name: file.archivePath,
            mode: file.mode,
            type: 'symlink',
            linkname: file.linkPath,
          },
          (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          },
        );
      });
      continue;
    }

    const contents = await readFile(file.absolutePath);
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: file.archivePath,
          mode: file.mode,
          type: 'file',
        },
        contents,
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        },
      );
    });
  }

  pack.finalize();
  return archive;
}

export async function loadWebContainerBridgeFiles(rootDir = DEFAULT_OVERLAY_ROOT): Promise<WebContainerBridgeFiles> {
  const [hostBridge, hostRewrite] = await Promise.all([
    readFile(path.join(rootDir, 'host_bridge.mjs'), 'utf8'),
    readFile(path.join(rootDir, 'host_rewrite.mjs'), 'utf8'),
  ]);
  return { hostBridge, hostRewrite };
}

export async function initWebContainerHomeOverlayArchive(): Promise<void> {
  archivePromise = buildWebContainerHomeOverlayArchive();
  await archivePromise;
}

export async function initWebContainerBridgeFiles(): Promise<void> {
  bridgeFilesPromise = loadWebContainerBridgeFiles();
  await bridgeFilesPromise;
}

async function getWebContainerHomeOverlayArchive(): Promise<Uint8Array<ArrayBuffer>> {
  if (archivePromise === null) {
    archivePromise = buildWebContainerHomeOverlayArchive();
  }
  return archivePromise;
}

async function getWebContainerBridgeFiles(): Promise<WebContainerBridgeFiles> {
  if (bridgeFilesPromise === null) {
    bridgeFilesPromise = loadWebContainerBridgeFiles();
  }
  return bridgeFilesPromise;
}

function isLocalhostStyleHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(':')[0]?.toLowerCase() ?? '';
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1';
}

export async function writeWebContainerHomeOverlayArchiveResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const archive = await getWebContainerHomeOverlayArchive();
  res.writeHead(200, {
    'Content-Type': 'application/x-tar',
    'Content-Length': String(archive.byteLength),
    'Cache-Control': isLocalhostStyleHost(req.headers.host) ? 'private, no-store' : 'private, max-age=900',
  });
  res.end(Buffer.from(archive));
}

export async function writeWebContainerBridgeFilesResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const bridgeFiles = await getWebContainerBridgeFiles();
  const body = Buffer.from(`${JSON.stringify(bridgeFiles)}\n`, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': isLocalhostStyleHost(req.headers.host) ? 'private, no-store' : 'private, max-age=900',
  });
  res.end(body);
}
