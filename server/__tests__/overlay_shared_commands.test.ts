import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    input?: Buffer | string;
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdin.end(options.input ?? '');
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

test('shared overlay fd, find, printf, wc, and uniq commands are executable', async (t) => {
  t.is((await stat(path.join(overlayBinDir, 'fd'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'find'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'rg'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'grep'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'printf'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'wc'))).mode & 0o777, 0o755);
  t.is((await stat(path.join(overlayBinDir, 'uniq'))).mode & 0o777, 0o755);
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

test('shared overlay rg supports Claude and Pi compatible flags', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-rg-compat-'));
  t.teardown(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  await mkdir(path.join(cwd, '.claude', 'commands'), { recursive: true });
  await mkdir(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(cwd, 'src', 'nested', 'deep'), { recursive: true });
  await writeFile(path.join(cwd, '.hidden.md'), 'Alpha hidden\n', 'utf8');
  await writeFile(path.join(cwd, '.claude', 'commands', 'prompt.md'), 'Prompt Alpha\n', 'utf8');
  await writeFile(path.join(cwd, 'README.MD'), 'ALPHA readme\n', 'utf8');
  await writeFile(path.join(cwd, 'literal.txt'), 'a+b\nregex ab\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'main.ts'), 'const alpha = "Alpha";\nconst literal = "a+b";\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'nested', 'note.md'), 'alpha note\n', 'utf8');
  await writeFile(path.join(cwd, 'src', 'nested', 'deep', 'too-deep.md'), 'Alpha deep\n', 'utf8');
  await writeFile(path.join(cwd, 'node_modules', 'pkg', 'ignored.md'), 'Alpha ignored\n', 'utf8');
  await symlink(path.join(cwd, 'src', 'nested'), path.join(cwd, 'linked-nested'));

  const filesDefault = await runCommand('rg', ['--files', '.'], { cwd });
  t.is(filesDefault.code, 0, filesDefault.stderr);
  t.deepEqual(outputLines(filesDefault.stdout), [
    'literal.txt',
    'README.MD',
    'src/main.ts',
    'src/nested/deep/too-deep.md',
    'src/nested/note.md',
  ]);

  const filesWithFilters = await runCommand(
    'rg',
    ['--files', '--hidden', '--follow', '--max-depth', '2', '--iglob', '*.md', '--glob', '!**/node_modules/**', '.'],
    { cwd },
  );
  t.is(filesWithFilters.code, 0, filesWithFilters.stderr);
  t.deepEqual(outputLines(filesWithFilters.stdout), ['.hidden.md', 'linked-nested/note.md', 'README.MD']);

  const longFormSearch = await runCommand('rg', ['--line-number', '--ignore-case', '--color=never', 'alpha', '.'], {
    cwd,
  });
  t.is(longFormSearch.code, 0, longFormSearch.stderr);
  t.deepEqual(outputLines(longFormSearch.stdout), [
    'README.MD:1:ALPHA readme',
    'src/main.ts:1:const alpha = "Alpha";',
    'src/nested/deep/too-deep.md:1:Alpha deep',
    'src/nested/note.md:1:alpha note',
  ]);

  const fixedStrings = await runCommand('rg', ['--fixed-strings', '--line-number', 'a+b', '.'], { cwd });
  t.is(fixedStrings.code, 0, fixedStrings.stderr);
  t.deepEqual(outputLines(fixedStrings.stdout), ['literal.txt:1:a+b', 'src/main.ts:2:const literal = "a+b";']);

  const jsonOutput = await runCommand(
    'rg',
    ['--json', '--line-number', '--color=never', '--hidden', '--glob', '*.md', 'Alpha', '.'],
    { cwd },
  );
  t.is(jsonOutput.code, 0, jsonOutput.stderr);
  const jsonLines = outputLines(jsonOutput.stdout).map((line) => JSON.parse(line));
  t.deepEqual(
    jsonLines.map((event) => [event.type, event.data.path.text, event.data.line_number]),
    [
      ['match', '.claude/commands/prompt.md', 1],
      ['match', '.hidden.md', 1],
      ['match', 'src/nested/deep/too-deep.md', 1],
    ],
  );
});

test('shared overlay printf command supports basic formatting and errors', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-printf-'));
  t.teardown(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  const literal = await runCommand('printf', ['hello'], { cwd });
  t.is(literal.code, 0, literal.stderr);
  t.is(literal.stdout, 'hello');

  const newline = await runCommand('printf', ['%s\\n', 'world'], { cwd });
  t.is(newline.code, 0, newline.stderr);
  t.is(newline.stdout, 'world\n');

  const nulTerminated = await runCommand('printf', ['%s\\0', 'hi'], { cwd });
  t.is(nulTerminated.code, 0, nulTerminated.stderr);
  t.is(nulTerminated.stdout, 'hi\0');

  const roundedPercent = await runCommand('printf', ['5h: %.0f%%', '42.2'], { cwd });
  t.is(roundedPercent.code, 0, roundedPercent.stderr);
  t.is(roundedPercent.stdout, '5h: 42%');

  const repeatedFormat = await runCommand('printf', ['<%s>', 'a', 'b'], { cwd });
  t.is(repeatedFormat.code, 0, repeatedFormat.stderr);
  t.is(repeatedFormat.stdout, '<a><b>');

  const unsupportedFormat = await runCommand('printf', ['%q', 'value'], { cwd });
  t.is(unsupportedFormat.code, 1);
  t.true(unsupportedFormat.stderr.includes('printf: unsupported format %q'));

  const invalidNumber = await runCommand('printf', ['%.0f', 'not-a-number'], { cwd });
  t.is(invalidNumber.code, 1);
  t.true(invalidNumber.stderr.includes('printf: invalid number: not-a-number'));

  const missingFormat = await runCommand('printf', [], { cwd });
  t.is(missingFormat.code, 1);
  t.true(missingFormat.stderr.includes('printf: missing format string'));
});

test('shared overlay wc command supports files, stdin, and standard flags', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-wc-'));
  t.teardown(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  await writeFile(path.join(cwd, 'alpha.txt'), 'alpha beta\ngamma\n', 'utf8');
  await writeFile(path.join(cwd, 'beta.txt'), 'one\ntwo three\n', 'utf8');

  const defaultCounts = await runCommand('wc', ['alpha.txt'], { cwd });
  t.is(defaultCounts.code, 0, defaultCounts.stderr);
  t.is(defaultCounts.stdout, '       2       3      17 alpha.txt\n');

  const lineCount = await runCommand('wc', ['-l', 'alpha.txt'], { cwd });
  t.is(lineCount.code, 0, lineCount.stderr);
  t.is(lineCount.stdout, '       2 alpha.txt\n');

  const longestLine = await runCommand('wc', ['-L', 'alpha.txt'], { cwd });
  t.is(longestLine.code, 0, longestLine.stderr);
  t.is(longestLine.stdout, '      10 alpha.txt\n');

  const stdinCounts = await runCommand('wc', ['-w'], {
    cwd,
    input: 'red blue green\n',
  });
  t.is(stdinCounts.code, 0, stdinCounts.stderr);
  t.is(stdinCounts.stdout, '       3\n');

  const totals = await runCommand('wc', ['alpha.txt', 'beta.txt'], { cwd });
  t.is(totals.code, 0, totals.stderr);
  t.is(
    totals.stdout,
    '       2       3      17 alpha.txt\n       2       3      14 beta.txt\n       4       6      31 total\n',
  );

  const unsupportedOption = await runCommand('wc', ['-z'], { cwd });
  t.is(unsupportedOption.code, 1);
  t.true(unsupportedOption.stderr.includes('wc: unsupported option -z'));
});

test('shared overlay uniq command supports stdin, files, and count filtering', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-uniq-'));
  t.teardown(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  await writeFile(path.join(cwd, 'items.txt'), 'a\na\nb\nB\nc\nc\n', 'utf8');

  const defaultOutput = await runCommand('uniq', ['items.txt'], { cwd });
  t.is(defaultOutput.code, 0, defaultOutput.stderr);
  t.is(defaultOutput.stdout, 'a\nb\nB\nc\n');

  const counted = await runCommand('uniq', ['-c', 'items.txt'], { cwd });
  t.is(counted.code, 0, counted.stderr);
  t.is(counted.stdout, '      2 a\n      1 b\n      1 B\n      2 c\n');

  const duplicatesOnly = await runCommand('uniq', ['-d', 'items.txt'], { cwd });
  t.is(duplicatesOnly.code, 0, duplicatesOnly.stderr);
  t.is(duplicatesOnly.stdout, 'a\nc\n');

  const uniqueOnly = await runCommand('uniq', ['-u', 'items.txt'], { cwd });
  t.is(uniqueOnly.code, 0, uniqueOnly.stderr);
  t.is(uniqueOnly.stdout, 'b\nB\n');

  const ignoreCase = await runCommand('uniq', ['-i', '-c'], {
    cwd,
    input: 'Alpha\nalpha\nbeta\n',
  });
  t.is(ignoreCase.code, 0, ignoreCase.stderr);
  t.is(ignoreCase.stdout, '      2 Alpha\n      1 beta\n');

  const unsupportedOutputFile = await runCommand('uniq', ['items.txt', 'out.txt'], { cwd });
  t.is(unsupportedOutputFile.code, 1);
  t.true(unsupportedOutputFile.stderr.includes('uniq: output files are not supported'));
});
