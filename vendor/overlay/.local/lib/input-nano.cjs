const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ALT_SCREEN_ENABLE = '\x1b[?1049h';
const ALT_SCREEN_DISABLE = '\x1b[?1049l';
const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';
const CLEAR_LINE = '\x1b[2K';
const COLOR_DIM = '\x1b[90m';
const COLOR_INVERT = '\x1b[7m';
const COLOR_RESET = '\x1b[0m';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const TAB_STOP = 4;
const DEFAULT_STATUS_TTL_MS = 2500;
const DEFAULT_NEWLINE = '\n';
const RESERVED_BOTTOM_ROWS = 1;
const GRAPHEME_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function iterateGraphemes(value) {
  if (GRAPHEME_SEGMENTER) {
    return Array.from(GRAPHEME_SEGMENTER.segment(value), (entry) => ({
      text: entry.segment,
      start: entry.index,
      end: entry.index + entry.segment.length,
    }));
  }

  const segments = [];
  let offset = 0;
  for (const char of value) {
    segments.push({
      text: char,
      start: offset,
      end: offset + char.length,
    });
    offset += char.length;
  }
  return segments;
}

function detectNewline(value) {
  const match = /\r?\n/.exec(value);
  return match?.[0] ?? DEFAULT_NEWLINE;
}

function formatErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isPrintableInput(str, key) {
  if (!str || key?.ctrl || key?.meta) return false;
  return !/[\x00-\x1f\x7f]/.test(str);
}

