import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
  buildPersistedHomeSeed,
  buildPersistedHomeSyncScript,
  normalizePersistedHomePath,
  PERSISTED_HOME_SEED_FILENAME,
  PERSISTED_HOME_SYNC_SCRIPT_FILENAME,
} from '../../src/persisted_home_state.ts';

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

test('persisted home sync script restores and snapshots managed home files', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'input-persisted-home-home-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'input-persisted-home-work-'));
  t.teardown(async () => {
    await rm(homeDir, { force: true, recursive: true });
    await rm(workDir, { force: true, recursive: true });
  });

  const entries = [
    { path: '.claude.json', content: '{\n  "theme": "dark"\n}\n' },
    { path: '.claude/sessions/a.txt', content: 'first transcript\n' },
    { path: '.claude/sessions/nested/b.txt', content: 'second transcript\n' },
    { path: '.jsh_history', content: 'npm test\ngit status\n' },
  ];
  const scriptPath = path.join(homeDir, PERSISTED_HOME_SYNC_SCRIPT_FILENAME);
  const seedPath = path.join(homeDir, PERSISTED_HOME_SEED_FILENAME);

  await writeFile(scriptPath, buildPersistedHomeSyncScript(seedPath), 'utf8');
  await writeFile(seedPath, buildPersistedHomeSeed(entries), 'utf8');
  await mkdir(path.join(homeDir, '.claude', 'sessions'), { recursive: true });
  await writeFile(path.join(homeDir, '.jsh_history'), 'stale history\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude.json'), 'stale config\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude', 'sessions', 'stale.txt'), 'stale transcript\n', 'utf8');

  const restore = await runNodeScript(scriptPath, ['restore'], {
    cwd: workDir,
    env: { HOME: homeDir },
  });
  t.is(restore.code, 0, restore.stderr);
  t.is(await readFile(path.join(homeDir, '.jsh_history'), 'utf8'), entries[3]?.content);
  t.is(await readFile(path.join(homeDir, '.claude.json'), 'utf8'), entries[0]?.content);
  t.is(await readFile(path.join(homeDir, '.claude', 'sessions', 'a.txt'), 'utf8'), entries[1]?.content);
  t.is(await readFile(path.join(homeDir, '.claude', 'sessions', 'nested', 'b.txt'), 'utf8'), entries[2]?.content);
  await t.throwsAsync(stat(path.join(homeDir, '.claude', 'sessions', 'stale.txt')));

  const snapshot = await runNodeScript(scriptPath, ['snapshot'], {
    cwd: workDir,
    env: { HOME: homeDir },
  });
  t.is(snapshot.code, 0, snapshot.stderr);
  t.deepEqual(JSON.parse(snapshot.stdout.trim()), {
    type: 'snapshot',
    entries,
  });
});

test('normalizePersistedHomePath rejects absolute and parent paths', (t) => {
  t.throws(() => normalizePersistedHomePath('/tmp/file'), { message: /relative to \$HOME/ });
  t.throws(() => normalizePersistedHomePath('../file'), { message: /stay inside \$HOME/ });
  t.is(normalizePersistedHomePath('.claude/sessions/nested/file.txt'), '.claude/sessions/nested/file.txt');
});
