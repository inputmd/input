import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { RefObject } from 'preact';

interface CodeMirrorSearchPanelProps {
  query: string;
  caseSensitive: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onQueryChange: (value: string) => void;
  onToggleCaseSensitive: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export function CodeMirrorSearchPanel({
  query,
  caseSensitive,
  inputRef,
  onQueryChange,
  onToggleCaseSensitive,
  onNext,
  onPrevious,
  onClose,
  onKeyDown,
}: CodeMirrorSearchPanelProps) {
  return (
    <div class="codemirror-find-panel" role="search" aria-label="Find in document">
      <div class="codemirror-find-panel__field">
        <Search aria-hidden="true" size={16} strokeWidth={2.25} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Find"
          aria-label="Find"
          onInput={(event) => onQueryChange((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <button type="button" class="codemirror-find-panel__nav" onClick={onPrevious} aria-label="Previous match">
        <ChevronUp aria-hidden="true" size={16} strokeWidth={2.25} />
      </button>
      <button type="button" class="codemirror-find-panel__nav" onClick={onNext} aria-label="Next match">
        <ChevronDown aria-hidden="true" size={16} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        class={`codemirror-find-panel__toggle${caseSensitive ? ' is-active' : ''}`}
        onClick={onToggleCaseSensitive}
        aria-pressed={caseSensitive}
      >
        <span class="codemirror-find-panel__checkbox" aria-hidden="true">
          <span class={`codemirror-find-panel__checkbox-indicator${caseSensitive ? ' is-active' : ''}`} />
        </span>
        Case sensitive
      </button>
      <button type="button" class="codemirror-find-panel__close" onClick={onClose} aria-label="Close find">
        <X aria-hidden="true" size={14} strokeWidth={2.25} />
      </button>
    </div>
  );
}