function isZeroWidthCodePoint(codePoint) {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    codePoint === 0x180b ||
    codePoint === 0x180c ||
    codePoint === 0x180d ||
    codePoint === 0x180e ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x206f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    codePoint === 0xfff9 ||
    codePoint === 0xfffa ||
    codePoint === 0xfffb ||
    (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function graphemeDisplayWidth(text, column) {
  if (text === '\t') {
    return TAB_STOP - (column % TAB_STOP || 0);
  }

  let width = 0;
  let sawVisibleCodePoint = false;

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (typeof codePoint !== 'number') continue;
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (isZeroWidthCodePoint(codePoint)) continue;
    if (/^\p{Mark}$/u.test(char)) continue;
    sawVisibleCodePoint = true;
    width = Math.max(width, isWideCodePoint(codePoint) ? 2 : 1);
  }

  if (!sawVisibleCodePoint) {
    return /^\p{Mark}+$/u.test(text) ? 0 : 1;
  }
  return Math.max(width, 1);
}

function measureDisplayText(value, options = {}) {
  const { expandTabs = false, startingColumn = 0 } = options;
  const segments = [];
  const charToColumn = new Array(value.length + 1).fill(startingColumn);
  let column = startingColumn;

  for (const segment of iterateGraphemes(value)) {
    const columnStart = column;
    const width = graphemeDisplayWidth(segment.text, columnStart);
    const displayText = expandTabs && segment.text === '\t' ? ' '.repeat(width) : segment.text;

    for (let index = segment.start; index < segment.end; index += 1) {
      charToColumn[index] = columnStart;
    }

    column += width;
    charToColumn[segment.end] = column;
    segments.push({
      columnEnd: column,
      columnStart,
      displayText,
      end: segment.end,
      text: segment.text,
      start: segment.start,
      width,
    });
  }

  return {
    charToColumn,
    columnCount: column,
    segments,
  };
}

function padOrTrim(value, width) {
  if (width <= 0) return '';

  const measured = measureDisplayText(value);
  if (measured.columnCount === width) return value;
  if (measured.columnCount < width) {
    return `${value}${' '.repeat(width - measured.columnCount)}`;
  }

  if (width === 1) return '~';

  let result = '';
  let columns = 0;
  for (const segment of measured.segments) {
    if (columns + segment.width > width - 1) break;
    result += segment.displayText;
    columns += segment.width;
  }
  return `${result}${' '.repeat(Math.max(0, width - 1 - columns))}~`;
}

function previousCursorIndex(value, index) {
  if (index <= 0) return 0;

  let previousBoundary = 0;
  for (const segment of iterateGraphemes(value)) {
    if (segment.end >= index) return segment.start;
    previousBoundary = segment.end;
  }

  return previousBoundary;
}

function nextCursorIndex(value, index) {
  if (index >= value.length) return value.length;

  for (const segment of iterateGraphemes(value)) {
    if (segment.end > index) return segment.end;
  }

  return value.length;
}

function charIndexForColumn(value, targetColumn) {
  const measured = measureDisplayText(value);
  for (const segment of measured.segments) {
    if (targetColumn <= segment.columnStart) return segment.start;
    if (targetColumn < segment.columnEnd) {
      const midpoint = segment.columnStart + Math.ceil(segment.width / 2);
      return targetColumn < midpoint ? segment.start : segment.end;
    }
  }
  return value.length;
}

function sliceDisplayText(value, startColumn, width, options = {}) {
  if (width <= 0) return '';

  const measured = measureDisplayText(value, options);
  const endColumn = startColumn + width;
  let result = '';

  for (const segment of measured.segments) {
    if (segment.columnEnd <= startColumn || segment.columnStart >= endColumn) continue;

    const visibleStart = Math.max(startColumn, segment.columnStart);
    const visibleEnd = Math.min(endColumn, segment.columnEnd);

    if (visibleStart === segment.columnStart && visibleEnd === segment.columnEnd) {
      result += segment.displayText;
      continue;
    }

    result += ' '.repeat(visibleEnd - visibleStart);
  }

  return result;
}

function buildHelpLines(programName) {
  return [
    `${programName} [file]`,
    '',
    'Controls:',
    '  Ctrl-O / Ctrl-S        Save',
    '  Ctrl-X / Ctrl-Q        Exit',
    '  Ctrl-W                 Search',
    '  Ctrl-K / Ctrl-U        Kill / yank',
    '  Ctrl-A / Ctrl-E        Start / end of line',
    '  Ctrl-B / Ctrl-F        Left / right',
    '  Ctrl-P / Ctrl-N        Up / down',
    '  PgUp / Ctrl-Y / Ctrl-V  Page up / page down',
    '  Ctrl-G                 Help',
    '',
  ];
}

class Editor {
  constructor(programName, rawFilePath) {
    this.programName = programName || 'nano';
    this.filePath = rawFilePath ? path.resolve(process.cwd(), rawFilePath) : null;
    this.lines = [''];
    this.newline = DEFAULT_NEWLINE;
    this.cursorX = 0;
    this.cursorY = 0;
    this.rowOffset = 0;
    this.columnOffset = 0;
    this.desiredColumn = null;
    this.dirty = false;
    this.pendingQuitConfirm = false;
    this.prompt = null;
    this.lastSearch = '';
    this.killBuffer = '';
    this.lastCommandWasKill = false;
    this.inBracketedPaste = false;
    this.statusMessage = 'Ctrl-O Save  Ctrl-X Exit  Ctrl-W Search';
    this.statusExpiresAt = 0;
    this.boundHandleKeypress = (str, key) => {
      this.handleKeypress(str, key);
    };
    this.boundHandleResize = () => {
      this.refreshScreen();
    };
    this.cleanedUp = false;
    this.loadFile();
  }

  loadFile() {
    if (this.filePath === null) {
      this.setStatus('New buffer');
      return;
    }

    try {
      const contents = fs.readFileSync(this.filePath, 'utf8');
      this.lines = contents.split(/\r?\n/);
      if (this.lines.length === 0) this.lines = [''];
      this.newline = detectNewline(contents);
      this.setStatus(`Opened ${path.basename(this.filePath)}`);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        this.lines = [''];
        this.setStatus(`New file: ${path.basename(this.filePath)}`);
        return;
      }
      this.lines = [''];
      this.setStatus(`Open failed: ${formatErrorMessage(error)}`, 5000);
    }
  }

  currentLine() {
    return this.lines[this.cursorY] ?? '';
  }

  lineNumberWidth() {
    return String(Math.max(1, this.lines.length)).length;
  }

  editorRows() {
    return Math.max(1, (process.stdout.rows || 24) - 2 - RESERVED_BOTTOM_ROWS);
  }

  editorColumns() {
    return Math.max(1, (process.stdout.columns || 80) - this.lineNumberWidth() - 1);
  }

  currentColumn() {
    const measured = measureDisplayText(this.currentLine(), { expandTabs: true });
    return measured.charToColumn[this.cursorX] ?? measured.columnCount;
  }

  setStatus(message, ttlMs = DEFAULT_STATUS_TTL_MS) {
    this.statusMessage = message;
    this.statusExpiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
  }

  activeMessage() {
    if (this.prompt) {
      return `${this.prompt.label}${this.prompt.value}`;
    }
    if (this.statusExpiresAt === 0 || Date.now() <= this.statusExpiresAt) {
      return this.statusMessage;
    }
    return 'Ctrl-O Save  Ctrl-X Exit  Ctrl-W Search';
  }

  showHelpStatus() {
    this.lastCommandWasKill = false;
    this.setStatus(buildHelpLines(this.programName).join('  '), 6000);
  }

  saveFile(targetPath = null) {
    const nextPath = targetPath ?? this.filePath;
    if (!nextPath) {
      this.openPrompt('Write file: ', '', (inputValue) => {
        if (!inputValue.trim()) {
          this.setStatus('Save cancelled');
          return;
        }
        this.saveFile(path.resolve(process.cwd(), inputValue.trim()));
      });
      return;
    }

    try {
      fs.mkdirSync(path.dirname(nextPath), { recursive: true });
      fs.writeFileSync(nextPath, this.lines.join(this.newline), 'utf8');
      this.filePath = nextPath;
      this.dirty = false;
      this.pendingQuitConfirm = false;
      this.setStatus(`Wrote ${path.relative(process.cwd(), nextPath) || path.basename(nextPath)}`, 3000);
    } catch (error) {
      this.setStatus(`Write failed: ${formatErrorMessage(error)}`, 5000);
    }
  }

  search(query) {
    if (!query) {
      this.setStatus('Search cancelled');
      return;
    }

    this.lastSearch = query;
    const startingRow = this.cursorY;
    const startingColumn = nextCursorIndex(this.currentLine(), this.cursorX);

    for (let pass = 0; pass < 2; pass += 1) {
      const rowStart = pass === 0 ? startingRow : 0;
      const rowEnd = pass === 0 ? this.lines.length : startingRow + 1;

      for (let row = rowStart; row < rowEnd; row += 1) {
        const line = this.lines[row];
        const fromIndex = row === startingRow && pass === 0 ? startingColumn : 0;
        const matchIndex = line.indexOf(query, fromIndex);
        if (matchIndex === -1) continue;

        this.cursorY = row;
        this.cursorX = matchIndex;
        this.desiredColumn = null;
        this.pendingQuitConfirm = false;
        this.setStatus(`Found "${query}"`, 2000);
        return;
      }
    }

    this.setStatus(`No match for "${query}"`, 2500);
  }

  moveCursor(name) {
    this.lastCommandWasKill = false;
    const line = this.currentLine();
    if (name === 'left') {
      if (this.cursorX > 0) {
        this.cursorX = previousCursorIndex(line, this.cursorX);
      } else if (this.cursorY > 0) {
        this.cursorY -= 1;
        this.cursorX = this.lines[this.cursorY].length;
      }
      this.desiredColumn = null;
      return;
    }

    if (name === 'right') {
      if (this.cursorX < line.length) {
        this.cursorX = nextCursorIndex(line, this.cursorX);
      } else if (this.cursorY < this.lines.length - 1) {
        this.cursorY += 1;
        this.cursorX = 0;
      }
      this.desiredColumn = null;
      return;
    }

    const currentColumn = this.desiredColumn ?? this.currentColumn();
    this.desiredColumn = currentColumn;

    if (name === 'up') {
      if (this.cursorY > 0) this.cursorY -= 1;
      this.cursorX = charIndexForColumn(this.currentLine(), currentColumn);
      return;
    }

    if (name === 'down') {
      if (this.cursorY < this.lines.length - 1) this.cursorY += 1;
      this.cursorX = charIndexForColumn(this.currentLine(), currentColumn);
      return;
    }

    if (name === 'home') {
      this.cursorX = 0;
      this.desiredColumn = null;
      return;
    }

    if (name === 'end') {
      this.cursorX = this.currentLine().length;
      this.desiredColumn = null;
      return;
    }

    if (name === 'pageup') {
      this.cursorY = Math.max(0, this.cursorY - this.editorRows());
      this.cursorX = charIndexForColumn(this.currentLine(), currentColumn);
      return;
    }

    if (name === 'pagedown') {
      this.cursorY = Math.min(this.lines.length - 1, this.cursorY + this.editorRows());
      this.cursorX = charIndexForColumn(this.currentLine(), currentColumn);
    }
  }

  insertText(text) {
    this.lastCommandWasKill = false;
    const line = this.currentLine();
    this.lines[this.cursorY] = `${line.slice(0, this.cursorX)}${text}${line.slice(this.cursorX)}`;
    this.cursorX += text.length;
    this.dirty = true;
    this.pendingQuitConfirm = false;
    this.desiredColumn = null;
  }

  insertNewline() {
    this.lastCommandWasKill = false;
    const line = this.currentLine();
    const before = line.slice(0, this.cursorX);
    const after = line.slice(this.cursorX);
    this.lines[this.cursorY] = before;
    this.lines.splice(this.cursorY + 1, 0, after);
    this.cursorY += 1;
    this.cursorX = 0;
    this.dirty = true;
    this.pendingQuitConfirm = false;
    this.desiredColumn = null;
  }

  backspace() {
    this.lastCommandWasKill = false;
    if (this.cursorX > 0) {
      const line = this.currentLine();
      const previousIndex = previousCursorIndex(line, this.cursorX);
      this.lines[this.cursorY] = `${line.slice(0, previousIndex)}${line.slice(this.cursorX)}`;
      this.cursorX = previousIndex;
    } else if (this.cursorY > 0) {
      const previous = this.lines[this.cursorY - 1];
      const current = this.currentLine();
      this.cursorX = previous.length;
      this.lines[this.cursorY - 1] = `${previous}${current}`;
      this.lines.splice(this.cursorY, 1);
      this.cursorY -= 1;
    } else {
      return;
    }

    this.dirty = true;
    this.pendingQuitConfirm = false;
    this.desiredColumn = null;
  }

  deleteForward() {
    this.lastCommandWasKill = false;
    const line = this.currentLine();
    if (this.cursorX < line.length) {
      const nextIndex = nextCursorIndex(line, this.cursorX);
      this.lines[this.cursorY] = `${line.slice(0, this.cursorX)}${line.slice(nextIndex)}`;
    } else if (this.cursorY < this.lines.length - 1) {
      this.lines[this.cursorY] = `${line}${this.lines[this.cursorY + 1]}`;
      this.lines.splice(this.cursorY + 1, 1);
    } else {
      return;
    }

    this.dirty = true;
    this.pendingQuitConfirm = false;
    this.desiredColumn = null;
  }

  openPrompt(label, initialValue, onSubmit) {
    this.prompt = {
      label,
      onSubmit,
      value: initialValue ?? '',
    };
    this.setStatus('', 0);
  }

  closePrompt() {
    this.prompt = null;
  }

  appendToKillBuffer(text) {
    if (!text) return;
    this.killBuffer = this.lastCommandWasKill ? `${this.killBuffer}${text}` : text;
    this.lastCommandWasKill = true;
  }

  killLine() {
    const line = this.currentLine();
    if (this.cursorX < line.length) {
      const killedText = line.slice(this.cursorX);
      this.lines[this.cursorY] = line.slice(0, this.cursorX);
      this.appendToKillBuffer(killedText);
      this.dirty = true;
      this.pendingQuitConfirm = false;
      this.desiredColumn = null;
      this.setStatus('Killed text', 1200);
      return;
    }

    if (this.cursorY < this.lines.length - 1) {
      this.lines[this.cursorY] = `${line}${this.lines[this.cursorY + 1]}`;
      this.lines.splice(this.cursorY + 1, 1);
      this.appendToKillBuffer('\n');
      this.dirty = true;
      this.pendingQuitConfirm = false;
      this.desiredColumn = null;
      this.setStatus('Killed line break', 1200);
      return;
    }

    this.lastCommandWasKill = false;
  }

  yankKillBuffer() {
    if (!this.killBuffer) {
      this.lastCommandWasKill = false;
      this.setStatus('Kill buffer is empty', 1500);
      return;
    }

    this.lastCommandWasKill = false;
    const before = this.currentLine().slice(0, this.cursorX);
    const after = this.currentLine().slice(this.cursorX);
    const parts = this.killBuffer.split('\n');

    if (parts.length === 1) {
      this.insertText(parts[0]);
      this.setStatus('Yanked text', 1200);
      return;
    }

    const insertedLines = [before + parts[0], ...parts.slice(1, -1), parts.at(-1) + after];
    this.lines.splice(this.cursorY, 1, ...insertedLines);
    this.cursorY += parts.length - 1;
    this.cursorX = parts.at(-1).length;
    this.dirty = true;
    this.pendingQuitConfirm = false;
    this.desiredColumn = null;
    this.setStatus('Yanked text', 1200);
  }

  scrollIntoView() {
    const editorRows = this.editorRows();
    const editorColumns = this.editorColumns();
    const cursorColumn = this.currentColumn();

    if (this.cursorY < this.rowOffset) {
      this.rowOffset = this.cursorY;
    } else if (this.cursorY >= this.rowOffset + editorRows) {
      this.rowOffset = this.cursorY - editorRows + 1;
    }

    if (cursorColumn < this.columnOffset) {
      this.columnOffset = cursorColumn;
    } else if (cursorColumn >= this.columnOffset + editorColumns) {
      this.columnOffset = cursorColumn - editorColumns + 1;
    }
  }

  drawRows(output) {
    const editorRows = this.editorRows();
    const editorColumns = this.editorColumns();
    const lineNumberWidth = this.lineNumberWidth();

    for (let screenRow = 0; screenRow < editorRows; screenRow += 1) {
      const fileRow = this.rowOffset + screenRow;
      output.push(CLEAR_LINE);

      if (fileRow >= this.lines.length) {
        output.push(`${COLOR_DIM}~${COLOR_RESET}`);
      } else {
        const lineNumber = String(fileRow + 1).padStart(lineNumberWidth, ' ');
        const slice = sliceDisplayText(this.lines[fileRow], this.columnOffset, editorColumns, { expandTabs: true });
        output.push(`${COLOR_DIM}${lineNumber}${COLOR_RESET} ${slice}`);
      }

      output.push('\r\n');
    }
  }

  drawStatusBar(output) {
    const width = process.stdout.columns || 80;
    const fileLabel = this.filePath ? path.relative(process.cwd(), this.filePath) || path.basename(this.filePath) : '[No Name]';
    const left = `${this.programName} ${fileLabel}${this.dirty ? ' [modified]' : ''}`;
    const right = `Ln ${this.cursorY + 1}, Col ${this.currentColumn() + 1}`;
    const available = Math.max(0, width - measureDisplayText(right).columnCount);
    output.push(CLEAR_LINE);
    output.push(COLOR_INVERT);
    output.push(padOrTrim(left, available));
    output.push(padOrTrim(right, width - available));
    output.push(COLOR_RESET);
    output.push('\r\n');
  }

  drawMessageBar(output) {
    const width = process.stdout.columns || 80;
    output.push(CLEAR_LINE);
    output.push(padOrTrim(this.activeMessage(), width));
  }

  drawBottomPadding(output) {
    for (let index = 0; index < RESERVED_BOTTOM_ROWS; index += 1) {
      output.push('\r\n');
      output.push(CLEAR_LINE);
    }
  }

  refreshScreen() {
    if (!process.stdout.isTTY) return;
    this.scrollIntoView();

    const output = [CURSOR_HIDE, HOME];
    this.drawRows(output);
    this.drawStatusBar(output);
    this.drawMessageBar(output);
    this.drawBottomPadding(output);

    const cursorColumn = this.currentColumn();
    const cursorScreenX = this.lineNumberWidth() + 2 + cursorColumn - this.columnOffset;
    const cursorScreenY = this.cursorY - this.rowOffset + 1;

    output.push(
      `\x1b[${clamp(cursorScreenY, 1, process.stdout.rows || 24)};${clamp(cursorScreenX, 1, process.stdout.columns || 80)}H`,
    );
    output.push(CURSOR_SHOW);
    process.stdout.write(output.join(''));
  }

  cleanup() {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    process.stdin.off('keypress', this.boundHandleKeypress);
    process.stdout.off('resize', this.boundHandleResize);
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
    process.stdout.write(`${COLOR_RESET}${CURSOR_SHOW}${BRACKETED_PASTE_DISABLE}${ALT_SCREEN_DISABLE}`);
  }

  exit(code = 0) {
    this.cleanup();
    process.exit(code);
  }

  handlePromptKeypress(str, key) {
    if (!this.prompt) return;

    if (key?.name === 'paste-start' || key?.name === 'paste-end') {
      return;
    }

    if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
      this.closePrompt();
      this.setStatus('Prompt cancelled');
      return;
    }

    if (
      key?.name === 'return' ||
      key?.name === 'enter' ||
      (key?.ctrl && (key.name === 'j' || key.name === 'm'))
    ) {
      const prompt = this.prompt;
      this.closePrompt();
      prompt.onSubmit(prompt.value);
      return;
    }

    if (key?.name === 'backspace' || (key?.ctrl && key?.name === 'h')) {
      this.prompt.value = this.prompt.value.slice(0, -1);
      return;
    }

    if (key?.ctrl && key?.name === 'u') {
      this.prompt.value = '';
      return;
    }

    if (isPrintableInput(str, key)) {
      this.prompt.value += str;
    }
  }

  handlePasteKeypress(str, key) {
    if (key?.name === 'paste-start') {
      this.inBracketedPaste = true;
      return true;
    }

    if (key?.name === 'paste-end') {
      this.inBracketedPaste = false;
      return true;
    }

    if (!this.inBracketedPaste) return false;

    if (str === '\r' || str === '\n' || key?.name === 'return' || key?.name === 'enter') {
      this.insertNewline();
      return true;
    }

    if (str === '\t' || key?.name === 'tab') {
      this.insertText('\t');
      return true;
    }

    if (typeof str === 'string' && str.length > 0) {
      this.insertText(str);
      return true;
    }

    return true;
  }

  handleKeypress(str, key) {
    if (!(key?.ctrl && key?.name === 'k')) {
      this.lastCommandWasKill = false;
    }

    if (this.handlePasteKeypress(str, key)) {
      this.refreshScreen();
      return;
    }

    if (this.prompt) {
      this.handlePromptKeypress(str, key);
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && (key.name === 'o' || key.name === 's')) {
      this.saveFile();
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && (key.name === 'x' || key.name === 'q')) {
      if (this.dirty && !this.pendingQuitConfirm) {
        this.pendingQuitConfirm = true;
        this.setStatus('Unsaved changes. Press Ctrl-X again to quit, or Ctrl-O to save.', 4000);
        this.refreshScreen();
        return;
      }
      this.exit(0);
      return;
    }

    if (key?.ctrl && key?.name === 'w') {
      this.openPrompt('Search: ', this.lastSearch, (value) => {
        this.search(value.trim());
      });
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'c') {
      this.setStatus('Use Ctrl-X to exit');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'l') {
      this.lastCommandWasKill = false;
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'g') {
      this.showHelpStatus();
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'a') {
      this.moveCursor('home');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'e') {
      this.moveCursor('end');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'b') {
      this.moveCursor('left');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'f') {
      this.moveCursor('right');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'p') {
      this.moveCursor('up');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'n') {
      this.moveCursor('down');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'v') {
      this.moveCursor('pagedown');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'h') {
      this.backspace();
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'd') {
      this.deleteForward();
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'k') {
      this.killLine();
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'y') {
      this.moveCursor('pageup');
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && key?.name === 'u') {
      this.yankKillBuffer();
      this.refreshScreen();
      return;
    }

    if (key?.ctrl && (key.name === 'j' || key.name === 'm')) {
      this.insertNewline();
      this.refreshScreen();
      return;
    }

    switch (key?.name) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
      case 'home':
      case 'end':
      case 'pageup':
      case 'pagedown':
        this.moveCursor(key.name);
        break;
      case 'return':
      case 'enter':
        this.insertNewline();
        break;
      case 'backspace':
        this.backspace();
        break;
      case 'delete':
        this.deleteForward();
        break;
      case 'tab':
        this.insertText('  ');
        break;
      default:
        if (isPrintableInput(str, key)) {
          this.insertText(str);
        }
        break;
    }

    this.refreshScreen();
  }

  start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
      throw new Error(`${this.programName} requires an interactive terminal`);
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.boundHandleKeypress);
    process.stdout.on('resize', this.boundHandleResize);
    process.stdout.write(`${ALT_SCREEN_ENABLE}${BRACKETED_PASTE_ENABLE}${CURSOR_HIDE}`);
    this.refreshScreen();
  }
}

function printHelp(programName) {
  process.stdout.write(buildHelpLines(programName).join('\n'));
}

function main(argv = process.argv) {
  const programName = path.basename(argv[1] || 'nano');
  const rawFilePath = argv[2] ?? null;
  if (rawFilePath === '--help' || rawFilePath === '-h') {
    printHelp(programName);
    return;
  }

  const editor = new Editor(programName, rawFilePath);
  const cleanupAndRethrow = (error) => {
    try {
      editor.cleanup();
    } finally {
      throw error;
    }
  };

  process.once('SIGTERM', () => editor.exit(0));
  process.once('SIGHUP', () => editor.exit(0));
  process.once('uncaughtException', cleanupAndRethrow);

  try {
    editor.start();
  } catch (error) {
    editor.cleanup();
    throw error;
  }
}

module.exports = {
  main,
};

if (require.main === module) {
  main();
}
