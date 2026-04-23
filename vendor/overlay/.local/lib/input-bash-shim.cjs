'use strict';

const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

function writeError(stderr, message) {
  stderr.write(`bash: ${message}\n`);
}

function resolveDelegateShell() {
  const candidates = [];
  if (typeof process.env.INPUT_BASH_SHIM_SHELL === 'string' && process.env.INPUT_BASH_SHIM_SHELL.trim()) {
    candidates.push(process.env.INPUT_BASH_SHIM_SHELL.trim());
  }
  candidates.push('sh');

  const tried = new Set();
  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue;
    tried.add(candidate);

    const probe = spawnSync(candidate, ['-c', ''], {
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 500,
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return candidates[0] ?? 'sh';
}

function parseInvocation(args) {
  if (args.length === 0) {
    return { kind: 'error', message: 'interactive mode is not supported in the WebContainer overlay' };
  }

  let commandMode = false;
  let command = null;
  const extraArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (command !== null) {
      extraArgs.push(arg);
      continue;
    }

    if (arg === '--help') {
      return { kind: 'help' };
    }

    if (arg === '--version') {
      return { kind: 'version' };
    }

    if (arg === '--') {
      if (!commandMode) {
        return { kind: 'error', message: `unsupported invocation: ${args.join(' ')}` };
      }
      command = args[index + 1] ?? null;
      extraArgs.push(...args.slice(index + 2));
      break;
    }

    if (arg.startsWith('-') && arg !== '-') {
      let supported = true;
      for (const flag of arg.slice(1)) {
        if (flag === 'c') {
          commandMode = true;
        } else if (flag === 'l') {
          continue;
        } else {
          supported = false;
          break;
        }
      }
      if (supported) {
        continue;
      }
    }

    if (!commandMode) {
      return { kind: 'error', message: `unsupported invocation: ${args.join(' ')}` };
    }

    command = arg;
    extraArgs.push(...args.slice(index + 1));
    break;
  }

  if (!commandMode) {
    return { kind: 'error', message: `unsupported invocation: ${args.join(' ')}` };
  }

  if (command === null) {
    return { kind: 'error', message: 'option requires an argument -- c' };
  }

  return { command, extraArgs, kind: 'command' };
}

function stripDevNullRedirects(command) {
  let next = '';
  let removed = false;
  let quote = null;

  for (let index = 0; index < command.length; ) {
    const char = command[index];

    if (quote === "'") {
      next += char;
      if (char === "'") quote = null;
      index += 1;
      continue;
    }

    if (quote === '"') {
      next += char;
      if (char === '\\' && index + 1 < command.length) {
        next += command[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') quote = null;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      next += char;
      index += 1;
      continue;
    }

    if (char === '\\' && index + 1 < command.length) {
      next += char;
      next += command[index + 1];
      index += 2;
      continue;
    }

    if (char === '<') {
      const previous = next[next.length - 1] ?? '';
      if (previous !== '<' && !/[0-9]/.test(previous)) {
        let lookahead = index + 1;
        while (lookahead < command.length && /[ \t]/.test(command[lookahead])) {
          lookahead += 1;
        }

        if (command.startsWith('/dev/null', lookahead)) {
          const end = lookahead + '/dev/null'.length;
          const boundary = command[end];
          if (boundary === undefined || /[\s;&|)\n]/.test(boundary)) {
            removed = true;
            index = end;
            while (index < command.length && /[ \t]/.test(command[index])) {
              index += 1;
            }
            continue;
          }
        }
      }
    }

    next += char;
    index += 1;
  }

  return {
    command: removed ? next.trimEnd() : next,
    removed,
  };
}

function shellQuote(value) {
  const stringValue = String(value);
  if (stringValue === '') return "''";
  if (/^[A-Za-z0-9_./:=@+,-]+$/.test(stringValue)) return stringValue;
  return `'${stringValue.replaceAll("'", `'"'"'`)}'`;
}

function parseSnapshotFileAssignment(command) {
  const match = command.match(/^\s*SNAPSHOT_FILE=(?:"([^"]*)"|'([^']*)'|([^\s;]+))/);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function maybeCreateClaudeSnapshot(command) {
  const snapshotFile = parseSnapshotFileAssignment(command);
  if (!snapshotFile) return false;
  if (!command.includes('echo "# Snapshot file" >| "$SNAPSHOT_FILE"')) return false;

  mkdirSync(dirname(snapshotFile), { recursive: true });
  writeFileSync(
    snapshotFile,
    [
      '# Snapshot file',
      'unalias -a 2>/dev/null || true',
      'shopt -s expand_aliases 2>/dev/null || true',
      `export PATH=${shellQuote(process.env.PATH ?? '')}`,
      '',
    ].join('\n'),
    'utf8',
  );
  return true;
}

function formatHelp() {
  return [
    'usage: bash [-lc command] | [-c command]',
    '',
    'WebContainer overlay shim for Claude-compatible bash invocations.',
    'It strips unquoted "< /dev/null" segments and closes stdin at the process level.',
    '',
  ].join('\n');
}

async function runBashShim(args, io) {
  const parsed = parseInvocation(args);
  if (parsed.kind === 'help') {
    io.stdout.write(formatHelp());
    return 0;
  }

  if (parsed.kind === 'version') {
    io.stdout.write('GNU bash, version 5.2.0 (WebContainer overlay shim)\n');
    return 0;
  }

  if (parsed.kind !== 'command') {
    writeError(io.stderr, parsed.message);
    return 2;
  }

  if (maybeCreateClaudeSnapshot(parsed.command)) {
    return 0;
  }

  const delegateShell = resolveDelegateShell();
  const rewritten = stripDevNullRedirects(parsed.command);
  const child = spawnSync(delegateShell, ['-c', rewritten.command, ...parsed.extraArgs], {
    cwd: process.cwd(),
    env: process.env,
    stdio: [rewritten.removed ? 'ignore' : 'inherit', 'inherit', 'inherit'],
  });

  if (child.error) {
    writeError(io.stderr, child.error.message);
    return 1;
  }

  return child.status ?? 1;
}

module.exports = {
  parseInvocation,
  runBashShim,
  stripDevNullRedirects,
};
