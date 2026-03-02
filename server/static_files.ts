import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createMiddleware } from 'hono/factory';

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

async function tryServeFile(filePath: string): Promise<Response | null> {
  if (!filePath.startsWith(DIST_DIR)) return null;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;

    const ext = path.extname(filePath);
    const content = await readFile(filePath);
    const headers: Record<string, string> = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    };
    if (ext !== '.html') {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }
    return new Response(content, { status: 200, headers });
  } catch {
    return null;
  }
}

export const serveStaticMiddleware = createMiddleware(async (c, next) => {
  if (c.req.method !== 'GET') {
    await next();
    return;
  }

  const pathname = decodeURIComponent(new URL(c.req.url).pathname);
  const safePath = path.normalize(pathname);
  const filePath = path.join(DIST_DIR, safePath);

  const res = await tryServeFile(filePath);
  if (res) return res;

  // SPA fallback: serve index.html for unmatched GET requests
  const indexPath = path.join(DIST_DIR, 'index.html');
  const indexRes = await tryServeFile(indexPath);
  if (indexRes) return indexRes;

  await next();
});
