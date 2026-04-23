'use strict';

const fs = require('node:fs');

function writeError(stderr, message) {
  stderr.write(`awk: ${message}\n`);
}

function parseArgs(args) {
  const options = {
    fieldSeparator: null,
    files: [],
    script: null,
  };

  let parsingFlags = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }

    if (parsingFlags && arg === '-F') {
      const separator = args[index + 1];
      if (separator == null) {
        throw new Error('missing separator for -F');
      }
      options.fieldSeparator = separator;
      index += 1;
      continue;
    }

    if (parsingFlags && arg.startsWith('-F') && arg.length > 2) {
      options.fieldSeparator = arg.slice(2);
      continue;
    }

    if (parsingFlags && arg.startsWith('-') && arg !== '-') {
      throw new Error(`unsupported option ${arg}`);
    }

    if (options.script == null) {
      options.script = arg;
      parsingFlags = false;
      continue;
    }

    options.files.push(arg);
  }

  if (options.script == null) {
    throw new Error('missing program');
  }

  return options;
}

function parseQuotedString(source, startIndex) {
  const quote = source[startIndex];
  let output = '';

  for (let index = startIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      if (next == null) {
        throw new Error('unterminated string literal');
      }
      switch (next) {
        case 'n':
          output += '\n';
          break;
        case 'r':
          output += '\r';
          break;
        case 't':
          output += '\t';
          break;
        default:
          output += next;
          break;
      }
      index += 1;
      continue;
    }
    if (char === quote) {
      return {
        nextIndex: index + 1,
        value: output,
      };
    }
    output += char;
  }

  throw new Error('unterminated string literal');
}

function parseRegexPattern(source) {
  if (!source.startsWith('/')) return { pattern: null, rest: source };
  let pattern = '';

  for (let index = 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      if (next == null) {
        throw new Error('unterminated regex pattern');
      }
      pattern += `\\${next}`;
      index += 1;
      continue;
    }
    if (char === '/') {
      return {
        pattern: new RegExp(pattern),
        rest: source.slice(index + 1).trim(),
      };
    }
    pattern += char;
  }

  throw new Error('unterminated regex pattern');
}

function parseNrPattern(source) {
  const match = /^NR\s*(==|!=|>=|<=|>|<)\s*(\d+)\s*(.*)$/s.exec(source);
  if (!match) return { pattern: null, rest: source };

  return {
    pattern: {
      operator: match[1],
      type: 'nr',
      value: Number.parseInt(match[2], 10),
    },
    rest: match[3].trim(),
  };
}

function parseToken(item, index) {
  const char = item[index];

  if (char === '"' || char === "'") {
    const parsed = parseQuotedString(item, index);
    return {
      nextIndex: parsed.nextIndex,
      token: { type: 'string', value: parsed.value },
    };
  }

  if (char === '$') {
    let cursor = index + 1;
    while (cursor < item.length && /\d/.test(item[cursor])) cursor += 1;
    const fieldNumber = item.slice(index + 1, cursor);
    if (fieldNumber === '') {
      throw new Error('unsupported field reference');
    }
    return {
      nextIndex: cursor,
      token: { type: 'field', value: Number.parseInt(fieldNumber, 10) },
    };
  }

  if (/\d/.test(char)) {
    let cursor = index + 1;
    while (cursor < item.length && /\d/.test(item[cursor])) cursor += 1;
    return {
      nextIndex: cursor,
      token: { type: 'number', value: item.slice(index, cursor) },
    };
  }

  const identifierMatch = /^(NR|NF)/.exec(item.slice(index));
  if (identifierMatch) {
    return {
      nextIndex: index + identifierMatch[1].length,
      token: { type: 'identifier', value: identifierMatch[1] },
    };
  }

  throw new Error(`unsupported token near ${item.slice(index)}`);
}

function parsePrintItems(source) {
  const items = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      current += char;
      if (char === '\\') {
        const next = source[index + 1];
        if (next != null) {
          current += next;
          index += 1;
        }
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) items.push(current.trim());
  return items;
}

function parseExpression(item) {
  const tokens = [];
  for (let index = 0; index < item.length; ) {
    if (/\s/.test(item[index])) {
      index += 1;
      continue;
    }
    const parsed = parseToken(item, index);
    tokens.push(parsed.token);
    index = parsed.nextIndex;
  }
  return tokens;
}

function parseProgram(script) {
  let trimmed = script.trim();
  let pattern = null;

  let parsedPattern = parseRegexPattern(trimmed);
  if (parsedPattern.pattern != null) {
    pattern = { type: 'regex', value: parsedPattern.pattern };
    trimmed = parsedPattern.rest;
  } else {
    parsedPattern = parseNrPattern(trimmed);
    if (parsedPattern.pattern != null) {
      pattern = parsedPattern.pattern;
      trimmed = parsedPattern.rest;
    }
  }

  const actionMatch = /^\{([\s\S]*)\}$/.exec(trimmed);
  if (!actionMatch) {
    throw new Error('only brace-delimited print actions are supported');
  }

  const body = actionMatch[1].trim();
  if (!body.startsWith('print')) {
    throw new Error('only print actions are supported');
  }

  const printArguments = body.slice('print'.length).trim();
  const items =
    printArguments === ''
      ? [[{ type: 'field', value: 0 }]]
      : parsePrintItems(printArguments).map((item) => parseExpression(item));

  return {
    items,
    pattern,
  };
}

function splitFields(line, fieldSeparator) {
  if (fieldSeparator == null) {
    const trimmed = line.trim();
    return trimmed === '' ? [] : trimmed.split(/\s+/);
  }
  return line.split(fieldSeparator);
}

function matchesPattern(pattern, line, recordNumber) {
  if (pattern == null) return true;
  if (pattern.type === 'regex') return pattern.value.test(line);
  if (pattern.type === 'nr') {
    switch (pattern.operator) {
      case '==':
        return recordNumber === pattern.value;
      case '!=':
        return recordNumber !== pattern.value;
      case '>':
        return recordNumber > pattern.value;
      case '>=':
        return recordNumber >= pattern.value;
      case '<':
        return recordNumber < pattern.value;
      case '<=':
        return recordNumber <= pattern.value;
      default:
        return false;
    }
  }
  return false;
}

function evaluateToken(token, context) {
  switch (token.type) {
    case 'string':
      return token.value;
    case 'number':
      return token.value;
    case 'field':
      if (token.value === 0) return context.line;
      return context.fields[token.value - 1] ?? '';
    case 'identifier':
      if (token.value === 'NR') return String(context.recordNumber);
      if (token.value === 'NF') return String(context.fields.length);
      return '';
    default:
      return '';
  }
}

function readText(filePath) {
  if (!filePath || filePath === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function runAwk(args, io) {
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  let program;
  try {
    program = parseProgram(options.script);
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  const targets = options.files.length === 0 ? [null] : options.files;
  const output = [];
  let recordNumber = 0;

  for (const target of targets) {
    let text;
    try {
      text = readText(target);
    } catch (err) {
      writeError(io.stderr, `${target ?? 'stdin'}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    for (const line of splitLines(text)) {
      recordNumber += 1;
      if (!matchesPattern(program.pattern, line, recordNumber)) continue;

      const context = {
        fields: splitFields(line, options.fieldSeparator),
        line,
        recordNumber,
      };

      const renderedItems = program.items.map((item) =>
        item.map((token) => evaluateToken(token, context)).join(''),
      );
      output.push(renderedItems.join(' '));
    }
  }

  if (output.length > 0) {
    io.stdout.write(`${output.join('\n')}\n`);
  }
  return 0;
}

module.exports = {
  runAwk,
};
