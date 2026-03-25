import './env';
import crypto from 'node:crypto';
import http from 'node:http';
import { initDictionary } from '../shared/stream_boundary_dictionary.ts';
import { GITHUB_TOKEN, PORT } from './config';
import { applyCors } from './cors';
import { ClientError } from './errors';
import { startGistCacheCleanup } from './gist_cache';
import { startInstallationTokenCacheCleanup } from './github_client';
import { writeHealthResponse } from './health';
import { json } from './http_helpers';
import { startRateLimitCleanup } from './rate_limit';
import { handleApiRequest } from './routes';
import { applySecurityHeaders } from './security_headers';
import { startSessionCleanup } from './session';
import { serveIndexHtml, serveStatic } from './static_files';
import { extractSubdomain } from './subdomain';

try {
  await initDictionary();
} catch (err) {
  console.error('[dictionary] Failed to load bloom filter:', err);
  process.exit(1);
}

function normalizeReturnTo(raw: string | null): string {
  if (!raw) return '/workspaces';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/workspaces';
  return raw;
}

function tokenSummary(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '(none)';
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
  if (trimmed.length <= 8) return `[len=${trimmed.length} sha256=${hash}]`;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)} [len=${trimmed.length} sha256=${hash}]`;
}

startInstallationTokenCacheCleanup();
startGistCacheCleanup();
startRateLimitCleanup();
startSessionCleanup();

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  try {
    applySecurityHeaders(res);
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/healthz' || pathname === '/readyz')) {
      writeHealthResponse(res);
      return;
    }

    const handledApi = await handleApiRequest(req, res, url, pathname);
    if (handledApi) return;

    if (req.method === 'GET') {
      if (pathname === '/input.md') {
        const returnTo = normalizeReturnTo(url.searchParams.get('return_to'));
        res.statusCode = 302;
        res.setHeader('Location', `/api/auth/github/start?return_to=${encodeURIComponent(returnTo)}`);
        res.end();
        return;
      }

      if (await serveStatic(res, pathname)) return;

      const subdomainOwner = extractSubdomain(req.headers.host);
      if (await serveIndexHtml(res, subdomainOwner)) return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ClientError) {
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) res.end();
        return;
      }
      json(res, err.statusCode, { error: err.message });
      return;
    }

    console.error('Unhandled server error:', err);
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) res.end();
      return;
    }
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const configured = Boolean(
    process.env.GITHUB_APP_ID &&
      (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH) &&
      process.env.GITHUB_APP_SLUG &&
      process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET,
  );
  console.log(`GitHub App auth server listening on http://0.0.0.0:${PORT} (configured=${configured})`);
  console.log(`[github] Using GITHUB_TOKEN=${tokenSummary(GITHUB_TOKEN)}`);
});

function gracefulShutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
