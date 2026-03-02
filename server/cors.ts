import { cors } from 'hono/cors';
import { ALLOWED_ORIGINS } from './config';

export const corsMiddleware = cors({
  origin: (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : ''),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
});
