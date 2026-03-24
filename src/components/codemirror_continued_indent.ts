import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

type ContinuedIndentMode = 'indent' | 'markdown';

interface ContinuedIndentOptions {
  mode: ContinuedIndentMode;
  maxColumns?: number;
}

const DEFAULT_MAX_CONTINUATION_COLUMNS = 10;

function advanceColumns(columns: number, ch: string, tabSize: number): number {
  if (ch === ' ') return columns + 1;
  if (ch === '\t') return columns + (tabSize - (columns % tabSize));
  return columns;
}

function consumeLeadingIndent(text: string, tabSize: number): { offset: number; columns: number } {
  let offset = 0;
  let columns = 0;
  while (offset < text.length) {
    const ch = text[offset];
    if (ch !== ' ' && ch !== '\t') break;
    columns = advanceColumns(columns, ch, tabSize);
    offset += 1;
  }
  return { offset, columns };
}

function consumeSpacePrefix(
  text: string,
  offset: number,
  columns: number,
  tabSize: number,
): { offset: number; columns: number } {
  let nextOffset = offset;
  let nextColumns = columns;
  while (nextOffset < text.length) {
    const ch = text[nextOffset];
    if (ch !== ' ' && ch !== '\t') break;
    nextColumns = advanceColumns(nextColumns, ch, tabSize);
    nextOffset += 1;
  }
  return { offset: nextOffset, columns: nextColumns };
}

function maybeConsumeBlockquotePrefix(
  text: string,
  offset: number,
  columns: number,
  tabSize: number,
): { consumed: boolean; offset: number; columns: number } {
  if (text[offset] !== '>') return { consumed: false, offset, columns };

  let nextOffset = offset + 1;
  let nextColumns = columns + 1;
  if (text[nextOffset] === ' ' || text[nextOffset] === '\t') {
    nextColumns = advanceColumns(nextColumns, text[nextOffset], tabSize);
    nextOffset += 1;
  }
  return { consumed: true, offset: nextOffset, columns: nextColumns };
}

function maybeConsumeUnorderedListPrefix(
  text: string,
  offset: number,
  columns: number,
  tabSize: number,
): { consumed: boolean; offset: number; columns: number } {
  const marker = text[offset];
  if (marker !== '-' && marker !== '*' && marker !== '+') {
    return { consumed: false, offset, columns };
  }
  const next = text[offset + 1];
  if (next !== ' ' && next !== '\t') {
    return { consumed: false, offset, columns };
  }
  return { consumed: true, offset: offset + 2, columns: advanceColumns(columns + 1, next, tabSize) };
}

function maybeConsumePromptListPrefix(
  text: string,
  offset: number,
  columns: number,
  tabSize: number,
): { consumed: boolean; offset: number; columns: number } {
  const marker = text[offset];
  if (marker !== '~' && marker !== '⏺') {
    return { consumed: false, offset, columns };
  }
  const spacer = text[offset + marker.length];
  if (spacer !== ' ' && spacer !== '\t') {
    return { consumed: false, offset, columns };
  }

  return {
    consumed: true,
    offset: offset + marker.length + 1,
    columns: advanceColumns(columns + marker.length, spacer, tabSize),
  };
}

function maybeConsumeOrderedListPrefix(
  text: string,
  offset: number,
  columns: number,
  tabSize: number,
): { consumed: boolean; offset: number; columns: number } {
  let cursor = offset;
  let nextColumns = columns;
  let digitCount = 0;

  while (cursor < text.length && /\d/.test(text[cursor] ?? '')) {
    nextColumns += 1;
    cursor += 1;
    digitCount += 1;
    if (digitCount > 9) return { consumed: false, offset, columns };
  }

  if (digitCount === 0) return { consumed: false, offset, columns };
  const punctuation = text[cursor];
  if (punctuation !== '.' && punctuation !== ')') {
    return { consumed: false, offset, columns };
  }
  cursor += 1;
  nextColumns += 1;

  const spacer = text[cursor];
  if (spacer !== ' ' && spacer !== '\t') {
    return { consumed: false, offset, columns };
  }

  nextColumns = advanceColumns(nextColumns, spacer, tabSize);
  return { consumed: true, offset: cursor + 1, columns: nextColumns };
}

function maybeConsumeTaskPrefix(
  text: string,
  offset: number,
  columns: number,
  tabSize: number,
): { consumed: boolean; offset: number; columns: number } {
  if (text[offset] !== '[') return { consumed: false, offset, columns };
  const marker = text[offset + 1];
  if (marker !== ' ' && marker !== 'x' && marker !== 'X') {
    return { consumed: false, offset, columns };
  }
  if (text[offset + 2] !== ']') {
    return { consumed: false, offset, columns };
  }
  const spacer = text[offset + 3];
  if (spacer !== ' ' && spacer !== '\t') {
    return { consumed: false, offset, columns };
  }

  return { consumed: true, offset: offset + 4, columns: advanceColumns(columns + 3, spacer, tabSize) };
}

function computeContinuationColumns(text: string, tabSize: number, mode: ContinuedIndentMode): number {
  const indent = consumeLeadingIndent(text, tabSize);
  if (mode === 'indent') return indent.columns;

  let offset = indent.offset;
  let columns = indent.columns;

  while (true) {
    const blockquote = maybeConsumeBlockquotePrefix(text, offset, columns, tabSize);
    if (!blockquote.consumed) break;
    offset = blockquote.offset;
    columns = blockquote.columns;
    const spaced = consumeSpacePrefix(text, offset, columns, tabSize);
    offset = spaced.offset;
    columns = spaced.columns;
  }

  const unordered = maybeConsumeUnorderedListPrefix(text, offset, columns, tabSize);
  if (unordered.consumed) {
    offset = unordered.offset;
    columns = unordered.columns;
  } else {
    const prompt = maybeConsumePromptListPrefix(text, offset, columns, tabSize);
    if (prompt.consumed) {
      offset = prompt.offset;
      columns = prompt.columns;
    } else {
      const ordered = maybeConsumeOrderedListPrefix(text, offset, columns, tabSize);
      if (ordered.consumed) {
        offset = ordered.offset;
        columns = ordered.columns;
      }
    }
  }

  const task = maybeConsumeTaskPrefix(text, offset, columns, tabSize);
  if (task.consumed) {
    columns = task.columns;
  }

  return columns;
}

function buildDecorations(view: EditorView, options: Required<ContinuedIndentOptions>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tabSize = view.state.tabSize;

  for (const { from, to } of view.visibleRanges) {
    let lineNumber = view.state.doc.lineAt(from).number;
    const lastLineNumber = view.state.doc.lineAt(to).number;

    for (; lineNumber <= lastLineNumber; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      const columns = Math.min(computeContinuationColumns(line.text, tabSize, options.mode), options.maxColumns);
      if (columns <= 0) continue;

      builder.add(
        line.from,
        line.from,
        Decoration.line({
          attributes: {
            style: `--cm-continued-indent: ${columns}ch; padding-left: var(--cm-continued-indent); text-indent: calc(-1 * var(--cm-continued-indent));`,
          },
        }),
      );
    }
  }

  return builder.finish();
}

export function continuedIndentExtension(options: ContinuedIndentOptions): ViewPlugin<{
  decorations: DecorationSet;
}> {
  const resolved: Required<ContinuedIndentOptions> = {
    maxColumns: options.maxColumns ?? DEFAULT_MAX_CONTINUATION_COLUMNS,
    mode: options.mode,
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, resolved);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.geometryChanged || update.heightChanged) {
          this.decorations = buildDecorations(update.view, resolved);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}
