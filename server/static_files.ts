import { serveStatic } from '@hono/node-server/serve-static';

export const serveStaticMiddleware = serveStatic({
  root: 'dist',
  onFound: (_path, c) => {
    if (!_path.endsWith('.html')) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
});

export const spaFallback = serveStatic({
  root: 'dist',
  path: 'index.html',
});
