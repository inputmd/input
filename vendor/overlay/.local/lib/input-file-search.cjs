'use strict';

const fs = require('node:fs');
const path = require('node:path');
// WebContainer shells do not include fd/find/grep/rg, so the home overlay
// provides small replacements for the subset of behavior this app relies on.
const DEFAULT_IGNORED_NAMES = new Set(['.git', 'node_modules']);

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function normalizeOutputPath(cwd, absolutePath) {
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath ? toPosixPath(relativePath) : '.';
}

function isHiddenName(name) {
  return name.startsWith('.') && name !== '.' && name !== '..';
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') {
      source += '.*';
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    source += escapeRegExp(char);
  }
  source += '$';
  return new RegExp(source);
}

function resolveEntryType(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

function collectEntries(rootPath, options) {
  const rootStats = fs.lstatSync(rootPath);
  const rootEntry = {
    absolutePath: rootPath,
    name: path.basename(rootPath),
    outputPath: normalizeOutputPath(options.cwd, rootPath),
    type: resolveEntryType(rootStats),
  };
  const entries = [];

  if (options.includeRoot) {
    entries.push(rootEntry);
  }

  if (!rootStats.isDirectory()) {
    return entries;
  }

  function walkDirectory(directoryPath) {
    const dirEntries = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of dirEntries) {
      if (!options.includeHidden && isHiddenName(entry.name)) continue;
      if (!options.includeIgnored && DEFAULT_IGNORED_NAMES.has(entry.name)) continue;

      const absolutePath = path.join(directoryPath, entry.name);
      const stats = fs.lstatSync(absolutePath);
      const nextEntry = {
        absolutePath,
        name: entry.name,
        outputPath: normalizeOutputPath(options.cwd, absolutePath),
        type: resolveEntryType(stats),
      };

      entries.push(nextEntry);
      if (stats.isDirectory()) {
        walkDirectory(absolutePath);
      }
    }
  }

  walkDirectory(rootPath);
  return entries;
}

function matchesType(entry, type) {
  if (type == null) return true;
  if (type === 'f') return entry.type === 'file';
  if (type === 'd') return entry.type === 'directory';
  return false;
}

function matchesExtension(entry, extension) {
  if (extension == null) return true;
  if (entry.type !== 'file') return false;
  const entryExtension = path.extname(entry.name).replace(/^\./, '');
  return entryExtension === extension;
}

function parseContentSearchArgs(command, args) {
  const options = {
    debug: false,
    glob: null,
    includeHidden: command === 'grep',
    includeIgnored: command === 'grep',
    ignoreCase: false,
    lineNumbers: false,
    path: '.',
    paths: [],
    pattern: '',
    recursive: true,
    type: null,
  };
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--version') {
      return { version: true };
    }
    if (arg === '--debug') {
      options.debug = true;
      continue;
    }
    if (arg === '-n') {
      options.lineNumbers = true;
      continue;
    }
    if (arg === '-i') {
      options.ignoreCase = true;
      continue;
    }
    if (arg === '-H' || arg === '--hidden') {
      options.includeHidden = true;
      continue;
    }
    if (arg === '-I' || arg === '--no-ignore') {
      options.includeIgnored = true;
      continue;
    }
    if (arg === '-g' || arg === '--glob') {
      const value = args[index + 1];
      if (!value) throw new Error(`${command}: missing value for ${arg}`);
      options.glob = value;
      index += 1;
      continue;
    }
    if (arg === '-t' || arg === '--type') {
      const value = args[index + 1];
      if (!value) throw new Error(`${command}: missing value for ${arg}`);
      options.type = value;
      index += 1;
      continue;
    }
    if (arg === '-r' || arg === '-R') {
      options.recursive = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`${command}: unsupported option ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    throw new Error(`${command}: missing search pattern`);
  }

  options.pattern = positionals[0];
  if (command === 'rg') {
    if (positionals.length > 2) {
      throw new Error('rg: expected a pattern and at most one search path');
    }
    if (positionals.length === 2) {
      options.path = positionals[1];
    }
  } else {
    options.paths = positionals.slice(1);
    if (options.paths.length === 0) {
      options.paths = ['.'];
    }
  }

  return { help: false, options, version: false };
}

function parseFdArgs(args) {
  const options = {
    debug: false,
    extension: null,
    includeHidden: false,
    includeIgnored: false,
    path: '.',
    pattern: '',
    type: null,
  };
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--version') {
      return { version: true };
    }
    if (arg === '--debug') {
      options.debug = true;
      continue;
    }
    if (arg === '-H' || arg === '--hidden') {
      options.includeHidden = true;
      continue;
    }
    if (arg === '-I' || arg === '--no-ignore') {
      options.includeIgnored = true;
      continue;
    }
    if (arg === '-e' || arg === '--extension') {
      const value = args[index + 1];
      if (!value) throw new Error('fd: missing value for -e');
      options.extension = value.replace(/^\./, '');
      index += 1;
      continue;
    }
    if (arg.startsWith('-e') && arg.length > 2) {
      options.extension = arg.slice(2).replace(/^\./, '');
      continue;
    }
    if (arg === '-t' || arg === '--type') {
      const value = args[index + 1];
      if (!value) throw new Error('fd: missing value for -t');
      if (value !== 'f' && value !== 'd') throw new Error(`fd: unsupported type ${value}`);
      options.type = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-t') && arg.length > 2) {
      const value = arg.slice(2);
      if (value !== 'f' && value !== 'd') throw new Error(`fd: unsupported type ${value}`);
      options.type = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`fd: unsupported option ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 2) {
    throw new Error('fd: expected at most a pattern and one search path');
  }
  if (positionals.length >= 1) {
    options.pattern = positionals[0];
  }
  if (positionals.length === 2) {
    options.path = positionals[1];
  }

  return { help: false, options, version: false };
}

