'use strict';

const fs = require('node:fs');
const { readStdinText } = require('./input-stdin.cjs');

function writeError(stderr, message) {
  stderr.write(`sed: ${message}\n`);
}

function parseArgs(args) {
  const options = {
    files: [],
    quiet: false,
    scripts: [],
  };

  let parsingFlags = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }

    if (parsingFlags && arg === '-n') {
      options.quiet = true;
      continue;
    }

    if (parsingFlags && arg === '-e') {
      const script = args[index + 1];
      if (script == null) {
        throw new Error('missing script for -e');
      }
      options.scripts.push(script);
      index += 1;
      continue;
    }

    if (parsingFlags && arg === '-i') {
      throw new Error('in-place editing is not supported');
    }

    if (parsingFlags && arg.startsWith('-') && arg !== '-') {
      throw new Error(`unsupported option ${arg}`);
    }

    if (options.scripts.length === 0) {
      options.scripts.push(arg);
      parsingFlags = false;
      continue;
    }

    options.files.push(arg);
  }

  if (options.scripts.length === 0) {
    throw new Error('missing script');
  }

  return options;
}

function splitScript(script) {
  const commands = [];
  let current = '';
  let inSubstitution = false;
  let delimiter = null;
  let section = 0;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    const previous = index > 0 ? script[index - 1] : '';

    if (!inSubstitution) {
      if (char === ';') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        continue;
      }
      current += char;
      if (char === 's' && current.trim() === 's') {
        inSubstitution = true;
        delimiter = null;
        section = 0;
      }
      continue;
    }

    current += char;
    if (delimiter == null) {
      delimiter = char;
      section = 1;
      continue;
    }

    if (char === delimiter && previous !== '\\') {
      section += 1;
      if (section === 3) {
        inSubstitution = false;
      }
    }
  }

  if (current.trim()) commands.push(current.trim());
  return commands;
}

function parseAddressToken(token) {
  if (token == null || token === '') return null;
  if (token === '$') return { type: 'last' };
  if (/^\d+$/.test(token)) return { type: 'line', value: Number.parseInt(token, 10) };
  throw new Error(`unsupported address ${token}`);
}

function parseAddress(command) {
  let index = 0;
  while (index < command.length && /\s/.test(command[index])) index += 1;
  const startIndex = index;

  if (command[index] === '$') {
    index += 1;
  } else {
    while (index < command.length && /\d/.test(command[index])) index += 1;
  }

  if (index === startIndex) {
    return { command: command.trim(), range: null };
  }

  const firstToken = command.slice(startIndex, index);
  while (index < command.length && /\s/.test(command[index])) index += 1;

  let range = {
    end: null,
    start: parseAddressToken(firstToken),
  };

  if (command[index] === ',') {
    index += 1;
    while (index < command.length && /\s/.test(command[index])) index += 1;
    const rangeStart = index;
    if (command[index] === '$') {
      index += 1;
    } else {
      while (index < command.length && /\d/.test(command[index])) index += 1;
    }
    const secondToken = command.slice(rangeStart, index);
    range.end = parseAddressToken(secondToken);
  }

  return {
    command: command.slice(index).trim(),
    range,
  };
}

function convertSedBreToJs(pattern) {
  return pattern
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\+/g, '+')
    .replace(/\\\?/g, '?')
    .replace(/\\\|/g, '|');
}

function convertSedReplacement(replacement) {
  let output = '';
  for (let index = 0; index < replacement.length; index += 1) {
    const char = replacement[index];
    const next = replacement[index + 1];
    if (char === '\\' && next != null) {
      if (/\d/.test(next)) {
        output += `$${next}`;
        index += 1;
        continue;
      }
      output += next;
      index += 1;
      continue;
    }
    if (char === '&') {
      output += '$&';
      continue;
    }
    if (char === '$') {
      output += '$$';
      continue;
    }
    output += char;
  }
  return output;
}

