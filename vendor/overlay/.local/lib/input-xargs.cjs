'use strict';

const { spawnSync } = require('node:child_process');
const { readStdinBuffer } = require('./input-stdin.cjs');

function writeError(stderr, message) {
  stderr.write(`xargs: ${message}\n`);
}

function parseArgs(args) {
  const options = {
    command: null,
    commandArgs: [],
    maxArgs: null,
    nullDelimited: false,
    noRunIfEmpty: false,
  };

  let parsingFlags = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }

    if (parsingFlags && arg === '-0') {
      options.nullDelimited = true;
      continue;
    }

    if (parsingFlags && arg === '-r') {
      options.noRunIfEmpty = true;
      continue;
    }

    if (parsingFlags && arg === '-n') {
      const value = args[index + 1];
      if (value == null) {
        throw new Error('missing value for -n');
      }
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
        throw new Error(`invalid value for -n: ${value}`);
      }
      options.maxArgs = parsedValue;
      index += 1;
      continue;
    }

    if (parsingFlags && arg.startsWith('-') && arg !== '-') {
      throw new Error(`unsupported option ${arg}`);
    }

    if (options.command == null) {
      options.command = arg;
      options.commandArgs = args.slice(index + 1);
      break;
    }
  }

  if (options.command == null) {
    throw new Error('missing command');
  }

  return options;
}

function splitInput(buffer, nullDelimited) {
  if (buffer.length === 0) return [];

  if (nullDelimited) {
    return buffer
      .toString('utf8')
      .split('\0')
      .filter((value) => value.length > 0);
  }

  const text = buffer.toString('utf8');
  const matches = text.match(/\S+/g);
  return matches == null ? [] : matches;
}

function chunkValues(values, maxArgs) {
  if (values.length === 0) return [[]];
  if (maxArgs == null || maxArgs >= values.length) return [values];

  const chunks = [];
  for (let index = 0; index < values.length; index += maxArgs) {
    chunks.push(values.slice(index, index + maxArgs));
  }
  return chunks;
}

function runChild(command, commandArgs, io) {
  const child = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (typeof child.stdout === 'string' && child.stdout.length > 0) {
    io.stdout.write(child.stdout);
  }
  if (typeof child.stderr === 'string' && child.stderr.length > 0) {
    io.stderr.write(child.stderr);
  }

  if (child.error) {
    writeError(io.stderr, child.error.message);
    return 1;
  }

  return child.status ?? 1;
}

async function runXargs(args, io) {
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  let input;
  try {
    input = await readStdinBuffer(io.stdin);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  const values = splitInput(input, options.nullDelimited);
  if (values.length === 0 && options.noRunIfEmpty) {
    return 0;
  }

  const chunks = chunkValues(values, options.maxArgs);
  let exitCode = 0;

  for (const chunk of chunks) {
    const childExitCode = runChild(options.command, [...options.commandArgs, ...chunk], io);
    if (childExitCode !== 0) {
      exitCode = childExitCode;
      break;
    }
  }

  return exitCode;
}

module.exports = {
  runXargs,
};
