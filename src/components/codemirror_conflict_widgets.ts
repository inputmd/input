import { type Extension, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface EditorConflictWidget {
  id: string;
  lineNumber: number;
  title: string;
  message: string;
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
}

function buildConflictWidgetDecorations(
  state: EditorView['state'],
  widgets: EditorConflictWidget[] | null,
  actions?: EditorConflictWidgetActions,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!Array.isArray(widgets) || widgets.length === 0) return builder.finish();
  for (const widget of widgets) {
    const lineNumber = Math.max(1, Math.min(state.doc.lines, Math.floor(widget.lineNumber)));
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
