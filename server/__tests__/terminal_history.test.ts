import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
  buildPersistedTerminalHistorySeed,
  buildTerminalHistorySyncScript,
  TERMINAL_HISTORY_SEED_FILENAME,
  TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME,
} from '../../src/terminal_history.ts';

async function runNodeScript(
  scriptPath: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

test('terminal history sync script restores and reads ~/.jsh_history', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'input-terminal-history-home-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'input-terminal-history-work-'));
  t.teardown(async () => {
    await rm(homeDir, { force: true, recursive: true });
    await rm(workDir, { force: true, recursive: true });
  });

  const expectedContent = 'npm test\ngit status\n';
  const scriptPath = path.join(homeDir, TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME);
  const seedPath = path.join(homeDir, TERMINAL_HISTORY_SEED_FILENAME);

  await writeFile(scriptPath, buildTerminalHistorySyncScript(seedPath), 'utf8');
  await writeFile(seedPath, buildPersistedTerminalHistorySeed(expectedContent), 'utf8');

  const restore = await runNodeScript(scriptPath, ['restore'], {
    cwd: workDir,
    env: { HOME: homeDir },
  });
  t.is(restore.code, 0, restore.stderr);
  t.is(await readFile(path.join(homeDir, '.jsh_history'), 'utf8'), expectedContent);

  const read = await runNodeScript(scriptPath, ['read'], {
    cwd: workDir,
    env: { HOME: homeDir },
  });
  t.is(read.code, 0, read.stderr);
  t.deepEqual(JSON.parse(read.stdout.trim()), { type: 'history', content: expectedContent });
});
