import test from 'ava';
import { composeTimeoutSignal } from '../fetch_timeout.ts';

test('composeTimeoutSignal aborts when the caller signal aborts', async (t) => {
  const controller = new AbortController();
  const signal = composeTimeoutSignal(controller.signal, 1_000);

  controller.abort(new Error('caller aborted'));
  await Promise.resolve();

  t.true(signal.aborted);
  t.is(signal.reason, controller.signal.reason);
});

test('composeTimeoutSignal falls back to the timeout signal', async (t) => {
  const signal = composeTimeoutSignal(undefined, 5);

  await new Promise((resolve) => setTimeout(resolve, 20));

  t.true(signal.aborted);
  t.true(signal.reason instanceof DOMException);
  t.is((signal.reason as DOMException).name, 'TimeoutError');
});
