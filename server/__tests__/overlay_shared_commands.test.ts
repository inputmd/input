import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';

const overlayBinDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'vendor',
  'overlay',
  '.local',
  'bin',
);

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
  },
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: [overlayBinDir, process.env.PATH ?? ''].filter(Boolean).join(':'),
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
      resolve({
        code: code ?? 1,
        stderr,
        stdout,
      });
    });
  });
}

function outputLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('shared overlay fd and find commands are executable', async (t) => {
  t.is((await stat(path.join(overlayBinDir, 'fd'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'find'))).mode & 0o777, 0o755);
});

test('shared overlay fd and find commands support basic file discovery', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-search-'));
  t.teardown(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  await mkdir(path.join(cwd, '.git'), { recursive: true });
  await mkdir(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(cwd, 'src', 'nested'), { recursive: true });
  await writeFile(path.join(cwd, '.env'), 'TOKEN=secret\n', 'utf8');
  await writeFile(path.join(cwd, '.git', 'config'), '[core]\n', 'utf8');
  await writeFile(path.join(cwd, 'README.md'), '# hello\n', 'utf8');
  await writeFile(path.join(cwd, 'node_modules', 'pkg', 'config.json'), '{"name":"pkg"}\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'component.ts'), 'export const component = true;\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'component.tsx'), 'export const Component = () => null;\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'nested', 'util.ts'), 'export const util = 1;\n', 'utf8');

  const defaultFd = await runCommand('fd', ['component'], { cwd });
  t.is(defaultFd.code, 0, defaultFd.stderr);
  t.deepEqual(outputLines(defaultFd.stdout), ['src/component.ts', 'src/component.tsx']);

  const extensionFd = await runCommand('fd', ['-e', 'ts', 'component'], { cwd });
  t.is(extensionFd.code, 0, extensionFd.stderr);
  t.deepEqual(outputLines(extensionFd.stdout), ['src/component.ts']);

  const hiddenFd = await runCommand('fd', ['.env'], { cwd });
  t.is(hiddenFd.code, 0, hiddenFd.stderr);
  t.deepEqual(outputLines(hiddenFd.stdout), []);

  const includeHiddenFd = await runCommand('fd', ['-H', '.env'], { cwd });
  t.is(includeHiddenFd.code, 0, includeHiddenFd.stderr);
  t.deepEqual(outputLines(includeHiddenFd.stdout), ['.env']);

  const ignoredFd = await runCommand('fd', ['config'], { cwd });
  t.is(ignoredFd.code, 0, ignoredFd.stderr);
  t.deepEqual(outputLines(ignoredFd.stdout), []);

  const includeIgnoredFd = await runCommand('fd', ['-I', 'config'], { cwd });
  t.is(includeIgnoredFd.code, 0, includeIgnoredFd.stderr);
  t.deepEqual(outputLines(includeIgnoredFd.stdout), ['node_modules/pkg/config.json']);

  const findByName = await runCommand('find', ['.', '-name', '*.ts', '-type', 'f'], { cwd });
  t.is(findByName.code, 0, findByName.stderr);
  t.deepEqual(outputLines(findByName.stdout), ['src/component.ts', 'src/nested/util.ts']);

  const findHidden = await runCommand('find', ['.', '-name', '.env'], { cwd });
  t.is(findHidden.code, 0, findHidden.stderr);
  t.deepEqual(outputLines(findHidden.stdout), ['.env']);
});

test('shared overlay fd and find commands expose help, version, and debug output', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-search-help-'));
  t.teardown(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  await writeFile(path.join(cwd, 'note.md'), '# note\n', 'utf8');

  const fdHelp = await runCommand('fd', ['--help'], { cwd });
  t.is(fdHelp.code, 0, fdHelp.stderr);
  t.true(fdHelp.stdout.includes('usage: fd [options] [pattern] [path]'));
  t.true(fdHelp.stdout.includes('--debug'));

  const fdVersion = await runCommand('fd', ['--version'], { cwd });
  t.is(fdVersion.code, 0, fdVersion.stderr);
  t.is(fdVersion.stdout.trim(), 'fd 0.1.0');

  const fdDebug = await runCommand('fd', ['--debug', '.'], { cwd });
  t.is(fdDebug.code, 0, fdDebug.stderr);
  t.true(fdDebug.stderr.includes('"command":"fd"'));
  t.true(fdDebug.stderr.includes('"resultCount":1'));
  t.true(fdDebug.stderr.includes('"resultSample":["note.md"]'));
  t.deepEqual(outputLines(fdDebug.stdout), ['note.md']);

  const findHelp = await runCommand('find', ['--help'], { cwd });
  t.is(findHelp.code, 0, findHelp.stderr);
  t.true(findHelp.stdout.includes('usage: find [path] [options]'));
  t.true(findHelp.stdout.includes('--debug'));

  const findVersion = await runCommand('find', ['--version'], { cwd });
  t.is(findVersion.code, 0, findVersion.stderr);
  t.is(findVersion.stdout.trim(), 'find 0.1.0');

  const findDebug = await runCommand('find', ['--debug', '.', '-name', '*.md', '-type', 'f'], { cwd });
  t.is(findDebug.code, 0, findDebug.stderr);
  t.true(findDebug.stderr.includes('"command":"find"'));
  t.true(findDebug.stderr.includes('"resultCount":1'));
  t.true(findDebug.stderr.includes('"resultSample":["note.md"]'));
  t.deepEqual(outputLines(findDebug.stdout), ['note.md']);
});
