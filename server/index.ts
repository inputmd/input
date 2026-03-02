import './env';
import type http from 'node:http';
import { getRequestListener, serve } from '@hono/node-server';
import type { QuoteData } from '@teekit/tunnel';
import { TunnelServer } from '@teekit/tunnel';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { MAX_BODY_BYTES, PORT } from './config';
import { corsMiddleware } from './cors';
import { startGistCacheCleanup } from './gist_cache';
import { startInstallationTokenCacheCleanup } from './github_client';
import { rateLimitMiddleware, startRateLimitCleanup } from './rate_limit';
import { api } from './routes';
import { securityHeaders } from './security_headers';
import { startSessionCleanup } from './session';
import { serveStaticMiddleware, spaFallback } from './static_files';

startInstallationTokenCacheCleanup();
startGistCacheCleanup();
startRateLimitCleanup();
startSessionCleanup();

const app = new Hono();

// Global middleware
app.use('*', securityHeaders);
app.use('*', corsMiddleware);

// Rate limiting and body size limit on API routes
app.use('/api/*', rateLimitMiddleware);
app.use('/api/*', bodyLimit({ maxSize: MAX_BODY_BYTES }));

// API routes
app.route('/api', api);

// Static files + SPA fallback
app.use('*', serveStaticMiddleware);
app.use('*', spaFallback);

// Error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('Unhandled server error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Convert Hono app to a Node.js-compatible request listener for TunnelServer
const nodeHandler = getRequestListener(app.fetch);

async function startServer(): Promise<http.Server> {
  const getQuote = process.env.TEEKIT_GET_QUOTE_URL;

  if (getQuote) {
    // Running inside a TEE — use TunnelServer for encrypted channels
    const tunnelServer = await TunnelServer.initialize(
      nodeHandler as any,
      async (x25519PublicKey: Uint8Array): Promise<QuoteData> => {
        const res = await fetch(getQuote, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            report_data: Buffer.from(x25519PublicKey).toString('base64'),
          }),
        });
        if (!res.ok) {
          throw new Error(`Failed to get quote: ${res.status} ${res.statusText}`);
        }
        return (await res.json()) as QuoteData;
      },
    );
    return new Promise((resolve) => {
      tunnelServer.server.listen(PORT, '0.0.0.0', () => {
        resolve(tunnelServer.server);
      });
    });
  }

  // Standard mode — use Hono's built-in serve
  return new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
      resolve(s);
    });
  });
}

startServer().then((server) => {
  const configured = Boolean(
    process.env.GITHUB_APP_ID &&
      (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH) &&
      process.env.GITHUB_APP_SLUG &&
      process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET,
  );
  const mode = process.env.TEEKIT_GET_QUOTE_URL ? 'teekit' : 'standard';
  console.log(`GitHub App auth server listening on http://0.0.0.0:${PORT} (configured=${configured}, mode=${mode})`);

  function gracefulShutdown(signal: string): void {
    console.log(`\n${signal} received, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
});
