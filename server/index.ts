import { type Env,  TunnelServer } from '@teekit/kettle/worker';
import { Hono } from 'hono';
import { corsMiddleware } from './cors';
import { ClientError } from './errors';
import { rateLimitMiddleware } from './rate_limit';
import { registerApiRoutes, registerHealthRoute } from './routes';
import { securityHeadersMiddleware } from './security_headers';
import { initSessionDb } from './session';

const app = new Hono<{ Bindings: Env }>();

app.use('*', securityHeadersMiddleware);
app.use('*', corsMiddleware);

app.onError((err, c) => {
  if (err instanceof ClientError) {
    return c.json({ error: err.message }, err.statusCode as 400);
  }
  console.error('Unhandled server error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

registerHealthRoute(app);
app.use('/api/*', rateLimitMiddleware);

TunnelServer.initialize(app);

registerApiRoutes(app);

export async function onInit(env: Env) {
  initSessionDb(env.DO_STORAGE!.sql!);
}

export default app;
