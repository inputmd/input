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

function globToRegExp(pattern, options) {
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
  return new RegExp(source, options && options.ignoreCase ? 'i' : '');
}

function resolveEntryType(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

function readOptionValue(command, args, index, arg) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${command}: missing value for ${arg}`);
  }
  return value;
}

function parseLongOptionWithValue(arg, name) {
  const prefix = `${name}=`;
  if (!arg.startsWith(prefix)) return null;
  return arg.slice(prefix.length);
}

function resolveEntryStats(absolutePath, options) {
  const lstats = fs.lstatSync(absolutePath);
  if (!options.followSymlinks || !lstats.isSymbolicLink()) {
    return lstats;
  }
  try {
    return fs.statSync(absolutePath);
  } catch {
    return null;
  }
}

function createEntry(cwd, absolutePath, stats) {
  return {
    absolutePath,
    name: path.basename(absolutePath),
    outputPath: normalizeOutputPath(cwd, absolutePath),
    type: resolveEntryType(stats),
  };
}

function collectEntries(rootPath, options) {
  const rootStats = resolveEntryStats(rootPath, options);
  if (rootStats == null) {
    return [];
  }
  const rootEntry = createEntry(options.cwd, rootPath, rootStats);
  const entries = [];
  const seenDirectories = new Set();

  if (options.includeRoot) {
    entries.push(rootEntry);
  }

  if (!rootStats.isDirectory()) {
    return entries;
  }

  if (options.followSymlinks) {
    try {
      seenDirectories.add(fs.realpathSync(rootPath));
    } catch {
      // Ignore realpath failures and still attempt to walk the root path.
    }
  }

  function walkDirectory(directoryPath, depth) {
    const dirEntries = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of dirEntries) {
      if (!options.includeHidden && isHiddenName(entry.name)) continue;
      if (!options.includeIgnored && DEFAULT_IGNORED_NAMES.has(entry.name)) continue;

      const absolutePath = path.join(directoryPath, entry.name);
      const stats = resolveEntryStats(absolutePath, options);
      if (stats == null) continue;

      const nextDepth = depth + 1;
      if (options.maxDepth != null && nextDepth > options.maxDepth) continue;

      const nextEntry = createEntry(options.cwd, absolutePath, stats);
      entries.push(nextEntry);

      if (!stats.isDirectory()) continue;

      if (options.followSymlinks) {
        let realPath;
        try {
          realPath = fs.realpathSync(absolutePath);
        } catch {
          continue;
        }
        if (seenDirectories.has(realPath)) continue;
        seenDirectories.add(realPath);
      }

      if (options.maxDepth == null || nextDepth < options.maxDepth) {
        walkDirectory(absolutePath, nextDepth);
      }
    }
  }

  walkDirectory(rootPath, 0);
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
    filesOnly: false,
    fixedStrings: false,
    followSymlinks: false,
    globs: [],
    includeHidden: command === 'grep',
    includeIgnored: command === 'grep',
    ignoreCase: false,
    lineNumbers: false,
    maxDepth: null,
    outputMode: 'text',
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
    if (arg === '-n' || arg === '--line-number') {
      options.lineNumbers = true;
      continue;
    }
    if (arg === '-i' || arg === '--ignore-case') {
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

    const globValue = parseLongOptionWithValue(arg, '--glob');
    if (arg === '-g' || arg === '--glob' || globValue != null) {
      const value = globValue ?? readOptionValue(command, args, index, arg);
      options.globs.push({ ignoreCase: false, pattern: value });
      if (globValue == null) {
        index += 1;
      }
      continue;
    }

    const iGlobValue = parseLongOptionWithValue(arg, '--iglob');
    if (arg === '--iglob' || iGlobValue != null) {
      const value = iGlobValue ?? readOptionValue(command, args, index, arg);
      options.globs.push({ ignoreCase: true, pattern: value });
      if (iGlobValue == null) {
        index += 1;
      }
      continue;
    }

    const colorValue = parseLongOptionWithValue(arg, '--color');
    if (arg === '--color' || colorValue != null) {
      const value = colorValue ?? readOptionValue(command, args, index, arg);
      if (value !== 'never') {
        throw new Error(`${command}: unsupported color mode ${value}`);
      }
      if (colorValue == null) {
        index += 1;
      }
      continue;
    }

    const maxDepthValue = parseLongOptionWithValue(arg, '--max-depth');
    if (arg === '--max-depth' || maxDepthValue != null) {
      const value = maxDepthValue ?? readOptionValue(command, args, index, arg);
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isInteger(parsedValue) || parsedValue < 0) {
        throw new Error(`${command}: invalid value for --max-depth: ${value}`);
      }
      options.maxDepth = parsedValue;
      if (maxDepthValue == null) {
        index += 1;
      }
      continue;
    }

    const typeValue = parseLongOptionWithValue(arg, '--type');
    if (arg === '-t' || arg === '--type' || typeValue != null) {
      const value = typeValue ?? readOptionValue(command, args, index, arg);
      options.type = value;
      if (typeValue == null) {
        index += 1;
      }
      continue;
    }

    if (arg === '--files') {
      options.filesOnly = true;
      continue;
    }
    if (arg === '--follow') {
      options.followSymlinks = true;
      continue;
    }
    if (arg === '--json') {
      options.outputMode = 'json';
      continue;
    }
    if (arg === '--fixed-strings' || arg === '-F') {
      options.fixedStrings = true;
      continue;
    }
    if (arg === '-j' || arg === '--threads') {
      index += 1;
      if (!args[index]) throw new Error(`${command}: missing value for ${arg}`);
      continue;
    }
    if (arg.startsWith('-j') && arg.length > 2) {
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

  if (positionals.length === 0 && !options.filesOnly) {
    throw new Error(`${command}: missing search pattern`);
  }

  if (command === 'rg') {
    if (options.filesOnly) {
      if (positionals.length > 1) {
        throw new Error('rg: expected at most one search path with --files');
      }
      if (positionals.length === 1) {
        options.path = positionals[0];
      }
    } else {
      options.pattern = positionals[0];
      if (positionals.length > 2) {
        throw new Error('rg: expected a pattern and at most one search path');
      }
      if (positionals.length === 2) {
        options.path = positionals[1];
      }
    }
  } else {
    options.pattern = positionals[0];
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
      const value = readOptionValue('fd', args, index, arg);
      options.extension = value.replace(/^\./, '');
      index += 1;
      continue;
    }
    if (arg.startsWith('-e') && arg.length > 2) {
      options.extension = arg.slice(2).replace(/^\./, '');
      continue;
    }
    if (arg === '-t' || arg === '--type') {
      const value = readOptionValue('fd', args, index, arg);
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
      const value = readOptionValue('find', args, index, arg);
      options.name = value;
      index += 1;
      continue;
    }
    if (arg === '-type') {
      const value = readOptionValue('find', args, index, arg);
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
        'usage: rg --files [options] [path]',
        '  --debug',
        '  -n, --line-number',
        '  -i, --ignore-case',
        '  -F, --fixed-strings',
        '  -H, --hidden',
        '  -I, --no-ignore',
        '  -g, --glob <glob>',
        '  --iglob <glob>',
        '  -t, --type <ext|type>',
        '  --files',
        '  --follow',
        '  --json',
        '  --max-depth <n>',
        '  --color=never',
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

function compileGlobMatchers(globs) {
  return globs.map((glob) => {
    const exclude = glob.pattern.startsWith('!');
    const pattern = exclude ? glob.pattern.slice(1) : glob.pattern;
    return {
      exclude,
      pattern,
      regex: globToRegExp(pattern, { ignoreCase: glob.ignoreCase }),
    };
  });
}

function matchesGlobMatchers(outputPath, matchers) {
  if (matchers.length === 0) return true;

  let matchedInclude = false;
  let hasInclude = false;
  for (const matcher of matchers) {
    if (!matcher.exclude) {
      hasInclude = true;
    }
    if (!matcher.regex.test(outputPath)) {
      continue;
    }
    if (matcher.exclude) {
      return false;
    }
    matchedInclude = true;
  }

  return hasInclude ? matchedInclude : true;
}

function buildSearchPattern(parsedOptions) {
  if (parsedOptions.fixedStrings) {
    return new RegExp(escapeRegExp(parsedOptions.pattern), parsedOptions.ignoreCase ? 'i' : '');
  }
  return new RegExp(parsedOptions.pattern, parsedOptions.ignoreCase ? 'i' : '');
}

function collectSearchFiles(searchPath, options) {
  const absolutePath = path.resolve(options.cwd, searchPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`${options.command}: path not found: ${searchPath}`);
  }

  const stats = resolveEntryStats(absolutePath, options);
  if (stats == null) {
    return [];
  }
  if (stats.isFile()) {
    return [createEntry(options.cwd, absolutePath, stats)];
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
        const childStats = resolveEntryStats(childPath, options);
        if (childStats == null || !childStats.isFile()) return [];
        return [createEntry(options.cwd, childPath, childStats)];
      });
  }

  return collectEntries(absolutePath, {
    cwd: options.cwd,
    followSymlinks: options.followSymlinks,
    includeHidden: options.includeHidden,
    includeIgnored: options.includeIgnored,
    includeRoot: false,
    maxDepth: options.maxDepth,
  }).filter((entry) => entry.type === 'file');
}

function collectFilteredSearchFiles(searchPaths, options) {
  const matchers = compileGlobMatchers(options.globs);
  const allowedExtensions = resolveContentSearchExtensions(options.type);
  const files = [];
  const seenFiles = new Set();
  let discoveredFiles = 0;

  for (const searchPath of searchPaths) {
    const nextFiles = collectSearchFiles(searchPath, options);
    discoveredFiles += nextFiles.length;
    for (const file of nextFiles) {
      if (seenFiles.has(file.outputPath)) continue;
      seenFiles.add(file.outputPath);
      if (!matchesGlobMatchers(file.outputPath, matchers)) continue;
      if (
        Array.isArray(allowedExtensions) &&
        !allowedExtensions.some((extension) => matchesExtension(file, extension))
      ) {
        continue;
      }
      files.push(file);
    }
  }

  files.sort((left, right) => left.outputPath.localeCompare(right.outputPath));
  return {
    discoveredFiles,
    files,
  };
}

function formatJsonMatch(filePath, lineNumber, line) {
  return JSON.stringify({
    data: {
      line_number: lineNumber,
      lines: { text: `${line}\n` },
      path: { text: filePath },
      submatches: [],
    },
    type: 'match',
  });
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

  debugLog(parsed.options.debug, io.stderr, {
    argv: args,
    command,
    cwd,
    filesOnly: parsed.options.filesOnly,
    fixedStrings: parsed.options.fixedStrings,
    followSymlinks: parsed.options.followSymlinks,
    globs: parsed.options.globs,
    ignoreCase: parsed.options.ignoreCase,
    includeHidden: parsed.options.includeHidden,
    includeIgnored: parsed.options.includeIgnored,
    lineNumbers: parsed.options.lineNumbers,
    maxDepth: parsed.options.maxDepth,
    outputMode: parsed.options.outputMode,
    paths: searchPaths,
    pattern: parsed.options.pattern,
    recursive: parsed.options.recursive,
    type: parsed.options.type,
  });

  try {
    const fileInfo = collectFilteredSearchFiles(searchPaths, {
      command,
      cwd,
      followSymlinks: parsed.options.followSymlinks,
      globs: parsed.options.globs,
      includeHidden: parsed.options.includeHidden,
      includeIgnored: parsed.options.includeIgnored,
      maxDepth: parsed.options.maxDepth,
      recursive: parsed.options.recursive,
      type: parsed.options.type,
    });

    if (parsed.options.filesOnly) {
      const output = fileInfo.files.map((file) => file.outputPath);
      debugLog(parsed.options.debug, io.stderr, {
        command,
        discoveredFiles: fileInfo.discoveredFiles,
        listedFiles: output.length,
      });
      debugLog(parsed.options.debug, io.stderr, Object.assign({ command }, summarizeResults(output)));
      printLines(output, io.stdout);
      return 0;
    }

    let pattern;
    try {
      pattern = buildSearchPattern(parsed.options);
    } catch (err) {
      io.stderr.write(
        `${command}: invalid pattern ${parsed.options.pattern}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }

    const results = [];
    let searchedFiles = 0;

    for (const file of fileInfo.files) {
      const buffer = fs.readFileSync(file.absolutePath);
      if (isProbablyBinary(buffer)) continue;
      searchedFiles += 1;
      const contents = buffer.toString('utf8');
      const lines = contents.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (!lineMatches(pattern, line)) continue;
        if (parsed.options.outputMode === 'json') {
          results.push(formatJsonMatch(file.outputPath, lineIndex + 1, line));
          continue;
        }
        results.push(
          parsed.options.lineNumbers
            ? `${file.outputPath}:${lineIndex + 1}:${line}`
            : `${file.outputPath}:${line}`,
        );
      }
    }

    debugLog(parsed.options.debug, io.stderr, {
      command,
      discoveredFiles: fileInfo.discoveredFiles,
      searchedFiles,
    });
    debugLog(parsed.options.debug, io.stderr, Object.assign({ command }, summarizeResults(results)));
    printLines(results, io.stdout);
    return results.length > 0 ? 0 : 1;
  } catch (err) {
    io.stderr.write(`${command}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
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
      io.stderr.write(
        `fd: invalid pattern ${parsed.options.pattern}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  const results = [];
  const entries = collectEntries(searchPath, {
    cwd,
    followSymlinks: false,
    includeHidden: parsed.options.includeHidden,
    includeIgnored: parsed.options.includeIgnored,
    includeRoot: false,
    maxDepth: null,
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
      followSymlinks: false,
      includeHidden: true,
      includeIgnored: true,
      includeRoot: true,
      maxDepth: null,
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