function parseFindArgs(args) {
  const options = {
    debug: false,
    name: null,
    paths: [],
    type: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--version') {
      return { version: true };
    }
    if (arg === '--debug') {
      options.debug = true;
      continue;
    }
    if (arg === '-print') {
      continue;
    }
    if (arg === '-name') {
      const value = args[index + 1];
      if (!value) throw new Error('find: missing value for -name');
      options.name = value;
      index += 1;
      continue;
    }
    if (arg === '-type') {
      const value = args[index + 1];
      if (!value) throw new Error('find: missing value for -type');
      if (value !== 'f' && value !== 'd') throw new Error(`find: unsupported type ${value}`);
      options.type = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) {
      options.paths.push(arg);
      continue;
    }
    throw new Error(`find: unsupported option ${arg}`);
  }

  if (options.paths.length === 0) {
    options.paths.push('.');
  }

  return { help: false, options, version: false };
}

function printLines(lines, stdout) {
  if (lines.length === 0) return;
  stdout.write(`${lines.join('\n')}\n`);
}

function printHelp(stdout, command) {
  if (command === 'fd') {
    printLines(
      [
        'usage: fd [options] [pattern] [path]',
        '  --debug',
        '  -e, --extension <ext>',
        '  -t, --type <f|d>',
        '  -H, --hidden',
        '  -I, --no-ignore',
      ],
      stdout,
    );
    return;
  }

  if (command === 'rg') {
    printLines(
      [
        'usage: rg [options] <pattern> [path]',
        '  --debug',
        '  -n',
        '  -i',
        '  -H, --hidden',
        '  -I, --no-ignore',
        '  -g, --glob <glob>',
        '  -t, --type <ext|type>',
      ],
      stdout,
    );
    return;
  }

  if (command === 'grep') {
    printLines(
      [
        'usage: grep [options] <pattern> [path...]',
        '  --debug',
        '  -n',
        '  -i',
        '  -r, -R',
      ],
      stdout,
    );
    return;
  }

  printLines(
    [
      'usage: find [path] [options]',
      '  --debug',
      '  -name <glob>',
      '  -type <f|d>',
    ],
    stdout,
  );
}

function printVersion(stdout, command) {
  stdout.write(`${command} 0.1.0\n`);
}

function summarizeResults(results) {
  const sampleSize = 20;
  return {
    resultCount: results.length,
    resultSample: results.slice(0, sampleSize),
    sampleTruncated: results.length > sampleSize,
  };
}

function debugLog(enabled, stderr, fields) {
  if (!enabled) return;
  stderr.write(`${JSON.stringify(fields)}\n`);
}

function isProbablyBinary(buffer) {
  return buffer.includes(0);
}

