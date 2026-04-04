import { type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { ReaderAiStagedHunk } from '../reader_ai';

export interface EditorDiffPreviewBlock {
  from: number;
  to: number;
  insertedText?: string;
  label?: string;
  deletedText?: string;
  changeId?: string;
  hunkId?: string;
  detail?: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'applied' | 'conflicted' | 'stale' | 'failed';
  actions?: EditorDiffPreviewAction[];
}

export interface EditorDiffPreview {
  blocks: EditorDiffPreviewBlock[];
  source?: string;
  badge?: string;
}

export type EditorDiffPreviewActionId = 'accept' | 'reject' | 'review' | 'keep_mine' | 'use_ai';

export interface EditorDiffPreviewAction {
  id: EditorDiffPreviewActionId;
  label: string;
  tone?: 'primary' | 'danger' | 'neutral';
}

export interface EditorDiffPreviewActionEvent {
  actionId: EditorDiffPreviewActionId;
  changeId: string;
  hunkId?: string;
  block: EditorDiffPreviewBlock;
}

type DiffPreviewWidgetDisplay = 'block' | 'inline';
const INLINE_DIFF_PREVIEW_MAX_CHARS = 80;
const SVG_NS = 'http://www.w3.org/2000/svg';

function shouldRenderDiffPreviewMeta(display: DiffPreviewWidgetDisplay, badge?: string, source?: string): boolean {
  if (display !== 'block') return false;
  if (badge === 'Proposal') return false;
  return Boolean(source || badge);
}

function shouldRenderDiffPreviewDetail(display: DiffPreviewWidgetDisplay, badge?: string, detail?: string): boolean {
  if (display !== 'block') return false;
  if (!detail) return false;
  if (badge === 'Proposal') return false;
  return true;
}

function createLucideStateIcon(kind: 'accept' | 'reject'): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '12');
  icon.setAttribute('height', '12');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', kind === 'accept' ? 'M20 6 9 17l-5-5' : 'M18 6 6 18M6 6l12 12');
  icon.append(path);
  return icon;
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
    const insertedText = modifiedContent.slice(insertFrom, insertTo);

    if (!deletedText && !insertedText) continue;
    blocks.push({
      from,
      to,
      insertedText,
      label: hunk.header,
      deletedText,
    });
  }

  return blocks;
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength = 0): number {
  const maxLength = Math.min(left.length, right.length) - prefixLength;
  let index = 0;
  while (index < maxLength && left[left.length - 1 - index] === right[right.length - 1 - index]) {
    index += 1;
  }
  return index;
}

export function buildDiffPreviewBlocksFromContent(
  originalContent: string,
  modifiedContent: string,
  options?: { label?: string; status?: EditorDiffPreviewBlock['status'] },
): EditorDiffPreviewBlock[] {
  if (originalContent === modifiedContent) return [];
  const start = commonPrefixLength(originalContent, modifiedContent);
  const trailingOverlap = commonSuffixLength(originalContent, modifiedContent, start);
  const originalTrimmedEnd = originalContent.length - trailingOverlap;
  const modifiedTrimmedEnd = modifiedContent.length - trailingOverlap;
  const deletedText = originalContent.slice(start, originalTrimmedEnd);
  const insertedText = modifiedContent.slice(start, modifiedTrimmedEnd);
  if (!deletedText && !insertedText) return [];
  return [
    {
      from: Math.max(0, start),
      to: Math.max(0, originalTrimmedEnd),
      deletedText,
      insertedText,
      label: options?.label,
      status: options?.status,
    },
  ];
}

class DiffPreviewWidget extends WidgetType {
  private readonly block: EditorDiffPreviewBlock;
  private readonly kind: 'insert' | 'replace' | 'delete';
  private readonly display: DiffPreviewWidgetDisplay;
  private readonly source?: string;
  private readonly badge?: string;
  private readonly onAction?: (event: EditorDiffPreviewActionEvent) => void;
  private readonly actionSignature: string;

