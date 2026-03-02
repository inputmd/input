import { createMiddleware } from 'hono/factory';
import { CONTENT_SECURITY_POLICY } from './config';

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
});