function parseSubstitution(command) {
  if (!command.startsWith('s') || command.length < 2) {
    throw new Error(`unsupported command ${command}`);
  }

  const delimiter = command[1];
  let cursor = 2;
  const parts = [];
  let current = '';

  while (cursor < command.length) {
    const char = command[cursor];
    if (char === delimiter && command[cursor - 1] !== '\\') {
      parts.push(current);
      current = '';
      cursor += 1;
      if (parts.length === 2) break;
      continue;
    }
    current += char;
    cursor += 1;
  }

  if (parts.length !== 2) {
    throw new Error(`unsupported substitution ${command}`);
  }

  const flags = command.slice(cursor);
  const allowedFlags = new Set(['', 'g', 'p', 'gp', 'pg']);
  if (!allowedFlags.has(flags)) {
    throw new Error(`unsupported substitution flags ${flags}`);
  }

  return {
    flags,
    regex: new RegExp(convertSedBreToJs(parts[0])),
    replacement: convertSedReplacement(parts[1]),
    type: 'substitute',
  };
}

function parseCommand(command) {
  const { command: withoutAddress, range } = parseAddress(command);
  if (withoutAddress === 'p') {
    return { range, type: 'print' };
  }
  if (withoutAddress === 'd') {
    return { range, type: 'delete' };
  }
  if (withoutAddress === 'q') {
    return { range, type: 'quit' };
  }
  if (withoutAddress.startsWith('s')) {
    return {
      ...parseSubstitution(withoutAddress),
      range,
    };
  }
  throw new Error(`unsupported command ${withoutAddress}`);
}

function addressMatches(address, lineNumber, totalLines) {
  if (address == null) return false;
  if (address.type === 'line') return lineNumber === address.value;
  if (address.type === 'last') return lineNumber === totalLines;
  return false;
}

function createMatcher(command) {
  if (command.range == null) {
    return { matches: () => true };
  }

  if (command.range.end == null) {
    return {
      matches(lineNumber, totalLines) {
        return addressMatches(command.range.start, lineNumber, totalLines);
      },
    };
  }

  let inRange = false;
  return {
    matches(lineNumber, totalLines) {
      if (!inRange && addressMatches(command.range.start, lineNumber, totalLines)) {
        inRange = true;
      }
      if (!inRange) return false;
      const shouldEnd = addressMatches(command.range.end, lineNumber, totalLines);
      if (shouldEnd) {
        inRange = false;
      }
      return true;
    },
  };
}

function parsePrograms(scripts) {
  return scripts.flatMap((script) => splitScript(script).map((command) => parseCommand(command)));
}

async function readText(filePath, stdin) {
  if (!filePath || filePath === '-') {
    return await readStdinText(stdin);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

async function runSed(args, io) {
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  let programs;
  try {
    programs = parsePrograms(options.scripts);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  const targets = options.files.length === 0 ? [null] : options.files;
  const allOutput = [];

  for (const target of targets) {
    let text;
    try {
      text = await readText(target, io.stdin);
    } catch (err) {
      writeError(io.stderr, `${target ?? 'stdin'}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const lines = splitLines(text);
    const matchers = programs.map((program) => createMatcher(program));
    let shouldQuit = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      let currentLine = lines[lineIndex];
      let deleted = false;
      let explicitlyPrinted = false;
      const lineNumber = lineIndex + 1;

      for (let programIndex = 0; programIndex < programs.length; programIndex += 1) {
        const program = programs[programIndex];
        if (!matchers[programIndex].matches(lineNumber, lines.length)) continue;

        switch (program.type) {
          case 'print':
            allOutput.push(currentLine);
            explicitlyPrinted = true;
            break;
          case 'delete':
            deleted = true;
            break;
          case 'quit':
            shouldQuit = true;
            break;
          case 'substitute': {
            if (!program.regex.test(currentLine)) break;
            const flags = program.flags.includes('g') ? 'g' : '';
            const regex = new RegExp(program.regex.source, flags);
            currentLine = currentLine.replace(regex, program.replacement);
            if (program.flags.includes('p')) {
              allOutput.push(currentLine);
              explicitlyPrinted = true;
            }
            break;
          }
          default:
            break;
        }

        if (deleted) break;
        if (shouldQuit) break;
      }

      if (!deleted && !options.quiet && !explicitlyPrinted) {
        allOutput.push(currentLine);
      }

      if (shouldQuit) break;
    }

    if (shouldQuit) break;
  }

  if (allOutput.length > 0) {
    io.stdout.write(`${allOutput.join('\n')}\n`);
  }
  return 0;
}

module.exports = {
  runSed,
};
