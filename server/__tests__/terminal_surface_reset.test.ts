import test from 'ava';
import { resetTerminalSurface } from '../../src/components/terminal_surface_reset.ts';

test('resetTerminalSurface clears, homes, and shows the cursor after resetting', (t) => {
  const calls: Array<{ method: 'reset' } | { method: 'write'; data: string | Uint8Array }> = [];

  resetTerminalSurface({
    reset() {
      calls.push({ method: 'reset' });
    },
    write(data) {
      calls.push({ method: 'write', data });
    },
  });

  t.deepEqual(calls, [{ method: 'reset' }, { method: 'write', data: '\x1b[2J\x1b[H\x1b[?25h' }]);
});
