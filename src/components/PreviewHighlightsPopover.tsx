import type { PreviewHighlightEntry } from './preview_highlights';

export function PreviewHighlightsPopoverContent({
  entries,
  onSelect,
}: {
  entries: PreviewHighlightEntry[];
  onSelect: (id: string) => void;
}) {
  return (
    <div class="editor-preview-highlights-popover">
      {entries.length > 0 ? (
        <div class="editor-preview-highlights-popover-list">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              class="editor-preview-highlights-popover-item"
              onClick={() => onSelect(entry.id)}
            >
              {entry.prefix ? <span class="editor-preview-highlights-popover-item-prefix">{entry.prefix}</span> : null}
              <span class="editor-preview-highlights-popover-item-copy">
                <span class="editor-preview-highlights-popover-item-text">{entry.text}</span>
                {entry.suffix ? (
                  <span class="editor-preview-highlights-popover-item-suffix">{entry.suffix}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div class="editor-preview-highlights-popover-empty">No highlights in this document.</div>
      )}
    </div>
  );
}
