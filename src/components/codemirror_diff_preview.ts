import { type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
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
  badge?: string;
}

type DiffPreviewWidgetDisplay = 'block' | 'inline';

interface InlineDiffPart {
  kind: 'context' | 'deleted' | 'inserted';
  text: string;
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
  private readonly display: DiffPreviewWidgetDisplay;
  private readonly source?: string;
  private readonly badge?: string;

  constructor(
    text: string,
    kind: NonNullable<EditorDiffPreviewBlock['kind']>,
    label?: string,
    deletedText?: string,
    display: DiffPreviewWidgetDisplay = 'block',
    source?: string,
    badge?: string,
  ) {
    super();
    this.text = text;
    this.kind = kind;
    this.label = label;
    this.deletedText = deletedText;
    this.display = display;
    this.source = source;
    this.badge = badge;
  }

  eq(other: DiffPreviewWidget): boolean {
    return (
      other.text === this.text &&
      other.kind === this.kind &&
      other.label === this.label &&
      other.deletedText === this.deletedText &&
      other.display === this.display &&
      other.source === this.source &&
      other.badge === this.badge
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = `cm-editor-diff-preview-widget cm-editor-diff-preview-widget--${this.kind} cm-editor-diff-preview-widget--${this.display}`;

    if ((this.source || this.badge) && this.display === 'block') {
      const meta = document.createElement('div');
      meta.className = 'cm-editor-diff-preview-meta';
      if (this.source) {
        const source = document.createElement('span');
        source.className = 'cm-editor-diff-preview-source';
        source.textContent = this.source;
        meta.append(source);
      }
      if (this.badge) {
        const badge = document.createElement('span');
        badge.className = 'cm-editor-diff-preview-badge';
        badge.textContent = this.badge;
        meta.append(badge);
      }
      wrapper.append(meta);
    }

    if (this.label && this.display === 'block') {
      const label = document.createElement('div');
      label.className = 'cm-editor-diff-preview-label';
      label.textContent = this.label;
      wrapper.append(label);
    }

    if (this.display === 'inline') {
      this.appendInlineDiffContent(wrapper);
      return wrapper;
    }

    if (this.deletedText && this.deletedText.length > 0) {
      const deleted = document.createElement('pre');
      deleted.className = 'cm-editor-diff-preview-content cm-editor-diff-preview-content--deleted';
      deleted.textContent = this.deletedText.length > 1200 ? `${this.deletedText.slice(0, 1200)}…` : this.deletedText;
      wrapper.append(deleted);
    }

    if (this.text.length > 0 || !(this.deletedText && this.deletedText.length > 0)) {
      const content = document.createElement('pre');
      content.className = 'cm-editor-diff-preview-content';
      content.textContent = this.text.length > 1200 ? `${this.text.slice(0, 1200)}…` : this.text;
      wrapper.append(content);
    }
    return wrapper;
  }

  private appendInlineDiffContent(wrapper: HTMLElement): void {
    const parts = buildInlineDiffParts(this.deletedText ?? '', this.text);
    for (const part of parts) {
      if (!part.text) continue;
      const span = document.createElement('span');
      span.className = `cm-editor-diff-preview-inline-part cm-editor-diff-preview-inline-part--${part.kind}`;
      span.textContent = part.text;
      wrapper.append(span);
    }
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

function previewTextVisualLineCount(text: string | undefined): number {
  if (!text) return 0;
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!normalized) return 1;
  return normalized.split('\n').length;
}

function trimSingleTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function buildInlineDiffParts(deletedText: string, insertedText: string): InlineDiffPart[] {
  const before = trimSingleTrailingNewline(deletedText);
  const after = trimSingleTrailingNewline(insertedText);
  const maxPrefixLength = Math.min(before.length, after.length);
  let prefixLength = 0;
  while (prefixLength < maxPrefixLength && before[prefixLength] === after[prefixLength]) prefixLength += 1;

  const beforeRemainder = before.length - prefixLength;
  const afterRemainder = after.length - prefixLength;
  let suffixLength = 0;
  while (
    suffixLength < beforeRemainder &&
    suffixLength < afterRemainder &&
    before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const prefix = before.slice(0, prefixLength);
  const deleted = before.slice(prefixLength, before.length - suffixLength);
  const inserted = after.slice(prefixLength, after.length - suffixLength);
  const suffix = before.slice(before.length - suffixLength);
  const parts: InlineDiffPart[] = [];
  if (prefix) parts.push({ kind: 'context', text: prefix });
  if (deleted) parts.push({ kind: 'deleted', text: deleted });
  if (inserted) parts.push({ kind: 'inserted', text: inserted });
  if (suffix) parts.push({ kind: 'context', text: suffix });
  if (parts.length === 0) parts.push({ kind: 'context', text: after || before });
  return parts;
}

function shouldRenderInlinePreview(block: EditorDiffPreviewBlock): boolean {
  return previewTextVisualLineCount(block.insert) <= 1 && previewTextVisualLineCount(block.deletedText) <= 1;
}

function buildEditorDiffPreviewDecorations(
  state: EditorView['state'],
  preview: EditorDiffPreview | null,
): DecorationSet {
  if (!preview || !Array.isArray(preview.blocks) || preview.blocks.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const docLength = state.doc.length;

  for (const rawBlock of preview.blocks) {
    const from = Math.max(0, Math.min(docLength, Math.floor(rawBlock.from)));
    const to = Math.max(from, Math.min(docLength, Math.floor(rawBlock.to)));
    const insert = rawBlock.insert ?? '';
    const kind = normalizeKind(rawBlock);
    const line = state.doc.lineAt(from);
    const inlinePreview = shouldRenderInlinePreview(rawBlock);

    if (!inlinePreview) {
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: previewLineClass(kind),
        }),
      );
    }

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
        inlinePreview ? line.to : to,
        inlinePreview ? line.to : to,
        inlinePreview
          ? Decoration.widget({
              widget: new DiffPreviewWidget(
                insert,
                kind,
                rawBlock.label,
                rawBlock.deletedText,
                'inline',
                preview.source,
                preview.badge,
              ),
              side: 1,
            })
          : Decoration.replace({
              widget: new DiffPreviewWidget(
                insert,
                kind,
                rawBlock.label,
                rawBlock.deletedText,
                'block',
                preview.source,
                preview.badge,
              ),
              block: true,
            }),
      );
    } else if (kind === 'delete' && (rawBlock.deletedText ?? '').length > 0) {
      builder.add(
        inlinePreview ? line.to : to,
        inlinePreview ? line.to : to,
        inlinePreview
          ? Decoration.widget({
              widget: new DiffPreviewWidget(
                '',
                kind,
                rawBlock.label,
                rawBlock.deletedText,
                'inline',
                preview.source,
                preview.badge,
              ),
              side: 1,
            })
          : Decoration.replace({
              widget: new DiffPreviewWidget(
                '',
                kind,
                rawBlock.label,
                rawBlock.deletedText,
                'block',
                preview.source,
                preview.badge,
              ),
              block: true,
            }),
      );
    }
  }

  return builder.finish();
}

