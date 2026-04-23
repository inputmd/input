'use strict';

const fs = require('node:fs');
const { readStdinText } = require('./input-stdin.cjs');

function writeError(stderr, message) {
  stderr.write(`uniq: ${message}\n`);
}

function parseArgs(args) {
  const options = {
    count: false,
    duplicatesOnly: false,
    files: [],
    ignoreCase: false,
    uniqueOnly: false,
  };

  let parsingFlags = true;
  for (const arg of args) {
    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }

    if (parsingFlags && arg.startsWith('-') && arg !== '-') {
      for (let index = 1; index < arg.length; index += 1) {
        const flag = arg[index];
        switch (flag) {
          case 'c':
            options.count = true;
            break;
          case 'd':
            options.duplicatesOnly = true;
            break;
          case 'i':
            options.ignoreCase = true;
            break;
          case 'u':
            options.uniqueOnly = true;
            break;
          default:
            throw new Error(`unsupported option -${flag}`);
        }
      }
      continue;
    }

    options.files.push(arg);
  }

  if (options.files.length > 1) {
    throw new Error('output files are not supported');
  }

  return options;
}

function normalizeForCompare(value, ignoreCase) {
  return ignoreCase ? value.toLowerCase() : value;
}

async function readInput(filePath, stdin) {
  if (!filePath || filePath === '-') {
    return await readStdinText(stdin);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function splitLinesPreserveLastEmpty(text) {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function renderGroup(line, count, options) {
  if (options.duplicatesOnly && count < 2) return null;
  if (options.uniqueOnly && count !== 1) return null;
  if (options.count) {
    return `${String(count).padStart(7, ' ')} ${line}`;
  }
  return line;
}

async function runUniq(args, io) {
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  let text;
  try {
    text = await readInput(options.files[0], io.stdin);
  } catch (err) {
    const label = options.files[0] ?? 'stdin';
    writeError(io.stderr, `${label}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const lines = splitLinesPreserveLastEmpty(text);
  if (lines.length === 0) {
    return 0;
  }

  const rendered = [];
  let currentLine = lines[0];
  let currentCount = 1;
  let currentKey = normalizeForCompare(currentLine, options.ignoreCase);

  for (let index = 1; index < lines.length; index += 1) {
    const nextLine = lines[index];
    const nextKey = normalizeForCompare(nextLine, options.ignoreCase);
    if (nextKey === currentKey) {
      currentCount += 1;
      continue;
    }

    const nextOutput = renderGroup(currentLine, currentCount, options);
    if (nextOutput != null) rendered.push(nextOutput);
    currentLine = nextLine;
    currentCount = 1;
    currentKey = nextKey;
  }

  const finalOutput = renderGroup(currentLine, currentCount, options);
  if (finalOutput != null) rendered.push(finalOutput);

  if (rendered.length > 0) {
    io.stdout.write(`${rendered.join('\n')}\n`);
  }
  return 0;
}

module.exports = {
  runUniq,
};
