'use strict';

const fs = require('node:fs');

function writeError(stderr, message) {
  stderr.write(`wc: ${message}\n`);
}

function parseArgs(args) {
  const options = {
    bytes: false,
    chars: false,
    files: [],
    lines: false,
    longestLine: false,
    words: false,
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
            options.bytes = true;
            break;
          case 'm':
            options.chars = true;
            break;
          case 'l':
            options.lines = true;
            break;
          case 'L':
            options.longestLine = true;
            break;
          case 'w':
            options.words = true;
            break;
          default:
            throw new Error(`unsupported option -${flag}`);
        }
      }
      continue;
    }

    options.files.push(arg);
  }

  if (!options.bytes && !options.chars && !options.lines && !options.longestLine && !options.words) {
    options.bytes = true;
    options.lines = true;
    options.words = true;
  }

  return options;
}

function countLines(text) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') count += 1;
  }
  return count;
}

function countWords(text) {
  const matches = text.match(/\S+/g);
  return matches == null ? 0 : matches.length;
}

function countChars(text) {
  return Array.from(text).length;
}

function longestLineLength(text) {
  const lines = text.split(/\r?\n/);
  let longest = 0;
  for (const line of lines) {
    const length = Array.from(line).length;
    if (length > longest) longest = length;
  }
  return longest;
}

function summarizeBuffer(buffer) {
  const text = buffer.toString('utf8');
  return {
    bytes: buffer.length,
    chars: countChars(text),
    lines: countLines(text),
    longestLine: longestLineLength(text),
    words: countWords(text),
  };
}

function readInput(filePath) {
  if (filePath === '-') {
    return fs.readFileSync(0);
  }
  return fs.readFileSync(filePath);
}

function formatLine(summary, options, label) {
  const columns = [];
  if (options.lines) columns.push(String(summary.lines).padStart(8, ' '));
  if (options.words) columns.push(String(summary.words).padStart(8, ' '));
  if (options.bytes) columns.push(String(summary.bytes).padStart(8, ' '));
  if (options.chars) columns.push(String(summary.chars).padStart(8, ' '));
  if (options.longestLine) columns.push(String(summary.longestLine).padStart(8, ' '));
  if (label) columns.push(` ${label}`);
  return columns.join('');
}

function zeroSummary() {
  return {
    bytes: 0,
    chars: 0,
    lines: 0,
    longestLine: 0,
    words: 0,
  };
}

function mergeSummaries(left, right) {
  return {
    bytes: left.bytes + right.bytes,
    chars: left.chars + right.chars,
    lines: left.lines + right.lines,
    longestLine: Math.max(left.longestLine, right.longestLine),
    words: left.words + right.words,
  };
}

function runWc(args, io) {
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  const targets = options.files.length === 0 ? ['-'] : options.files;
  const summaries = [];

  for (const target of targets) {
    try {
      const buffer = readInput(target);
      summaries.push({
        label: target === '-' && options.files.length === 0 ? '' : target,
        summary: summarizeBuffer(buffer),
      });
    } catch (err) {
      writeError(io.stderr, `${target}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const lines = summaries.map((entry) => formatLine(entry.summary, options, entry.label));
  if (summaries.length > 1) {
    const total = summaries.reduce((accumulator, entry) => mergeSummaries(accumulator, entry.summary), zeroSummary());
    lines.push(formatLine(total, options, 'total'));
  }

  io.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

module.exports = {
  runWc,
};
