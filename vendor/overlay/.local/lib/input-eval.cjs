'use strict';

const { spawnSync } = require('node:child_process');

function writeError(stderr, message) {
  stderr.write(`eval: ${message}\n`);
}

function resolveShell() {
  const candidates = [];
  if (typeof process.env.SHELL === 'string' && process.env.SHELL.trim()) {
    candidates.push(process.env.SHELL.trim());
  }
  candidates.push('sh');

  const tried = new Set();
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    const probe = spawnSync(candidate, ['-c', ''], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    if (!probe.error) {
      return candidate;
    }
  }

  return candidates[0] ?? 'sh';
}

async function runEval(args, io) {
  const expression = args.join(' ');
  if (expression.length === 0) {
    return 0;
  }

  const shell = resolveShell();
  const child = spawnSync(shell, ['-c', expression], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (child.error) {
    writeError(io.stderr, child.error.message);
    return 1;
  }

  return child.status ?? 1;
}

module.exports = {
  runEval,
};
