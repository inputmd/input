import test from 'ava';
import { getHealthResponse } from '../health.ts';

test('getHealthResponse returns ok when the session store probe succeeds', (t) => {
  const response = getHealthResponse(() => {});

  t.is(response.statusCode, 200);
  t.deepEqual(response.body, {
    ok: true,
    checks: {
      session_store: 'ok',
    },
  });
});

test('getHealthResponse returns 503 when the session store probe fails', (t) => {
  const response = getHealthResponse(() => {
    throw new Error('db unavailable');
  });

  t.is(response.statusCode, 503);
  t.deepEqual(response.body, {
    ok: false,
    checks: {
      session_store: 'error',
    },
    error: 'session_store_unavailable',
  });
});