  constructor(
    block: EditorDiffPreviewBlock,
    display: DiffPreviewWidgetDisplay = 'block',
    source?: string,
    badge?: string,
    onAction?: (event: EditorDiffPreviewActionEvent) => void,
  ) {
    super();
    this.block = block;
    this.kind = normalizeKind(block);
    this.display = display;
    this.source = source;
    this.badge = badge;
    this.onAction = onAction;
    this.actionSignature = (block.actions ?? [])
      .map((action) => `${action.id}:${action.label}:${action.tone ?? 'neutral'}`)
      .join('|');
  }

  eq(other: DiffPreviewWidget): boolean {
    return (
      other.block.insertedText === this.block.insertedText &&
      other.block.deletedText === this.block.deletedText &&
      other.block.label === this.block.label &&
      other.block.status === this.block.status &&
      other.block.detail === this.block.detail &&
      other.block.changeId === this.block.changeId &&
      other.block.hunkId === this.block.hunkId &&
      other.kind === this.kind &&
      other.display === this.display &&
      other.source === this.source &&
      other.badge === this.badge &&
      other.onAction === this.onAction &&
      other.actionSignature === this.actionSignature
    );
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = `cm-editor-diff-preview-widget cm-editor-diff-preview-widget--${this.kind} cm-editor-diff-preview-widget--${this.display}`;
    if (this.block.status) wrapper.classList.add(`cm-editor-diff-preview-widget--status-${this.block.status}`);

    if (shouldRenderDiffPreviewMeta(this.display, this.badge, this.source)) {
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

    if (this.display === 'inline') {
      this.appendInlineDiffContent(wrapper);
      this.appendActions(wrapper, 'inline');
      return wrapper;
    }

    const deletedText = this.block.deletedText ?? '';
    if (deletedText.trim().length > 0) {
      const deleted = document.createElement('div');
      deleted.className = 'cm-editor-diff-preview-content cm-editor-diff-preview-content--deleted';
      const displayText = displayBlockPreviewText(deletedText);
      deleted.textContent = displayText.length > 1200 ? `${displayText.slice(0, 1200)}…` : displayText;
      wrapper.append(deleted);
    }

    const insertedText = this.block.insertedText ?? '';
    if (insertedText.trim().length > 0) {
      const content = document.createElement('div');
      content.className = 'cm-editor-diff-preview-content';
      const displayText = displayBlockPreviewText(insertedText);
      content.textContent = displayText.length > 1200 ? `${displayText.slice(0, 1200)}…` : displayText;
      wrapper.append(content);
    }
    this.appendActions(wrapper, 'block');
    return wrapper;
  }

  private appendInlineDiffContent(wrapper: HTMLElement): void {
    if (this.kind === 'delete') {
      const badge = document.createElement('span');
      badge.className = 'cm-editor-diff-preview-inline-chip cm-editor-diff-preview-inline-chip--delete';
      badge.textContent = 'Deleted';
      wrapper.append(badge);
      return;
    }

    const inserted = trimSingleTrailingNewline(this.block.insertedText ?? '');
    if (inserted) {
      const span = document.createElement('span');
      span.className = 'cm-editor-diff-preview-inline-part cm-editor-diff-preview-inline-part--inserted';
      span.textContent = inserted;
      wrapper.append(span);
    }
  }

  private appendActions(wrapper: HTMLElement, display: DiffPreviewWidgetDisplay): void {
    if (!this.block.changeId || !this.onAction) {
      return;
    }
    const actions = document.createElement('div');
    actions.className = `cm-editor-diff-preview-actions cm-editor-diff-preview-actions--${display}`;
    const renderedActionIds = new Set<EditorDiffPreviewActionId>();

    if (this.block.status === 'accepted' || this.block.status === 'rejected') {
      const currentActionId: EditorDiffPreviewActionId = this.block.status === 'accepted' ? 'accept' : 'reject';
      const alternateActionId: EditorDiffPreviewActionId = currentActionId === 'accept' ? 'reject' : 'accept';
      const stateGroup = document.createElement('div');
      stateGroup.className = 'cm-editor-diff-preview-state-split';
      stateGroup.setAttribute('role', 'group');
      stateGroup.setAttribute('aria-label', 'Choose whether to accept or reject this change');
      stateGroup.append(
        this.createActionButton({
          actionId: currentActionId,
          label: currentActionId === 'accept' ? 'Accepted' : 'Rejected',
          tone: currentActionId === 'accept' ? 'primary' : 'danger',
          stateKind: currentActionId,
          prominent: true,
        }),
        this.createActionButton({
          actionId: alternateActionId,
          label: alternateActionId === 'accept' ? 'Accept' : 'Reject',
          tone: alternateActionId === 'accept' ? 'primary' : 'danger',
          stateKind: alternateActionId,
          compact: true,
        }),
      );
      actions.append(stateGroup);
      renderedActionIds.add('accept');
      renderedActionIds.add('reject');
    }

    for (const action of this.block.actions ?? []) {
      if (renderedActionIds.has(action.id)) continue;
      actions.append(
        this.createActionButton({
          actionId: action.id,
          label: action.label,
          tone: action.tone ?? 'neutral',
        }),
      );
    }

    if (actions.childElementCount === 0) return;
    if (shouldRenderDiffPreviewDetail(display, this.badge, this.block.detail)) {
      const detail = document.createElement('div');
      detail.className = 'cm-editor-diff-preview-detail';
      detail.textContent = this.block.detail!;
      actions.append(detail);
    }
    wrapper.append(actions);
  }

  private createActionButton(options: {
    actionId: EditorDiffPreviewActionId;
    label: string;
    tone: EditorDiffPreviewAction['tone'];
    stateKind?: 'accept' | 'reject';
    prominent?: boolean;
    compact?: boolean;
  }): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cm-editor-diff-preview-action cm-editor-diff-preview-action--${options.tone ?? 'neutral'}`;
    if (options.prominent) button.classList.add('cm-editor-diff-preview-action--prominent');
    if (options.compact) button.classList.add('cm-editor-diff-preview-action--compact');
    if (options.stateKind) button.classList.add(`cm-editor-diff-preview-action--state-${options.stateKind}`);
    if (options.stateKind) {
      const icon = createLucideStateIcon(options.stateKind);
      button.append(icon);
    }
    if (!options.compact) {
      const label = document.createElement('span');
      label.textContent = options.label;
      button.append(label);
    } else {
      button.setAttribute('aria-label', options.label);
      button.title = options.label;
    }
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onAction?.({
        actionId: options.actionId,
        changeId: this.block.changeId!,
        ...(this.block.hunkId ? { hunkId: this.block.hunkId } : {}),
        block: this.block,
      });
    });
    return button;
  }
}

function normalizeKind(block: EditorDiffPreviewBlock): 'insert' | 'replace' | 'delete' {
  if ((block.insertedText ?? '').length > 0 && (block.deletedText ?? '').length > 0) return 'replace';
  if ((block.insertedText ?? '').length > 0) return 'insert';
  return 'delete';
}

function previewLineClass(kind: 'insert' | 'replace' | 'delete'): string {
  if (kind === 'insert') return 'cm-editor-diff-preview-line cm-editor-diff-preview-line--insert';
  if (kind === 'delete') return 'cm-editor-diff-preview-line cm-editor-diff-preview-line--delete';
  return 'cm-editor-diff-preview-line cm-editor-diff-preview-line--replace';
}

function trimSingleTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function displayBlockPreviewText(text: string): string {
  return trimSingleTrailingNewline(text);
}

function isSingleLogicalLine(text: string | undefined): boolean {
  if (!text) return true;
  if (text.endsWith('\n')) return false;
  return !text.includes('\n');
}

function shouldRenderInlinePreview(block: EditorDiffPreviewBlock): boolean {
  const deletedText = trimSingleTrailingNewline(block.deletedText ?? '');
  const insertedText = trimSingleTrailingNewline(block.insertedText ?? '');
  if (!isSingleLogicalLine(block.deletedText) || !isSingleLogicalLine(block.insertedText)) return false;
  return Math.max(deletedText.length, insertedText.length) <= INLINE_DIFF_PREVIEW_MAX_CHARS;
}

interface DecorationEntry {
  from: number;
  to: number;
  value: Decoration;
  order: number;
}

function sortDecorationEntries(entries: DecorationEntry[]): DecorationEntry[] {
  return entries.sort((left, right) => {
    if (left.from !== right.from) return left.from - right.from;
    if (left.value.startSide !== right.value.startSide) return left.value.startSide - right.value.startSide;
    if (left.to !== right.to) return left.to - right.to;
    if (left.value.endSide !== right.value.endSide) return left.value.endSide - right.value.endSide;
    return left.order - right.order;
  });
}

function buildEditorDiffPreviewDecorations(
  state: EditorView['state'],
  preview: EditorDiffPreview | null,
  onAction?: (event: EditorDiffPreviewActionEvent) => void,
): DecorationSet {
  if (!preview || !Array.isArray(preview.blocks) || preview.blocks.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const docLength = state.doc.length;
  const entries: DecorationEntry[] = [];
  let order = 0;

  for (const rawBlock of preview.blocks) {
    const from = Math.max(0, Math.min(docLength, Math.floor(rawBlock.from)));
    const to = Math.max(from, Math.min(docLength, Math.floor(rawBlock.to)));
    const insertedText = rawBlock.insertedText ?? '';
    const kind = normalizeKind(rawBlock);
    const line = state.doc.lineAt(from);
    const inlinePreview = shouldRenderInlinePreview(rawBlock);

    if (!inlinePreview) {
      entries.push({
        from: line.from,
        to: line.from,
        value: Decoration.line({
          class: previewLineClass(kind),
        }),
        order: order++,
      });
    }

    if (to > from) {
      entries.push({
        from,
        to,
        value: Decoration.mark({
          class:
            kind === 'delete'
              ? 'cm-editor-diff-preview-range cm-editor-diff-preview-range--delete'
              : 'cm-editor-diff-preview-range cm-editor-diff-preview-range--replace',
        }),
        order: order++,
      });
    }

    if (insertedText.length > 0) {
      const value = inlinePreview
        ? Decoration.widget({
            widget: new DiffPreviewWidget(rawBlock, 'inline', preview.source, preview.badge, onAction),
            side: 1,
          })
        : Decoration.replace({
            widget: new DiffPreviewWidget(rawBlock, 'block', preview.source, preview.badge, onAction),
            block: true,
          });
      const position = to;
      entries.push({
        from: position,
        to: position,
        value,
        order: order++,
      });
    } else if (kind === 'delete' && (rawBlock.deletedText ?? '').length > 0) {
      const value = inlinePreview
        ? Decoration.widget({
            widget: new DiffPreviewWidget(rawBlock, 'inline', preview.source, preview.badge, onAction),
            side: 1,
          })
        : Decoration.replace({
            widget: new DiffPreviewWidget(rawBlock, 'block', preview.source, preview.badge, onAction),
            block: true,
          });
      const position = to;
      entries.push({
        from: position,
        to: position,
        value,
        order: order++,
      });
    }
  }

  for (const entry of sortDecorationEntries(entries)) {
    builder.add(entry.from, entry.to, entry.value);
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
  const entries: DecorationEntry[] = [];
  let order = 0;

  for (const rawBlock of preview.blocks) {
    const from = Math.max(0, Math.min(docLength, Math.floor(rawBlock.from)));
    const to = Math.max(from, Math.min(docLength, Math.floor(rawBlock.to)));
    const insertedText = rawBlock.insertedText ?? '';
    const kind = normalizeKind(rawBlock);

    if (
      !shouldRenderInlinePreview(rawBlock) &&
      (insertedText.length > 0 || (kind === 'delete' && (rawBlock.deletedText ?? '').length > 0))
    ) {
      entries.push({
        from: to,
        to,
        value: Decoration.replace({
          block: true,
        }),
        order: order++,
      });
    }
  }

  for (const entry of sortDecorationEntries(entries)) {
    builder.add(entry.from, entry.to, entry.value);
  }

  return builder.finish();
}

export function editorDiffPreviewExtension(
  preview: EditorDiffPreview | null,
  options?: { onAction?: (event: EditorDiffPreviewActionEvent) => void },
): Extension {
  const decorations = StateField.define<DecorationSet>({
    create(state) {
      return buildEditorDiffPreviewDecorations(state, preview, options?.onAction);
    },
    update(value, tr) {
      if (tr.docChanged) return buildEditorDiffPreviewDecorations(tr.state, preview, options?.onAction);
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
