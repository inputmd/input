import './env';
import http from 'node:http';
import { PORT, SESSION_SECRET } from './config';
import { applyCors } from './cors';
import { ClientError } from './errors';
import { startGistCacheCleanup } from './gist_cache';
import { startInstallationTokenCacheCleanup } from './github_client';
import { json } from './http_helpers';
import { startRateLimitCleanup } from './rate_limit';
import { handleApiRequest } from './routes';
import { applySecurityHeaders } from './security_headers';
import { serveStatic } from './static_files';

if (!process.env.SESSION_SECRET) {
  console.warn(
    'WARNING: SESSION_SECRET not set — using random ephemeral secret. Sessions will not survive server restarts.',
  );
}

startInstallationTokenCacheCleanup();
startGistCacheCleanup();
startRateLimitCleanup();

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

    const handledApi = await handleApiRequest(req, res, url, pathname);
    if (handledApi) return;

    if (req.method === 'GET') {
      if (await serveStatic(res, pathname)) return;
      if (await serveStatic(res, '/index.html')) return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ClientError) {
      json(res, err.statusCode, { error: err.message });
      return;
    }

    console.error('Unhandled server error:', err);
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const configured = Boolean(
    process.env.GITHUB_APP_ID &&
      (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH) &&
      process.env.GITHUB_APP_SLUG &&
      SESSION_SECRET,
  );
  console.log(`GitHub App auth server listening on http://0.0.0.0:${PORT} (configured=${configured})`);
});

function gracefulShutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
