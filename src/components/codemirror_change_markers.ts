import { type Extension, type RangeSet, RangeSetBuilder, StateField } from '@codemirror/state';
import { type EditorView, GutterMarker, gutter } from '@codemirror/view';
import { diffLines } from 'diff';

export interface EditorChangeMarker {
  lineNumber: number;
  kind?: 'add' | 'modify';
  deletedBefore?: boolean;
  deletedAfter?: boolean;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function upsertMarker(
  markers: Map<number, EditorChangeMarker>,
  lineNumber: number,
  update: Partial<Omit<EditorChangeMarker, 'lineNumber'>>,
): void {
  const current = markers.get(lineNumber) ?? { lineNumber };
  markers.set(lineNumber, {
    ...current,
    ...update,
    kind: update.kind === 'modify' || current.kind === 'modify' ? 'modify' : (update.kind ?? current.kind),
    deletedBefore: current.deletedBefore || update.deletedBefore || false,
    deletedAfter: current.deletedAfter || update.deletedAfter || false,
  });
}

function addDeleteAnchor(markers: Map<number, EditorChangeMarker>, lineNumber: number, side: 'top' | 'bottom'): void {
  upsertMarker(markers, lineNumber, side === 'top' ? { deletedBefore: true } : { deletedAfter: true });
}

export function buildEditorChangeMarkers(originalContent: string, modifiedContent: string): EditorChangeMarker[] {
  if (originalContent === modifiedContent) return [];

  const changes = diffLines(originalContent, modifiedContent);
  const markers = new Map<number, EditorChangeMarker>();
  const displayLineCount = Math.max(1, lineCount(modifiedContent));
  let newLine = 1;

  for (let index = 0; index < changes.length; index += 1) {
    const part = changes[index];
    if (!part) continue;
    const oldCount = part.removed ? lineCount(part.value) : 0;
    const newCount = part.added ? lineCount(part.value) : 0;

    if (part.removed) {
      const next = changes[index + 1];
      if (next?.added) {
        const addedCount = lineCount(next.value);
        const overlap = Math.min(oldCount, addedCount);
        for (let offset = 0; offset < overlap; offset += 1) {
          upsertMarker(markers, newLine + offset, { kind: 'modify' });
        }
        for (let offset = overlap; offset < addedCount; offset += 1) {
          upsertMarker(markers, newLine + offset, { kind: 'add' });
        }
        if (oldCount > overlap) {
          const anchorLine = Math.min(newLine + overlap, displayLineCount);
          addDeleteAnchor(markers, Math.max(1, anchorLine), newLine + overlap > displayLineCount ? 'bottom' : 'top');
        }
        newLine += addedCount;
        index += 1;
        continue;
      }

      const anchorLine = Math.min(newLine, displayLineCount);
      addDeleteAnchor(markers, Math.max(1, anchorLine), newLine > displayLineCount ? 'bottom' : 'top');
      continue;
    }

    if (part.added) {
      for (let offset = 0; offset < newCount; offset += 1) {
        upsertMarker(markers, newLine + offset, { kind: 'add' });
      }
      newLine += newCount;
      continue;
    }

    const unchangedCount = lineCount(part.value);
    newLine += unchangedCount;
  }

  return [...markers.values()]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((marker) => ({
      lineNumber: marker.lineNumber,
      ...(marker.kind ? { kind: marker.kind } : {}),
      ...(marker.deletedBefore ? { deletedBefore: true } : {}),
      ...(marker.deletedAfter ? { deletedAfter: true } : {}),
    }));
}

class ChangeMarkerGutterMarker extends GutterMarker {
  readonly marker: EditorChangeMarker;

  constructor(marker: EditorChangeMarker) {
    super();
    this.marker = marker;
  }

  eq(other: ChangeMarkerGutterMarker): boolean {
    return (
      this.marker.lineNumber === other.marker.lineNumber &&
      this.marker.kind === other.marker.kind &&
      this.marker.deletedBefore === other.marker.deletedBefore &&
      this.marker.deletedAfter === other.marker.deletedAfter
    );
  }

  toDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'cm-change-marker';
    const labels: string[] = [];
    if (this.marker.kind === 'add') labels.push('Added lines');
    if (this.marker.kind === 'modify') labels.push('Modified lines');
    if (this.marker.deletedBefore || this.marker.deletedAfter) labels.push('Deleted lines');
    if (labels.length > 0) {
      const label = labels.join(', ');
      element.setAttribute('aria-label', label);
      element.title = label;
    }

    if (this.marker.kind) {
      const bar = document.createElement('div');
      bar.className = `cm-change-marker__bar cm-change-marker__bar--${this.marker.kind}`;
      element.append(bar);
    }

    if (this.marker.deletedBefore) {
      const anchor = document.createElement('div');
      anchor.className = 'cm-change-marker__delete-anchor cm-change-marker__delete-anchor--top';
      element.append(anchor);
    }

    if (this.marker.deletedAfter) {
      const anchor = document.createElement('div');
      anchor.className = 'cm-change-marker__delete-anchor cm-change-marker__delete-anchor--bottom';
      element.append(anchor);
    }

    return element;
  }
}

class ChangeMarkerSpacer extends GutterMarker {
  toDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'cm-change-marker cm-change-marker--spacer';
    element.setAttribute('aria-hidden', 'true');
    return element;
  }
}

function buildChangeMarkerSet(
  state: EditorView['state'],
  markers: EditorChangeMarker[] | null,
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  if (!Array.isArray(markers) || markers.length === 0) return builder.finish();
  for (const marker of markers) {
    const lineNumber = Math.max(1, Math.min(state.doc.lines, Math.floor(marker.lineNumber)));
    const line = state.doc.line(lineNumber);
    builder.add(line.from, line.from, new ChangeMarkerGutterMarker(marker));
  }
  return builder.finish();
}

export function editorChangeMarkersExtension(markers: EditorChangeMarker[] | null): Extension {
  const markerField = StateField.define<RangeSet<GutterMarker>>({
    create(state) {
      return buildChangeMarkerSet(state, markers);
    },
    update(value, tr) {
      if (tr.docChanged) return value.map(tr.changes);
      return value;
    },
  });

  return [
    markerField,
    gutter({
      class: 'cm-change-marker-gutter',
      renderEmptyElements: false,
      initialSpacer: () => new ChangeMarkerSpacer(),
      markers: (view) => view.state.field(markerField),
    }),
  ];
}
