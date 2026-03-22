import type http from 'node:http';
import { assertSessionStoreHealthy } from './session.ts';

type HealthCheck = () => void;

type HealthResponse = {
  ok: boolean;
  checks: {
    session_store: 'ok' | 'error';
  };
  error?: string;
};

export function getHealthResponse(checkSessionStore: HealthCheck = assertSessionStoreHealthy): {
  statusCode: number;
  body: HealthResponse;
} {
  try {
    checkSessionStore();
    return {
      statusCode: 200,
      body: {
        ok: true,
        checks: {
          session_store: 'ok',
        },
      },
    };
  } catch {
    return {
      statusCode: 503,
      body: {
        ok: false,
        checks: {
          session_store: 'error',
        },
        error: 'session_store_unavailable',
      },
    };
  }
}

export function writeHealthResponse(res: http.ServerResponse, checkSessionStore?: HealthCheck): void {
  const { statusCode, body } = getHealthResponse(checkSessionStore);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
