import http from 'node:http';
import { CONTENT_SECURITY_POLICY } from './config';

export function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}
