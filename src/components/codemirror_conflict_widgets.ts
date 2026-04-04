import { type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface EditorConflictWidget {
  id: string;
  lineNumber: number;
  title: string;
  message: string;
  currentText?: string | null;
  proposedText?: string | null;
  baseText?: string | null;
  tone: 'stale' | 'conflicted' | 'failed';
  changeId: string;
  hunkId: string;
  disabled?: boolean;
}

interface EditorConflictWidgetActions {
  onKeepMine?: (target: { changeId: string; hunkId: string }) => void;
  onUseAi?: (target: { changeId: string; hunkId: string }) => void;
  onReview?: (target: { changeId: string; hunkId: string }) => void;
}

class ReaderAiConflictWidget extends WidgetType {
  private readonly widget: EditorConflictWidget;
  private readonly actions?: EditorConflictWidgetActions;

  constructor(widget: EditorConflictWidget, actions?: EditorConflictWidgetActions) {
    super();
    this.widget = widget;
    this.actions = actions;
  }

  eq(other: ReaderAiConflictWidget): boolean {
    return (
      this.widget.id === other.widget.id &&
      this.widget.lineNumber === other.widget.lineNumber &&
      this.widget.title === other.widget.title &&
      this.widget.message === other.widget.message &&
      this.widget.currentText === other.widget.currentText &&
      this.widget.proposedText === other.widget.proposedText &&
      this.widget.baseText === other.widget.baseText &&
      this.widget.tone === other.widget.tone &&
      this.widget.changeId === other.widget.changeId &&
      this.widget.hunkId === other.widget.hunkId &&
      this.widget.disabled === other.widget.disabled
    );
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = `cm-reader-ai-conflict-widget cm-reader-ai-conflict-widget--${this.widget.tone}`;
    if (this.widget.disabled) wrapper.classList.add('cm-reader-ai-conflict-widget--disabled');

    const title = document.createElement('div');
    title.className = 'cm-reader-ai-conflict-widget__title';
    title.textContent = this.widget.title;
    wrapper.append(title);

    const message = document.createElement('div');
    message.className = 'cm-reader-ai-conflict-widget__message';
    message.textContent = this.widget.message;
    wrapper.append(message);

    if (this.widget.currentText || this.widget.proposedText || this.widget.baseText) {
      const preview = document.createElement('div');
      preview.className = 'cm-reader-ai-conflict-widget__preview';
      if (this.widget.currentText) {
        preview.append(this.createSnippet('Current', this.widget.currentText, 'current'));
      }
      if (this.widget.proposedText) {
        preview.append(this.createSnippet('AI', this.widget.proposedText, 'proposed'));
      }
      if (this.widget.baseText) {
        preview.append(this.createSnippet('Base', this.widget.baseText, 'base'));
      }
      wrapper.append(preview);
    }

    const actions = document.createElement('div');
    actions.className = 'cm-reader-ai-conflict-widget__actions';
    actions.append(
      this.createButton('Keep mine', () => this.actions?.onKeepMine?.(this.widget)),
      this.createButton('Use AI', () => this.actions?.onUseAi?.(this.widget)),
      this.createButton('Review', () => this.actions?.onReview?.(this.widget)),
    );
    wrapper.append(actions);

    return wrapper;
  }

  private createButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-reader-ai-conflict-widget__button';
    button.textContent = label;
    button.disabled = this.widget.disabled === true;
    button.addEventListener('mousedown', (event) => {
      if (button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      if (button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private createSnippet(label: string, text: string, tone: 'current' | 'proposed' | 'base'): HTMLElement {
    const section = document.createElement('div');
    section.className = `cm-reader-ai-conflict-widget__snippet cm-reader-ai-conflict-widget__snippet--${tone}`;

    const heading = document.createElement('div');
    heading.className = 'cm-reader-ai-conflict-widget__snippet-label';
    heading.textContent = label;
    section.append(heading);

    const body = document.createElement('pre');
    body.className = 'cm-reader-ai-conflict-widget__snippet-body';
    body.textContent = text;
    section.append(body);

    return section;
  }
}

function buildConflictWidgetDecorations(
  state: EditorView['state'],
  widgets: EditorConflictWidget[] | null,
  actions?: EditorConflictWidgetActions,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!Array.isArray(widgets) || widgets.length === 0) return builder.finish();
  for (const widget of widgets) {
    if (!Number.isFinite(widget.lineNumber)) continue;
    const normalizedLineNumber = Math.trunc(widget.lineNumber);
    if (normalizedLineNumber < 1) continue;
    const lineNumber = Math.min(state.doc.lines, normalizedLineNumber);
    if (lineNumber < 1 || lineNumber > state.doc.lines) continue;
    const line = state.doc.line(lineNumber);
    builder.add(
      line.from,
      line.from,
      Decoration.widget({
        widget: new ReaderAiConflictWidget(widget, actions),
        block: true,
        side: -1,
      }),
    );
  }
  return builder.finish();
}

export function editorConflictWidgetsExtension(
  widgets: EditorConflictWidget[] | null,
  actions?: EditorConflictWidgetActions,
): Extension {
  const widgetField = StateField.define<DecorationSet>({
    create(state) {
      return buildConflictWidgetDecorations(state, widgets, actions);
    },
    update(value, tr) {
      if (tr.docChanged) return value.map(tr.changes);
      return value;
    },
    provide(field) {
      return EditorView.decorations.from(field);
    },
  });

  return [widgetField];
}
