export const TERMINAL_HISTORY_STORAGE_KEY_PREFIX = 'terminal_jsh_history_v1:';
export const TERMINAL_HISTORY_SYNC_SCRIPT_FILENAME = '.input-jsh-history-sync.cjs';
export const TERMINAL_HISTORY_SEED_FILENAME = '.input-jsh-history-seed.json';

const TERMINAL_HISTORY_MAX_BYTES = 128 * 1024;

interface PersistedTerminalHistorySnapshot {
  version: 1;
  workspaceKey: string;
  content: string;
  updatedAt: number;
}

function terminalHistoryStorageKey(workspaceKey: string): string | null {
  const key = workspaceKey.trim();
  if (!key || key === 'workspace:none') return null;
  return `${TERMINAL_HISTORY_STORAGE_KEY_PREFIX}${key}`;
}

function trimTerminalHistoryContent(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  const encoder = new TextEncoder();
  if (encoder.encode(normalized).length <= TERMINAL_HISTORY_MAX_BYTES) return normalized;

  const lines = normalized.split('\n');
  while (lines.length > 1) {
    lines.shift();
    const trimmed = lines.join('\n');
    if (encoder.encode(trimmed).length <= TERMINAL_HISTORY_MAX_BYTES) {
      return trimmed;
    }
  }

  const singleLine = lines[0] ?? '';
  return singleLine.slice(-Math.floor(TERMINAL_HISTORY_MAX_BYTES / 2));
}

export function loadPersistedTerminalHistory(workspaceKey: string): string {
  if (typeof window === 'undefined') return '';
  const storageKey = terminalHistoryStorageKey(workspaceKey);
  if (!storageKey) return '';

  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return '';
    const parsed = JSON.parse(raw) as PersistedTerminalHistorySnapshot | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.content !== 'string') return '';
    return trimTerminalHistoryContent(parsed.content);
  } catch {
    return '';
  }
}

export function persistTerminalHistory(workspaceKey: string, content: string): void {
  if (typeof window === 'undefined') return;
  const storageKey = terminalHistoryStorageKey(workspaceKey);
  if (!storageKey) return;

  const normalized = trimTerminalHistoryContent(content);
  const snapshot: PersistedTerminalHistorySnapshot = {
    version: 1,
    workspaceKey: workspaceKey.trim(),
    content: normalized,
    updatedAt: Date.now(),
  };

  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures and fall back to in-memory terminal state.
  }
}

export function buildPersistedTerminalHistorySeed(content: string): string {
  return JSON.stringify({ content: trimTerminalHistoryContent(content) });
}

export function buildTerminalHistorySyncScript(seedPath: string): string {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const mode = process.argv[2] || '';",
    `const seedPath = ${JSON.stringify(seedPath)};`,
    "const home = process.env.HOME || '';",
    "if (!home) throw new Error('HOME is not set');",
    "const historyPath = path.join(home, '.jsh_history');",
    'function readSeedContent() {',
    '  try {',
    "    const raw = fs.readFileSync(seedPath, 'utf8');",
    '    const parsed = JSON.parse(raw);',
    "    return typeof parsed?.content === 'string' ? parsed.content : '';",
    '  } catch {',
    "    return '';",
    '  }',
    '}',
    'function readHistoryContent() {',
    '  try {',
    "    return fs.readFileSync(historyPath, 'utf8');",
    '  } catch {',
    "    return '';",
    '  }',
    '}',
    'function ensureHistoryFile(content) {',
    '  fs.mkdirSync(path.dirname(historyPath), { recursive: true });',
    "  fs.writeFileSync(historyPath, content, 'utf8');",
    '}',
    'function emit(content) {',
    "  process.stdout.write(JSON.stringify({ type: 'history', content }) + '\\n');",
    '}',
    "if (mode === 'restore') {",
    '  ensureHistoryFile(readSeedContent());',
    '  process.exit(0);',
    "} else if (mode === 'read') {",
    '  emit(readHistoryContent());',
    '  process.exit(0);',
    "} else if (mode === 'watch') {",
    '  ensureHistoryFile(readHistoryContent());',
    '  let lastContent = null;',
    '  const emitIfChanged = () => {',
    '    const nextContent = readHistoryContent();',
    '    if (nextContent === lastContent) return;',
    '    lastContent = nextContent;',
    '    emit(nextContent);',
    '  };',
    '  emitIfChanged();',
    '  fs.watchFile(historyPath, { interval: 500 }, emitIfChanged);',
    '  const shutdown = () => {',
    '    try {',
    '      emitIfChanged();',
    '    } catch {}',
    '    fs.unwatchFile(historyPath, emitIfChanged);',
    '    process.exit(0);',
    '  };',
    "  process.on('SIGINT', shutdown);",
    "  process.on('SIGTERM', shutdown);",
    "  process.on('exit', () => fs.unwatchFile(historyPath, emitIfChanged));",
    '} else {',
    "  throw new Error('Unknown terminal history mode: ' + mode);",
    '}',
  ].join(' ');
}
