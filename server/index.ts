import './env';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_BODY_BYTES, PORT } from './config';
import { corsMiddleware } from './cors';
import { HTTPException } from 'hono/http-exception';
import { startGistCacheCleanup } from './gist_cache';
import { startInstallationTokenCacheCleanup } from './github_client';
import { startRateLimitCleanup, rateLimitMiddleware } from './rate_limit';
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

const server = serve(
  { fetch: app.fetch, port: PORT, hostname: '0.0.0.0' },
  () => {
    const configured = Boolean(
      process.env.GITHUB_APP_ID &&
        (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH) &&
        process.env.GITHUB_APP_SLUG &&
        process.env.GITHUB_CLIENT_ID &&
        process.env.GITHUB_CLIENT_SECRET,
    );
    console.log(`GitHub App auth server listening on http://0.0.0.0:${PORT} (configured=${configured})`);
  },
);

function gracefulShutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
