'use strict';

function writeError(stderr, message) {
  stderr.write(`printf: ${message}\n`);
}

function decodeEscapeSequence(format, index) {
  const next = format[index + 1];
  if (next == null) {
    return { nextIndex: index + 1, value: '\\' };
  }

  switch (next) {
    case '\\':
      return { nextIndex: index + 2, value: '\\' };
    case 'a':
      return { nextIndex: index + 2, value: '\x07' };
    case 'b':
      return { nextIndex: index + 2, value: '\b' };
    case 'f':
      return { nextIndex: index + 2, value: '\f' };
    case 'n':
      return { nextIndex: index + 2, value: '\n' };
    case 'r':
      return { nextIndex: index + 2, value: '\r' };
    case 't':
      return { nextIndex: index + 2, value: '\t' };
    case 'v':
      return { nextIndex: index + 2, value: '\v' };
    case '0': {
      let cursor = index + 2;
      let octalDigits = '';
      while (cursor < format.length && octalDigits.length < 3) {
        const char = format[cursor];
        if (char < '0' || char > '7') break;
        octalDigits += char;
        cursor += 1;
      }
      const codePoint = octalDigits ? Number.parseInt(octalDigits, 8) : 0;
      return { nextIndex: cursor, value: String.fromCharCode(codePoint) };
    }
    default:
      return { nextIndex: index + 2, value: `\\${next}` };
  }
}

function parseFormatSpecifier(format, index) {
  let cursor = index + 1;
  if (cursor >= format.length) {
    throw new Error('incomplete format specifier');
  }

  const specifierStart = index;
  let width = '';
  while (cursor < format.length && format[cursor] >= '0' && format[cursor] <= '9') {
    width += format[cursor];
    cursor += 1;
  }

  let precision = null;
  if (format[cursor] === '.') {
    cursor += 1;
    let digits = '';
    while (cursor < format.length && format[cursor] >= '0' && format[cursor] <= '9') {
      digits += format[cursor];
      cursor += 1;
    }
    if (digits.length === 0) {
      throw new Error('precision requires digits');
    }
    precision = Number.parseInt(digits, 10);
  }

  const type = format[cursor];
  if (type == null) {
    throw new Error('incomplete format specifier');
  }

  if (width) {
    throw new Error(`unsupported format %${width}${precision == null ? '' : `.${precision}`}${type}`);
  }

  if (!['s', 'd', 'i', 'f'].includes(type)) {
    throw new Error(`unsupported format %${format.slice(specifierStart + 1, cursor + 1)}`);
  }

  if (precision != null && type !== 'f') {
    throw new Error(`unsupported format %${format.slice(specifierStart + 1, cursor + 1)}`);
  }

  return {
    endIndex: cursor + 1,
    kind: 'specifier',
    precision,
    type,
  };
}

function parseFormatString(format) {
  const segments = [];
  let literal = '';

  for (let index = 0; index < format.length; ) {
    const char = format[index];

    if (char === '\\') {
      const decoded = decodeEscapeSequence(format, index);
      literal += decoded.value;
      index = decoded.nextIndex;
      continue;
    }

    if (char !== '%') {
      literal += char;
      index += 1;
      continue;
    }

    if (format[index + 1] === '%') {
      literal += '%';
      index += 2;
      continue;
    }

    if (literal) {
      segments.push({ kind: 'literal', value: literal });
      literal = '';
    }

    const specifier = parseFormatSpecifier(format, index);
    segments.push(specifier);
    index = specifier.endIndex;
  }

  if (literal) {
    segments.push({ kind: 'literal', value: literal });
  }

  return segments;
}

function defaultValueForSpecifier(type) {
  return type === 's' ? '' : '0';
}

function parseNumericValue(rawValue) {
  const normalized = rawValue == null ? '0' : String(rawValue);
  if (normalized.trim() === '') return 0;
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid number: ${normalized}`);
  }
  return value;
}

function formatArgument(segment, rawValue) {
  const value = rawValue == null ? defaultValueForSpecifier(segment.type) : rawValue;

  switch (segment.type) {
    case 's':
      return String(value);
    case 'd':
    case 'i': {
      const numericValue = parseNumericValue(value);
      const truncated = numericValue < 0 ? Math.ceil(numericValue) : Math.floor(numericValue);
      return String(truncated);
    }
    case 'f': {
      const numericValue = parseNumericValue(value);
      if (segment.precision != null) {
        return numericValue.toFixed(segment.precision);
      }
      return String(numericValue);
    }
    default:
      throw new Error(`unsupported format %${segment.type}`);
  }
}

function renderSegments(segments, args) {
  const conversionCount = segments.filter((segment) => segment.kind === 'specifier').length;
  if (conversionCount === 0) {
    return segments.map((segment) => segment.value).join('');
  }

  const iterations = Math.max(1, Math.ceil(args.length / conversionCount));
  let argIndex = 0;
  let output = '';

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const segment of segments) {
      if (segment.kind === 'literal') {
        output += segment.value;
        continue;
      }
      output += formatArgument(segment, args[argIndex]);
      argIndex += 1;
    }
  }

  return output;
}

function runPrintf(args, io) {
  const argv = args[0] === '--' ? args.slice(1) : args.slice();

  if (argv[0] === '-v') {
    writeError(io.stderr, 'unsupported option -v');
    return 1;
  }

  const format = argv[0];
  if (format == null) {
    writeError(io.stderr, 'missing format string');
    return 1;
  }

  let segments;
  try {
    segments = parseFormatString(String(format));
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    io.stdout.write(renderSegments(segments, argv.slice(1)));
    return 0;
  } catch (err) {
    writeError(io.stderr, err instanceof Error ? err.message : String(err));
    return 1;
  }
}

module.exports = {
  runPrintf,
};
