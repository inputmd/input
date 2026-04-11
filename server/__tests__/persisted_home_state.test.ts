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
    { path: '.claude/.config.json', content: '{\n  "theme": "dark"\n}\n' },
    { path: '.claude/.credentials.json', content: '{\n  "accessToken": "secret"\n}\n' },
    { path: '.claude/cache/model-a.bin', content: 'cached bytes\n' },
    { path: '.claude/projects/worktree-a.json', content: '{\n  "cwd": "/tmp/worktree-a"\n}\n' },
    { path: '.claude/sessions/a.txt', content: 'first transcript\n' },
    { path: '.claude/sessions/nested/b.txt', content: 'second transcript\n' },
    { path: '.pi/agent/auth.json', content: '{\n  "openai": { "apiKey": "secret" }\n}\n' },
    { path: '.pi/agent/bin/rg', content: '#!/bin/sh\nexit 0\n' },
    { path: '.pi/agent/extensions/example.js', content: 'export default function example() {}\n' },
    { path: '.pi/agent/keybindings.json', content: '{\n  "app.clear": ["ctrl+l"]\n}\n' },
    { path: '.pi/agent/models.json', content: '[\n  { "provider": "openai", "id": "gpt-4.1" }\n]\n' },
    { path: '.pi/agent/prompts/fix.md', content: '# fix\n\nTighten the implementation.\n' },
    { path: '.pi/agent/settings.json', content: '{\n  "defaultProvider": "openai"\n}\n' },
    { path: '.pi/agent/sessions/pi-session.jsonl', content: '{"type":"header"}\n{"type":"user"}\n' },
    { path: '.pi/agent/sessions/nested/pi-branch.jsonl', content: '{"type":"assistant"}\n' },
    { path: '.pi/agent/themes/contrast.json', content: '{\n  "meta": { "name": "contrast" }\n}\n' },
    { path: '.jsh_history', content: 'npm test\ngit status\n' },
  ];
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry.content]));
  const scriptPath = path.join(homeDir, PERSISTED_HOME_SYNC_SCRIPT_FILENAME);
  const seedPath = path.join(homeDir, PERSISTED_HOME_SEED_FILENAME);

  await writeFile(scriptPath, buildPersistedHomeSyncScript(seedPath), 'utf8');
  await writeFile(seedPath, buildPersistedHomeSeed(entries), 'utf8');
  await mkdir(path.join(homeDir, '.claude', 'cache'), { recursive: true });
  await mkdir(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  await mkdir(path.join(homeDir, '.claude', 'sessions'), { recursive: true });
  await mkdir(path.join(homeDir, '.pi', 'agent', 'bin'), { recursive: true });
  await mkdir(path.join(homeDir, '.pi', 'agent', 'extensions'), { recursive: true });
  await mkdir(path.join(homeDir, '.pi', 'agent', 'prompts'), { recursive: true });
  await mkdir(path.join(homeDir, '.pi', 'agent', 'sessions'), { recursive: true });
  await mkdir(path.join(homeDir, '.pi', 'agent', 'themes'), { recursive: true });
  await writeFile(path.join(homeDir, '.jsh_history'), 'stale history\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude', '.config.json'), 'stale nested config\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude', '.credentials.json'), 'stale credentials\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude.json'), 'stale config\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude', 'cache', 'stale.bin'), 'stale cache\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude', 'projects', 'stale.json'), 'stale project\n', 'utf8');
  await writeFile(path.join(homeDir, '.claude', 'sessions', 'stale.txt'), 'stale transcript\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'auth.json'), 'stale auth\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'bin', 'stale-tool'), 'stale tool\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'extensions', 'stale.js'), 'stale extension\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'keybindings.json'), 'stale keybindings\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'models.json'), 'stale models\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'prompts', 'stale.md'), 'stale prompt\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'settings.json'), 'stale settings\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'sessions', 'stale.jsonl'), 'stale pi session\n', 'utf8');
  await writeFile(path.join(homeDir, '.pi', 'agent', 'themes', 'stale.json'), 'stale theme\n', 'utf8');

  const restore = await runNodeScript(scriptPath, ['restore'], {
    cwd: workDir,
    env: { HOME: homeDir },
  });
  t.is(restore.code, 0, restore.stderr);
  t.is(await readFile(path.join(homeDir, '.jsh_history'), 'utf8'), entryByPath.get('.jsh_history'));
  t.is(await readFile(path.join(homeDir, '.claude', '.config.json'), 'utf8'), entryByPath.get('.claude/.config.json'));
  t.is(
    await readFile(path.join(homeDir, '.claude', '.credentials.json'), 'utf8'),
    entryByPath.get('.claude/.credentials.json'),
  );
  t.is(await readFile(path.join(homeDir, '.claude.json'), 'utf8'), entryByPath.get('.claude.json'));
  t.is(
    await readFile(path.join(homeDir, '.claude', 'cache', 'model-a.bin'), 'utf8'),
    entryByPath.get('.claude/cache/model-a.bin'),
  );
  t.is(
    await readFile(path.join(homeDir, '.claude', 'projects', 'worktree-a.json'), 'utf8'),
    entryByPath.get('.claude/projects/worktree-a.json'),
  );
  t.is(
    await readFile(path.join(homeDir, '.claude', 'sessions', 'a.txt'), 'utf8'),
    entryByPath.get('.claude/sessions/a.txt'),
  );
  t.is(
    await readFile(path.join(homeDir, '.claude', 'sessions', 'nested', 'b.txt'), 'utf8'),
    entryByPath.get('.claude/sessions/nested/b.txt'),
  );
  t.is(await readFile(path.join(homeDir, '.pi', 'agent', 'auth.json'), 'utf8'), entryByPath.get('.pi/agent/auth.json'));
  t.is(await readFile(path.join(homeDir, '.pi', 'agent', 'bin', 'rg'), 'utf8'), entryByPath.get('.pi/agent/bin/rg'));
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'extensions', 'example.js'), 'utf8'),
    entryByPath.get('.pi/agent/extensions/example.js'),
  );
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'keybindings.json'), 'utf8'),
    entryByPath.get('.pi/agent/keybindings.json'),
  );
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'models.json'), 'utf8'),
    entryByPath.get('.pi/agent/models.json'),
  );
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'prompts', 'fix.md'), 'utf8'),
    entryByPath.get('.pi/agent/prompts/fix.md'),
  );
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'settings.json'), 'utf8'),
    entryByPath.get('.pi/agent/settings.json'),
  );
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'sessions', 'pi-session.jsonl'), 'utf8'),
    entryByPath.get('.pi/agent/sessions/pi-session.jsonl'),
  );
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'sessions', 'nested', 'pi-branch.jsonl'), 'utf8'),
    entryByPath.get('.pi/agent/sessions/nested/pi-branch.jsonl'),
  );
  t.is(
    await readFile(path.join(homeDir, '.pi', 'agent', 'themes', 'contrast.json'), 'utf8'),
    entryByPath.get('.pi/agent/themes/contrast.json'),
  );
  await t.throwsAsync(stat(path.join(homeDir, '.claude', 'cache', 'stale.bin')));
  await t.throwsAsync(stat(path.join(homeDir, '.claude', 'projects', 'stale.json')));
  await t.throwsAsync(stat(path.join(homeDir, '.claude', 'sessions', 'stale.txt')));
  await t.throwsAsync(stat(path.join(homeDir, '.pi', 'agent', 'bin', 'stale-tool')));
  await t.throwsAsync(stat(path.join(homeDir, '.pi', 'agent', 'extensions', 'stale.js')));
  await t.throwsAsync(stat(path.join(homeDir, '.pi', 'agent', 'prompts', 'stale.md')));
  await t.throwsAsync(stat(path.join(homeDir, '.pi', 'agent', 'sessions', 'stale.jsonl')));
  await t.throwsAsync(stat(path.join(homeDir, '.pi', 'agent', 'themes', 'stale.json')));

  const snapshot = await runNodeScript(scriptPath, ['snapshot'], {
    cwd: workDir,
    env: { HOME: homeDir },
  });
  t.is(snapshot.code, 0, snapshot.stderr);
  t.deepEqual(JSON.parse(snapshot.stdout.trim()), {
    type: 'snapshot',
    entries: [...entries].sort((left, right) => left.path.localeCompare(right.path)),
  });
});

test('normalizePersistedHomePath rejects absolute and parent paths', (t) => {
  t.throws(() => normalizePersistedHomePath('/tmp/file'), { message: /relative to \$HOME/ });
  t.throws(() => normalizePersistedHomePath('../file'), { message: /stay inside \$HOME/ });
  t.is(normalizePersistedHomePath('.claude/sessions/nested/file.txt'), '.claude/sessions/nested/file.txt');
});
