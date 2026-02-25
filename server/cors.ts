import { cors } from 'hono/cors';
import { ALLOWED_ORIGINS } from './config';

export const corsMiddleware = cors({
  origin: (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : ''),
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600,
});