function lineMatches(regex, line) {
  regex.lastIndex = 0;
  return regex.test(line);
}

function resolveContentSearchExtensions(type) {
  if (type == null) return null;
  const normalizedType = type.toLowerCase();
  const commonTypes = {
    js: ['js', 'jsx', 'mjs', 'cjs'],
    json: ['json'],
    md: ['md'],
    ts: ['ts', 'tsx'],
  };
  return commonTypes[normalizedType] ?? [normalizedType.replace(/^\./, '')];
}

function collectSearchFiles(searchPath, options) {
  const absolutePath = path.resolve(options.cwd, searchPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`${options.command}: path not found: ${searchPath}`);
  }

  const stats = fs.lstatSync(absolutePath);
  if (stats.isFile()) {
    return [
      {
        absolutePath,
        name: path.basename(absolutePath),
        outputPath: normalizeOutputPath(options.cwd, absolutePath),
        type: 'file',
      },
    ];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  if (!options.recursive) {
    return fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        if (!options.includeHidden && isHiddenName(entry.name)) return [];
        if (!options.includeIgnored && DEFAULT_IGNORED_NAMES.has(entry.name)) return [];
        const childPath = path.join(absolutePath, entry.name);
        const childStats = fs.lstatSync(childPath);
        if (!childStats.isFile()) return [];
        return [
          {
            absolutePath: childPath,
            name: entry.name,
            outputPath: normalizeOutputPath(options.cwd, childPath),
            type: 'file',
          },
        ];
      });
  }

  return collectEntries(absolutePath, {
    cwd: options.cwd,
    includeHidden: options.includeHidden,
    includeIgnored: options.includeIgnored,
    includeRoot: false,
  }).filter((entry) => entry.type === 'file');
}

