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
  t.is((await stat(path.join(overlayBinDir, 'rg'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'grep'))).mode & 0o777, 0o755);
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

  const rgHelp = await runCommand('rg', ['--help'], { cwd });
  t.is(rgHelp.code, 0, rgHelp.stderr);
  t.true(rgHelp.stdout.includes('usage: rg [options] <pattern> [path]'));
  t.true(rgHelp.stdout.includes('--debug'));

  const grepHelp = await runCommand('grep', ['--help'], { cwd });
  t.is(grepHelp.code, 0, grepHelp.stderr);
  t.true(grepHelp.stdout.includes('usage: grep [options] <pattern> [path...]'));
  t.true(grepHelp.stdout.includes('--debug'));

  const rgVersion = await runCommand('rg', ['--version'], { cwd });
  t.is(rgVersion.code, 0, rgVersion.stderr);
  t.is(rgVersion.stdout.trim(), 'rg 0.1.0');

  const grepVersion = await runCommand('grep', ['--version'], { cwd });
  t.is(grepVersion.code, 0, grepVersion.stderr);
  t.is(grepVersion.stdout.trim(), 'grep 0.1.0');
});

test('shared overlay rg and grep commands support basic content search', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-content-search-'));
  t.teardown(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  await mkdir(path.join(cwd, '.git'), { recursive: true });
  await mkdir(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(cwd, 'src', 'nested'), { recursive: true });
  await writeFile(path.join(cwd, '.hidden.md'), 'Alpha hidden\n', 'utf8');
  await writeFile(path.join(cwd, '.git', 'ignored.txt'), 'Alpha ignored\n', 'utf8');
  await writeFile(path.join(cwd, 'node_modules', 'pkg', 'ignored.ts'), 'const ignored = "Alpha";\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'main.ts'), 'const alpha = "Alpha";\nconst beta = "Beta";\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'ordered.txt'), 'x\nAlpha early\nx\nx\nx\nx\nx\nx\nx\nAlpha late\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'nested', 'note.md'), 'alpha note\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 65, 66, 67]));

  const rgDefault = await runCommand('rg', ['Alpha', '.'], { cwd });
  t.is(rgDefault.code, 0, rgDefault.stderr);
  t.deepEqual(outputLines(rgDefault.stdout), [
    'src/main.ts:const alpha = "Alpha";',
    'src/ordered.txt:Alpha early',
    'src/ordered.txt:Alpha late',
  ]);

  const rgLineNumbers = await runCommand('rg', ['-n', 'Alpha', '.'], { cwd });
  t.is(rgLineNumbers.code, 0, rgLineNumbers.stderr);
  t.deepEqual(outputLines(rgLineNumbers.stdout), [
    'src/main.ts:1:const alpha = "Alpha";',
    'src/ordered.txt:2:Alpha early',
    'src/ordered.txt:10:Alpha late',
  ]);

  const rgIgnoreCase = await runCommand('rg', ['-i', 'alpha', '.'], { cwd });
  t.is(rgIgnoreCase.code, 0, rgIgnoreCase.stderr);
  t.deepEqual(outputLines(rgIgnoreCase.stdout), [
    'src/main.ts:const alpha = "Alpha";',
    'src/nested/note.md:alpha note',
    'src/ordered.txt:Alpha early',
    'src/ordered.txt:Alpha late',
  ]);

  const rgGlob = await runCommand('rg', ['-g', '*.md', '-i', 'alpha', '.'], { cwd });
  t.is(rgGlob.code, 0, rgGlob.stderr);
  t.deepEqual(outputLines(rgGlob.stdout), ['src/nested/note.md:alpha note']);

  const rgType = await runCommand('rg', ['-t', 'ts', 'Alpha', '.'], { cwd });
  t.is(rgType.code, 0, rgType.stderr);
  t.deepEqual(outputLines(rgType.stdout), ['src/main.ts:const alpha = "Alpha";']);

  const rgHidden = await runCommand('rg', ['-H', 'Alpha', '.'], { cwd });
  t.is(rgHidden.code, 0, rgHidden.stderr);
  t.deepEqual(outputLines(rgHidden.stdout), [
    '.hidden.md:Alpha hidden',
    'src/main.ts:const alpha = "Alpha";',
    'src/ordered.txt:Alpha early',
    'src/ordered.txt:Alpha late',
  ]);

  const rgIgnored = await runCommand('rg', ['-I', 'Alpha', '.'], { cwd });
  t.is(rgIgnored.code, 0, rgIgnored.stderr);
  t.deepEqual(outputLines(rgIgnored.stdout), [
    'node_modules/pkg/ignored.ts:const ignored = "Alpha";',
    'src/main.ts:const alpha = "Alpha";',
    'src/ordered.txt:Alpha early',
    'src/ordered.txt:Alpha late',
  ]);

  const rgNoMatch = await runCommand('rg', ['Gamma', '.'], { cwd });
  t.is(rgNoMatch.code, 1, rgNoMatch.stderr);
  t.deepEqual(outputLines(rgNoMatch.stdout), []);

  const rgDebug = await runCommand('rg', ['--debug', '-n', 'Alpha', '.'], { cwd });
  t.is(rgDebug.code, 0, rgDebug.stderr);
  t.true(rgDebug.stderr.includes('"command":"rg"'));
  t.true(rgDebug.stderr.includes('"searchedFiles":3'));
  t.true(rgDebug.stderr.includes('"resultCount":3'));

  const grepDefault = await runCommand('grep', ['Alpha', '.'], { cwd });
  t.is(grepDefault.code, 0, grepDefault.stderr);
  t.deepEqual(outputLines(grepDefault.stdout), [
    '.git/ignored.txt:Alpha ignored',
    '.hidden.md:Alpha hidden',
    'node_modules/pkg/ignored.ts:const ignored = "Alpha";',
    'src/main.ts:const alpha = "Alpha";',
    'src/ordered.txt:Alpha early',
    'src/ordered.txt:Alpha late',
  ]);

  const grepLineNumbers = await runCommand('grep', ['-n', 'Alpha', '.'], { cwd });
  t.is(grepLineNumbers.code, 0, grepLineNumbers.stderr);
  t.deepEqual(outputLines(grepLineNumbers.stdout), [
    '.git/ignored.txt:1:Alpha ignored',
    '.hidden.md:1:Alpha hidden',
    'node_modules/pkg/ignored.ts:1:const ignored = "Alpha";',
    'src/main.ts:1:const alpha = "Alpha";',
    'src/ordered.txt:2:Alpha early',
    'src/ordered.txt:10:Alpha late',
  ]);

  const grepIgnoreCase = await runCommand('grep', ['-i', 'alpha', '.'], { cwd });
  t.is(grepIgnoreCase.code, 0, grepIgnoreCase.stderr);
  t.deepEqual(outputLines(grepIgnoreCase.stdout), [
    '.git/ignored.txt:Alpha ignored',
    '.hidden.md:Alpha hidden',
    'node_modules/pkg/ignored.ts:const ignored = "Alpha";',
    'src/main.ts:const alpha = "Alpha";',
    'src/nested/note.md:alpha note',
    'src/ordered.txt:Alpha early',
    'src/ordered.txt:Alpha late',
  ]);

  const grepNoMatch = await runCommand('grep', ['Gamma', '.'], { cwd });
  t.is(grepNoMatch.code, 1, grepNoMatch.stderr);
  t.deepEqual(outputLines(grepNoMatch.stdout), []);

  const grepDebug = await runCommand('grep', ['--debug', '-n', 'Alpha', '.'], { cwd });
  t.is(grepDebug.code, 0, grepDebug.stderr);
  t.true(grepDebug.stderr.includes('"command":"grep"'));
  t.true(grepDebug.stderr.includes('"searchedFiles":6'));
  t.true(grepDebug.stderr.includes('"resultCount":6'));
});
