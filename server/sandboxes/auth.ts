import type http from 'node:http';
import { json } from '../http_helpers';
import { checkRateLimit, checkRateLimitAuthenticated } from '../rate_limit';
import { getSession } from '../session';
import type { SandboxesSession } from './types';

export function requireSandboxesSession(req: http.IncomingMessage, res: http.ServerResponse): SandboxesSession | null {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return session;
}

export function checkSandboxesRateLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  session: SandboxesSession | null,
): boolean {
  if (session) return checkRateLimitAuthenticated(req, res, session.githubUserId);
  return checkRateLimit(req, res);
}