function runContentSearch(command, args, io) {
  const parsed = parseContentSearchArgs(command, args);
  if (parsed.help) {
    printHelp(io.stdout, command);
    return 0;
  }
  if (parsed.version) {
    printVersion(io.stdout, command);
    return 0;
  }

  const cwd = process.cwd();
  const searchPaths = command === 'rg' ? [parsed.options.path] : parsed.options.paths;
  let pattern;
  try {
    pattern = new RegExp(parsed.options.pattern, parsed.options.ignoreCase ? 'i' : '');
  } catch (err) {
    io.stderr.write(
      `${command}: invalid pattern ${parsed.options.pattern}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const globPattern = parsed.options.glob ? globToRegExp(parsed.options.glob) : null;
  const allowedExtensions = resolveContentSearchExtensions(parsed.options.type);
  const results = [];
  const seenFiles = new Set();
  let discoveredFiles = 0;
  let searchedFiles = 0;

  debugLog(parsed.options.debug, io.stderr, {
    argv: args,
    command,
    cwd,
    glob: parsed.options.glob,
    ignoreCase: parsed.options.ignoreCase,
    includeHidden: parsed.options.includeHidden,
    includeIgnored: parsed.options.includeIgnored,
    lineNumbers: parsed.options.lineNumbers,
    paths: searchPaths,
    pattern: parsed.options.pattern,
    recursive: parsed.options.recursive,
    type: parsed.options.type,
  });

  try {
    for (const searchPath of searchPaths) {
      const files = collectSearchFiles(searchPath, {
        command,
        cwd,
        includeHidden: parsed.options.includeHidden,
        includeIgnored: parsed.options.includeIgnored,
        recursive: parsed.options.recursive,
      });
      discoveredFiles += files.length;
      for (const file of files) {
        if (seenFiles.has(file.outputPath)) continue;
        seenFiles.add(file.outputPath);
        if (globPattern && !globPattern.test(file.outputPath)) continue;
        if (
          Array.isArray(allowedExtensions) &&
          !allowedExtensions.some((extension) => matchesExtension(file, extension))
        ) {
          continue;
        }
        const buffer = fs.readFileSync(file.absolutePath);
        if (isProbablyBinary(buffer)) continue;
        searchedFiles += 1;
        const contents = buffer.toString('utf8');
        const lines = contents.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (!lineMatches(pattern, line)) continue;
          results.push(
            parsed.options.lineNumbers
              ? `${file.outputPath}:${lineIndex + 1}:${line}`
              : `${file.outputPath}:${line}`,
          );
        }
      }
    }
  } catch (err) {
    io.stderr.write(`${command}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  debugLog(parsed.options.debug, io.stderr, {
    command,
    discoveredFiles,
    searchedFiles,
  });
  debugLog(parsed.options.debug, io.stderr, Object.assign({ command }, summarizeResults(results)));
  printLines(results, io.stdout);
  return results.length > 0 ? 0 : 1;
}

function runFd(args, io) {
  const parsed = parseFdArgs(args);
  if (parsed.help) {
    printHelp(io.stdout, 'fd');
    return 0;
  }
  if (parsed.version) {
    printVersion(io.stdout, 'fd');
    return 0;
  }

  const cwd = process.cwd();
  const searchPath = path.resolve(cwd, parsed.options.path);
  debugLog(parsed.options.debug, io.stderr, {
    argv: args,
    command: 'fd',
    cwd,
    includeHidden: parsed.options.includeHidden,
    includeIgnored: parsed.options.includeIgnored,
    pattern: parsed.options.pattern,
    searchPath,
    type: parsed.options.type,
  });
  if (!fs.existsSync(searchPath)) {
    io.stderr.write(`fd: path not found: ${parsed.options.path}\n`);
    return 1;
  }

  let pattern = null;
  if (parsed.options.pattern) {
    try {
      pattern = new RegExp(parsed.options.pattern);
    } catch (err) {
      io.stderr.write(`fd: invalid pattern ${parsed.options.pattern}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  const results = [];
  const entries = collectEntries(searchPath, {
    cwd,
    includeHidden: parsed.options.includeHidden,
    includeIgnored: parsed.options.includeIgnored,
    includeRoot: false,
  });
  debugLog(parsed.options.debug, io.stderr, {
    command: 'fd',
    discoveredEntries: entries.length,
  });

  for (const entry of entries) {
    if (!matchesType(entry, parsed.options.type)) continue;
    if (!matchesExtension(entry, parsed.options.extension)) continue;
    if (pattern && !pattern.test(entry.outputPath)) continue;
    results.push(entry.outputPath);
  }

  results.sort((left, right) => left.localeCompare(right));
  debugLog(parsed.options.debug, io.stderr, Object.assign({ command: 'fd' }, summarizeResults(results)));
  printLines(results, io.stdout);
  return 0;
}

function runFind(args, io) {
  const parsed = parseFindArgs(args);
  if (parsed.help) {
    printHelp(io.stdout, 'find');
    return 0;
  }
  if (parsed.version) {
    printVersion(io.stdout, 'find');
    return 0;
  }

  const cwd = process.cwd();
  const namePattern = parsed.options.name == null ? null : globToRegExp(parsed.options.name);
  const results = [];
  const seen = new Set();
  debugLog(parsed.options.debug, io.stderr, {
    argv: args,
    command: 'find',
    cwd,
    name: parsed.options.name,
    paths: parsed.options.paths,
    type: parsed.options.type,
  });

  for (const searchPath of parsed.options.paths) {
    const absolutePath = path.resolve(cwd, searchPath);
    if (!fs.existsSync(absolutePath)) {
      io.stderr.write(`find: path not found: ${searchPath}\n`);
      return 1;
    }

    const entries = collectEntries(absolutePath, {
      cwd,
      includeHidden: true,
      includeIgnored: true,
      includeRoot: true,
    });
    debugLog(parsed.options.debug, io.stderr, {
      command: 'find',
      discoveredEntries: entries.length,
      searchPath: absolutePath,
    });

    for (const entry of entries) {
      if (!matchesType(entry, parsed.options.type)) continue;
      if (namePattern && !namePattern.test(entry.name)) continue;
      if (seen.has(entry.outputPath)) continue;
      seen.add(entry.outputPath);
      results.push(entry.outputPath);
    }
  }

  results.sort((left, right) => left.localeCompare(right));
  debugLog(parsed.options.debug, io.stderr, Object.assign({ command: 'find' }, summarizeResults(results)));
  printLines(results, io.stdout);
  return 0;
}

module.exports = {
  runFd,
  runFind,
  runGrep: (args, io) => runContentSearch('grep', args, io),
  runRg: (args, io) => runContentSearch('rg', args, io),
};