function buildEditorDiffPreviewAtomicRanges(
  state: EditorView['state'],
  preview: EditorDiffPreview | null,
): DecorationSet {
  if (!preview || !Array.isArray(preview.blocks) || preview.blocks.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const docLength = state.doc.length;

  for (const rawBlock of preview.blocks) {
    const from = Math.max(0, Math.min(docLength, Math.floor(rawBlock.from)));
    const to = Math.max(from, Math.min(docLength, Math.floor(rawBlock.to)));
    const insert = rawBlock.insert ?? '';
    const kind = normalizeKind(rawBlock);

    if (
      !shouldRenderInlinePreview(rawBlock) &&
      (insert.length > 0 || (kind === 'delete' && (rawBlock.deletedText ?? '').length > 0))
    ) {
      builder.add(
        to,
        to,
        Decoration.replace({
          block: true,
        }),
      );
    }
  }

  return builder.finish();
}

export function editorDiffPreviewExtension(preview: EditorDiffPreview | null): Extension {
  const decorations = StateField.define<DecorationSet>({
    create(state) {
      return buildEditorDiffPreviewDecorations(state, preview);
    },
    update(value, tr) {
      if (tr.docChanged) return buildEditorDiffPreviewDecorations(tr.state, preview);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  const atomicRanges = StateField.define<DecorationSet>({
    create(state) {
      return buildEditorDiffPreviewAtomicRanges(state, preview);
    },
    update(value, tr) {
      if (tr.docChanged) return buildEditorDiffPreviewAtomicRanges(tr.state, preview);
      return value;
    },
    provide: (field) => EditorView.atomicRanges.of((view) => view.state.field(field)),
  });

  return [decorations, atomicRanges];
}
