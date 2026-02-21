import { readFile, stat } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';

const DIST_DIR = path.resolve(new URL('../dist', import.meta.url).pathname);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

export async function serveStatic(res: http.ServerResponse, pathname: string): Promise<boolean> {
  const safePath = path.normalize(decodeURIComponent(pathname));
  const filePath = path.join(DIST_DIR, safePath);
  if (!filePath.startsWith(DIST_DIR)) return false;

  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;

    const ext = path.extname(filePath);
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      ...(ext !== '.html' ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}),
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
