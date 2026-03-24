import { syntaxHighlighting } from '@codemirror/language';
import {
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  SearchQuery,
  search,
  setSearchQuery,
} from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getStoredScrollPosition, setStoredScrollPosition } from '../scroll_positions';
import { CodeMirrorSearchPanel } from './CodeMirrorSearchPanel';
import { continuedIndentExtension } from './codemirror_continued_indent';
import { detectedLanguageForFileName } from './codemirror_languages';
import { appCodeMirrorHighlighter } from './codemirror_theme';

interface TextCodeViewProps {
  content: string;
  fileName?: string | null;
  scrollStorageKey?: string | null;
}

export function TextCodeView({ content, fileName = null, scrollStorageKey = null }: TextCodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const languageCompartmentRef = useRef(new Compartment());
  const initialContentRef = useRef(content);
  const initialFileNameRef = useRef(fileName);
  const initialScrollStorageKeyRef = useRef(scrollStorageKey);
  const currentScrollStorageKeyRef = useRef<string | null>(scrollStorageKey);
  const pendingScrollRestoreKeyRef = useRef<string | null>(null);
  const restoreScrollPositionRef = useRef<(() => void) | null>(null);
  const detectedLanguage = detectedLanguageForFileName(fileName);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQueryState] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const searchCaseSensitiveRef = useRef(searchCaseSensitive);
  searchCaseSensitiveRef.current = searchCaseSensitive;
  const openSearchRef = useRef<(view: EditorView) => boolean>(() => false);

  const applySearchQuery = (view: EditorView, query: string, caseSensitive: boolean) => {
    const next = new SearchQuery({ search: query, caseSensitive });
    if (!getSearchQuery(view.state).eq(next)) {
      view.dispatch({ effects: setSearchQuery.of(next) });
    }
  };

  const focusSearchInput = () => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    viewRef.current?.focus();
  };

  openSearchRef.current = (view: EditorView) => {
    const selection = view.state.selection.main;
    const selectedText =
      !selection.empty && selection.to - selection.from <= 200 ? view.state.sliceDoc(selection.from, selection.to) : '';
    const nextQuery = selectedText && !selectedText.includes('\n') ? selectedText : getSearchQuery(view.state).search;
    const nextCaseSensitive = getSearchQuery(view.state).caseSensitive;
    setSearchQueryState(nextQuery);
    setSearchCaseSensitive(nextCaseSensitive);
    setSearchOpen(true);
    applySearchQuery(view, nextQuery, nextCaseSensitive);
    focusSearchInput();
    return true;
  };

  // Create viewer on mount; content and language changes are synced in separate effects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect; search handlers read latest state through refs
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: initialContentRef.current,
      extensions: [
        highlightSpecialChars(),
        syntaxHighlighting(appCodeMirrorHighlighter, { fallback: true }),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        search(),
        highlightSelectionMatches(),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        continuedIndentExtension({ mode: 'indent', maxColumns: 10 }),
        keymap.of([
          {
            key: 'Mod-f',
            run: (view) => openSearchRef.current(view),
            preventDefault: true,
          },
          {
            key: 'F3',
            run: (view) => {
              if (!searchQueryRef.current) return openSearchRef.current(view);
              applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current);
              return findNext(view);
            },
            shift: (view) => {
              if (!searchQueryRef.current) return openSearchRef.current(view);
              applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current);
              return findPrevious(view);
            },
            preventDefault: true,
          },
          {
            key: 'Mod-g',
            run: (view) => {
              if (!searchQueryRef.current) return openSearchRef.current(view);
              applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current);
              return findNext(view);
            },
            shift: (view) => {
              if (!searchQueryRef.current) return openSearchRef.current(view);
              applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current);
              return findPrevious(view);
            },
            preventDefault: true,
          },
          {
            key: 'Tab',
            run: () => true,
          },
        ]),
        languageCompartmentRef.current.of(detectedLanguageForFileName(initialFileNameRef.current)?.extensions ?? []),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    currentScrollStorageKeyRef.current = initialScrollStorageKeyRef.current;

    restoreScrollPositionRef.current = () => {
      const key = currentScrollStorageKeyRef.current;
      const nextScrollTop = key ? (getStoredScrollPosition(key) ?? 0) : 0;
      window.requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        view.scrollDOM.scrollTop = nextScrollTop;
      });
    };

    const syncScrollPosition = () => {
      const key = currentScrollStorageKeyRef.current;
      if (!key) return;
      setStoredScrollPosition(key, view.scrollDOM.scrollTop);
    };
    view.scrollDOM.addEventListener('scroll', syncScrollPosition, { passive: true });

    restoreScrollPositionRef.current();

    return () => {
      syncScrollPosition();
      view.scrollDOM.removeEventListener('scroll', syncScrollPosition);
      restoreScrollPositionRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== content) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
      if (pendingScrollRestoreKeyRef.current === scrollStorageKey) {
        pendingScrollRestoreKeyRef.current = null;
      }
      restoreScrollPositionRef.current?.();
    } else if (pendingScrollRestoreKeyRef.current === scrollStorageKey) {
      pendingScrollRestoreKeyRef.current = null;
      restoreScrollPositionRef.current?.();
    }
  }, [content, scrollStorageKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      currentScrollStorageKeyRef.current = scrollStorageKey;
      return;
    }

    const previousKey = currentScrollStorageKeyRef.current;
    if (previousKey === scrollStorageKey) return;

    if (previousKey) {
      setStoredScrollPosition(previousKey, view.scrollDOM.scrollTop);
    }

    currentScrollStorageKeyRef.current = scrollStorageKey;
    pendingScrollRestoreKeyRef.current = scrollStorageKey;

    restoreScrollPositionRef.current?.();
  }, [scrollStorageKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(detectedLanguage?.extensions ?? []),
    });
  }, [detectedLanguage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: helper is stable enough for this local sync effect
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQuery, searchCaseSensitive);
  }, [searchCaseSensitive, searchQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: helper only forwards focus to the current input ref
  useEffect(() => {
    if (!searchOpen) return;
    focusSearchInput();
  }, [searchOpen]);

  const goToNextMatch = () => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current);
    if (!searchQueryRef.current) return;
    findNext(view);
  };

  const goToPreviousMatch = () => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current);
    if (!searchQueryRef.current) return;
    findPrevious(view);
  };

  return (
    <div class="content-code-view-wrap">
      {searchOpen ? (
        <CodeMirrorSearchPanel
          query={searchQuery}
          caseSensitive={searchCaseSensitive}
          inputRef={searchInputRef}
          onQueryChange={setSearchQueryState}
          onToggleCaseSensitive={() => setSearchCaseSensitive((value) => !value)}
          onNext={goToNextMatch}
          onPrevious={goToPreviousMatch}
          onClose={closeSearch}
          onQueryKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSearch();
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey) {
                goToPreviousMatch();
              } else {
                goToNextMatch();
              }
            }
          }}
        />
      ) : null}
      {detectedLanguage ? <div class="content-code-view-language-tag">{detectedLanguage.label}</div> : null}
      <div ref={containerRef} class="content-code-view" />
    </div>
  );
}
