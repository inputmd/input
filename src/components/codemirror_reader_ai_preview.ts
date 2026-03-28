import { type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

export interface ReaderAiInlinePreview {
  from: number;
  to: number;
  insert: string;
  label?: string;
}

class InlinePreviewWidget extends WidgetType {
  private readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  eq(other: InlinePreviewWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-reader-ai-inline-preview';
    span.textContent = this.text.length > 160 ? `${this.text.slice(0, 160)}…` : this.text;
    return span;
  }
}

function buildReaderAiPreviewDecorations(view: EditorView, preview: ReaderAiInlinePreview | null): DecorationSet {
  if (!preview) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const docLength = view.state.doc.length;
  const from = Math.max(0, Math.min(docLength, Math.floor(preview.from)));
  const to = Math.max(from, Math.min(docLength, Math.floor(preview.to)));
  const insert = preview.insert ?? '';
  const line = view.state.doc.lineAt(from);
  if (to > from) {
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        class: 'cm-reader-ai-preview-line',
      }),
    );
  }
  if (insert.length > 0) {
    builder.add(
      to,
      to,
      Decoration.widget({
        widget: new InlinePreviewWidget(insert),
        side: 1,
      }),
    );
  }

  return builder.finish();
}

export function readerAiPreviewExtension(preview: ReaderAiInlinePreview | null): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildReaderAiPreviewDecorations(view, preview);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildReaderAiPreviewDecorations(update.view, preview);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}

export const readerAiInlinePreviewExtension = readerAiPreviewExtension;
