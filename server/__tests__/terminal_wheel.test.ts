import test from 'ava';
import { consumeTerminalPixelWheelDelta } from '../../src/components/terminal_wheel.ts';

test('consumeTerminalPixelWheelDelta accumulates pixel deltas into whole lines', (t) => {
  const first = consumeTerminalPixelWheelDelta(0, 5, 20);
  t.deepEqual(first, { lines: 0, remainder: 0.5 });

  const second = consumeTerminalPixelWheelDelta(first.remainder, 5, 20);
  t.deepEqual(second, { lines: 1, remainder: 0 });
});

test('consumeTerminalPixelWheelDelta preserves negative scroll direction', (t) => {
  const first = consumeTerminalPixelWheelDelta(0, -7.5, 20);
  t.deepEqual(first, { lines: 0, remainder: -0.75 });

  const second = consumeTerminalPixelWheelDelta(first.remainder, -2.5, 20);
  t.deepEqual(second, { lines: -1, remainder: 0 });
});

test('consumeTerminalPixelWheelDelta falls back to a default height for invalid metrics', (t) => {
  const result = consumeTerminalPixelWheelDelta(0, 10, 0);
  t.deepEqual(result, { lines: 1, remainder: 0 });
});
