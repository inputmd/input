import { type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type { ReaderAiStagedHunk } from '../reader_ai';

export interface EditorDiffPreviewBlock {
  from: number;
  to: number;
  insert?: string;
  kind?: 'insert' | 'replace' | 'delete';
  label?: string;
  deletedText?: string;
}

export interface EditorDiffPreview {
  blocks: EditorDiffPreviewBlock[];
  source?: string;
}

function buildLineStartOffsets(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function offsetForLineStart(lineStarts: number[], lineNumber: number, contentLength: number): number {
  if (lineNumber <= 1) return 0;
  if (lineNumber - 1 < lineStarts.length) return lineStarts[lineNumber - 1] ?? contentLength;
  return contentLength;
}

export function buildDiffPreviewBlocksFromHunks(
  originalContent: string,
  modifiedContent: string,
  hunks: ReaderAiStagedHunk[],
): EditorDiffPreviewBlock[] {
  if (!Array.isArray(hunks) || hunks.length === 0) return [];
  const originalLineStarts = buildLineStartOffsets(originalContent);
  const modifiedLineStarts = buildLineStartOffsets(modifiedContent);
  const blocks: EditorDiffPreviewBlock[] = [];

  for (const hunk of hunks) {
    const firstChangeIndex = hunk.lines.findIndex((line) => line.type !== 'context');
    if (firstChangeIndex < 0) continue;
    let lastChangeIndex = -1;
    for (let index = hunk.lines.length - 1; index >= 0; index -= 1) {
      if (hunk.lines[index]?.type !== 'context') {
        lastChangeIndex = index;
        break;
      }
    }
    if (lastChangeIndex < firstChangeIndex) continue;

    const relevantLines = hunk.lines.slice(firstChangeIndex, lastChangeIndex + 1);
    const originalLinesBeforeChange = hunk.lines
      .slice(0, firstChangeIndex)
      .filter((line) => line.type !== 'add').length;
    const modifiedLinesBeforeChange = hunk.lines
      .slice(0, firstChangeIndex)
      .filter((line) => line.type !== 'del').length;
    const replacedOriginalLineCount = relevantLines.filter((line) => line.type !== 'add').length;
    const insertedModifiedLineCount = relevantLines.filter((line) => line.type !== 'del').length;

    const fromLine = Math.max(1, hunk.oldStart + originalLinesBeforeChange);
    const toLine = Math.max(fromLine, fromLine + replacedOriginalLineCount);
    const insertFromLine = Math.max(1, hunk.newStart + modifiedLinesBeforeChange);
    const insertToLine = Math.max(insertFromLine, insertFromLine + insertedModifiedLineCount);

    const from = offsetForLineStart(originalLineStarts, fromLine, originalContent.length);
    const to = offsetForLineStart(originalLineStarts, toLine, originalContent.length);
    const insertFrom = offsetForLineStart(modifiedLineStarts, insertFromLine, modifiedContent.length);
    const insertTo = offsetForLineStart(modifiedLineStarts, insertToLine, modifiedContent.length);
    const deletedText = originalContent.slice(from, to);
    const insert = modifiedContent.slice(insertFrom, insertTo);

    if (!deletedText && !insert) continue;
    blocks.push({
      kind: deletedText && insert ? 'replace' : insert ? 'insert' : 'delete',
      from,
      to,
      insert,
      label: hunk.header,
      deletedText,
    });
  }

  return blocks;
}

class DiffPreviewWidget extends WidgetType {
  private readonly text: string;
  private readonly kind: NonNullable<EditorDiffPreviewBlock['kind']>;
  private readonly label?: string;
  private readonly deletedText?: string;

  constructor(text: string, kind: NonNullable<EditorDiffPreviewBlock['kind']>, label?: string, deletedText?: string) {
    super();
    this.text = text;
    this.kind = kind;
    this.label = label;
    this.deletedText = deletedText;
  }

  eq(other: DiffPreviewWidget): boolean {
    return (
      other.text === this.text &&
      other.kind === this.kind &&
      other.label === this.label &&
      other.deletedText === this.deletedText
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = `cm-editor-diff-preview-widget cm-editor-diff-preview-widget--${this.kind}`;

    if (this.label) {
      const label = document.createElement('div');
      label.className = 'cm-editor-diff-preview-label';
      label.textContent = this.label;
      wrapper.append(label);
    }

    if (this.deletedText && this.deletedText.length > 0) {
      const deleted = document.createElement('pre');
      deleted.className = 'cm-editor-diff-preview-content cm-editor-diff-preview-content--deleted';
      deleted.textContent = this.deletedText.length > 1200 ? `${this.deletedText.slice(0, 1200)}…` : this.deletedText;
      wrapper.append(deleted);
    }

    const content = document.createElement('pre');
    content.className = 'cm-editor-diff-preview-content';
    content.textContent = this.text.length > 1200 ? `${this.text.slice(0, 1200)}…` : this.text;
    wrapper.append(content);
    return wrapper;
  }
}

function normalizeKind(block: EditorDiffPreviewBlock): NonNullable<EditorDiffPreviewBlock['kind']> {
  if (block.kind === 'delete' || block.kind === 'replace' || block.kind === 'insert') return block.kind;
  if ((block.insert ?? '').length > 0 && block.to > block.from) return 'replace';
  if ((block.insert ?? '').length > 0) return 'insert';
  return 'delete';
}

function previewLineClass(kind: NonNullable<EditorDiffPreviewBlock['kind']>): string {
  if (kind === 'insert') return 'cm-editor-diff-preview-line cm-editor-diff-preview-line--insert';
  if (kind === 'delete') return 'cm-editor-diff-preview-line cm-editor-diff-preview-line--delete';
  return 'cm-editor-diff-preview-line cm-editor-diff-preview-line--replace';
}

function buildEditorDiffPreviewDecorations(view: EditorView, preview: EditorDiffPreview | null): DecorationSet {
  if (!preview || !Array.isArray(preview.blocks) || preview.blocks.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const docLength = view.state.doc.length;

  for (const rawBlock of preview.blocks) {
    const from = Math.max(0, Math.min(docLength, Math.floor(rawBlock.from)));
    const to = Math.max(from, Math.min(docLength, Math.floor(rawBlock.to)));
    const insert = rawBlock.insert ?? '';
    const kind = normalizeKind(rawBlock);
    const line = view.state.doc.lineAt(from);

    builder.add(
      line.from,
      line.from,
      Decoration.line({
        class: previewLineClass(kind),
      }),
    );

    if (to > from) {
      builder.add(
        from,
        to,
        Decoration.mark({
          class:
            kind === 'delete'
              ? 'cm-editor-diff-preview-range cm-editor-diff-preview-range--delete'
              : 'cm-editor-diff-preview-range cm-editor-diff-preview-range--replace',
        }),
      );
    }

    if (insert.length > 0) {
      builder.add(
        to,
        to,
        Decoration.widget({
          widget: new DiffPreviewWidget(insert, kind, rawBlock.label, rawBlock.deletedText),
          side: 1,
          block: true,
        }),
      );
    } else if (kind === 'delete' && (rawBlock.deletedText ?? '').length > 0) {
      builder.add(
        to,
        to,
        Decoration.widget({
          widget: new DiffPreviewWidget('', kind, rawBlock.label, rawBlock.deletedText),
          side: 1,
          block: true,
        }),
      );
    }
  }

  return builder.finish();
}

export function editorDiffPreviewExtension(preview: EditorDiffPreview | null): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildEditorDiffPreviewDecorations(view, preview);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildEditorDiffPreviewDecorations(update.view, preview);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}
