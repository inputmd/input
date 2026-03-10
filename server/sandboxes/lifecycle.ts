import { destroyRunnerMachine, stopRunnerMachine } from './fly_runtime';
import { IDLE_TIMEOUT_MS } from './limits';
import { listIdleSandboxes, updateSandboxState } from './store';

let reaperInterval: ReturnType<typeof setInterval> | null = null;

async function reapIdleSandboxes(): Promise<void> {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  const idle = listIdleSandboxes(cutoff);

  for (const sandbox of idle) {
    console.log(`[lifecycle] Reaping idle sandbox ${sandbox.id} for ${sandbox.repoFullName}`);
    updateSandboxState(sandbox.id, 'stopping');
    try {
      if (sandbox.flyMachineId) {
        await stopRunnerMachine(sandbox.flyMachineId);
      }
      updateSandboxState(sandbox.id, 'stopped');
    } catch (err) {
      console.error(`[lifecycle] Failed to stop sandbox ${sandbox.id}:`, err);
      updateSandboxState(sandbox.id, 'failed');
      if (sandbox.flyMachineId) {
        await destroyRunnerMachine(sandbox.flyMachineId).catch(() => {});
      }
    }
  }
}

export function startIdleReaper(): void {
  if (reaperInterval) return;
  reaperInterval = setInterval(() => {
    reapIdleSandboxes().catch((err) => {
      console.error('[lifecycle] Reaper error:', err);
    });
  }, 60_000);
  reaperInterval.unref();
}

export function stopIdleReaper(): void {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}
