import { autocompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  setSearchQuery,
} from '@codemirror/search';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  type Panel,
  placeholder as placeholderExt,
  type ViewUpdate,
} from '@codemirror/view';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getStoredScrollPosition, setStoredScrollPosition } from '../scroll_positions';
import { Eye } from 'lucide-react';
import { CodeMirrorSearchPanel } from './CodeMirrorSearchPanel';
import { continuedIndentExtension } from './codemirror_continued_indent';
import { emojiCompletionSource } from './codemirror_emoji_completion';
import { fencedCodeLineClassExtension } from './codemirror_fenced_code_lines';
import { type InlinePromptRequest, inlinePromptCompletionSource } from './codemirror_inline_prompt';
import { markdownEditorLanguageSupport, promptListAnsweringFacet } from './codemirror_markdown';
import { appCodeMirrorHighlighter } from './codemirror_theme';
import type { EditorController } from './editor_controller';
import {
  acceptBracePromptSelectionOnEnter,
  backspacePromptQuestionMarker,
  buildExternalContentSyncTransaction,
  buildExternalEditorChangeTransaction,
  getPromptListRequest,
  insertNewlineContinueLooseListItem,
  insertNewlineContinuePromptAnswer,
  insertNewlineContinuePromptComment,
  insertNewlineExitBlockquote,
  insertNewlineExitPromptQuestion,
  isExternalSyncTransaction,
  type PromptListRequest,
  wrapWithMarker,
} from './markdown_editor_commands';
import {
  type BracePromptStreamFn,
  bracePromptPreviewExtension,
  canBracePromptGenerateMore,
  useBracePromptPanel,
} from './use_brace_prompt_panel';

interface MarkdownEditorProps {
  content: string;
  contentOrigin?: 'userEdits' | 'external' | 'streaming' | 'appEdits';
  contentRevision?: number;
  contentSelection?: { anchor: number; head: number } | null;
  onContentChange: (update: { content: string; origin: 'userEdits'; revision: number }) => void;
  onInlinePromptSubmit?: (request: InlinePromptRequest) => void;
  onBracePromptStream?: BracePromptStreamFn;
  onPromptListSubmit?: (request: PromptListRequest) => void;
  onCancelInlinePrompt?: () => void;
  inlinePromptActive?: boolean;
  onPaste?: (event: ClipboardEvent, view: EditorView) => void;
  readOnly?: boolean;
  placeholder?: string;
  scrollStorageKey?: string | null;
  onEditorReady?: (controller: EditorController | null) => void;
  onEligibleSelectionChange?: (eligible: boolean) => void;
  class?: string;
}

function createHiddenSearchPanel(): Panel {
  const dom = document.createElement('div');
  dom.hidden = true;
  dom.setAttribute('aria-hidden', 'true');
  return { dom };
}

export function MarkdownEditor({
  content,
  contentOrigin = 'external',
  contentRevision = 0,
  contentSelection = null,
  onContentChange,
  onInlinePromptSubmit,
  onBracePromptStream,
  onPromptListSubmit,
  onCancelInlinePrompt,
  inlinePromptActive = false,
  onPaste,
  readOnly = false,
  placeholder = 'Write here, or use ~ to prompt...',
  scrollStorageKey = null,
  onEditorReady,
  onEligibleSelectionChange,
  class: className,
}: MarkdownEditorProps) {
  const STREAMING_CURSOR_VIEWPORT_MARGIN_PX = 72;
  const SEARCH_SCROLL_MARGIN_PX = 80;
  const rootRef = useRef<HTMLDivElement>(null);
  const bracePromptPanelRef = useRef<HTMLDivElement>(null);
  const bracePromptChatInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const editorControllerRef = useRef<EditorController | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const placeholderCompartment = useRef(new Compartment());
  const promptListAnsweringCompartment = useRef(new Compartment());
  const bracePromptPreviewCompartment = useRef(new Compartment());
  const currentScrollStorageKeyRef = useRef<string | null>(scrollStorageKey);
  const pendingScrollRestoreKeyRef = useRef<string | null>(null);
  const restoreScrollPositionRef = useRef<(() => void) | null>(null);
  const streamingCursorPositionRef = useRef<number | null>(null);
  const streamingCursorFollowingRef = useRef(false);
  const ignoreNextStreamingScrollEventRef = useRef(false);
  const hasPendingLocalEditsRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQueryState] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [replaceText, setReplaceTextState] = useState('');
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const searchCaseSensitiveRef = useRef(searchCaseSensitive);
  searchCaseSensitiveRef.current = searchCaseSensitive;
  const replaceTextRef = useRef(replaceText);
  replaceTextRef.current = replaceText;
  const openSearchRef = useRef<(view: EditorView) => boolean>(() => false);

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onInlinePromptSubmitRef = useRef(onInlinePromptSubmit);
  onInlinePromptSubmitRef.current = onInlinePromptSubmit;
  const onBracePromptStreamRef = useRef(onBracePromptStream);
  onBracePromptStreamRef.current = onBracePromptStream;
  const onPromptListSubmitRef = useRef(onPromptListSubmit);
  onPromptListSubmitRef.current = onPromptListSubmit;
  const onCancelInlinePromptRef = useRef(onCancelInlinePrompt);
  onCancelInlinePromptRef.current = onCancelInlinePrompt;
  const inlinePromptActiveRef = useRef(inlinePromptActive);
  inlinePromptActiveRef.current = inlinePromptActive;
  const onPasteRef = useRef(onPaste);
  onPasteRef.current = onPaste;
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const onEligibleSelectionChangeRef = useRef(onEligibleSelectionChange);
  onEligibleSelectionChangeRef.current = onEligibleSelectionChange;

  const latestLocalRevisionRef = useRef(0);

  const reportEligibleSelection = (view: EditorView) => {
    const selection = view.state.selection.main;
    const eligible =
      !selection.empty &&
      selection.to - selection.from <= 5000 &&
      view.state.sliceDoc(selection.from, selection.to).trim().length > 0;
    onEligibleSelectionChangeRef.current?.(eligible);
  };

  const bracePrompt = useBracePromptPanel({
    rootRef,
    onBracePromptStreamRef,
  });

  const readScrollPosition = (view: EditorView): number => {
    return editorUsesOwnScroll(view) ? view.scrollDOM.scrollTop : window.scrollY;
  };

  const getTopVisibleText = (view: EditorView, maxChars = 240): string | null => {
    const viewportTop = editorUsesOwnScroll(view)
      ? view.scrollDOM.scrollTop
      : Math.max(0, -view.scrollDOM.getBoundingClientRect().top);
    let position = clampPosition(view, view.lineBlockAtHeight(Math.max(0, viewportTop + 4)).from);
    let combined = '';
    let scannedLines = 0;
    let capturedLines = 0;

    while (position < view.state.doc.length && scannedLines < 8 && capturedLines < 3 && combined.length < maxChars) {
      const line = view.state.doc.lineAt(position);
      const text = line.text.trim();
      if (text.length > 0) {
        combined += `${combined ? '\n' : ''}${text}`;
        capturedLines += 1;
      }
      scannedLines += 1;
      position = line.to + 1;
    }

    const trimmed = combined.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxChars);
  };

  const getViewportAnchorPosition = (view: EditorView, anchorRatio = 0.3): number => {
    const clampedRatio = Math.min(1, Math.max(0, anchorRatio));
    const anchorY = editorUsesOwnScroll(view)
      ? view.scrollDOM.scrollTop + view.scrollDOM.clientHeight * clampedRatio
      : Math.max(0, -view.scrollDOM.getBoundingClientRect().top) + window.innerHeight * clampedRatio;
    const lineBlock = view.lineBlockAtHeight(Math.max(0, anchorY));
    const blockHeight = Math.max(1, lineBlock.height);
    const fraction = Math.max(0, Math.min(1, (anchorY - lineBlock.top) / blockHeight));
    const lineLength = lineBlock.to - lineBlock.from;
    return clampPosition(view, lineBlock.from + Math.round(fraction * lineLength));
  };

  const clampPosition = (view: EditorView, position: number): number => {
    return Math.max(0, Math.min(position, view.state.doc.length));
  };

  const applySearchQuery = (view: EditorView, query: string, caseSensitive: boolean, replace = '') => {
    const next = new SearchQuery({ search: query, caseSensitive, replace });
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
    if (viewRef.current) closeSearchPanel(viewRef.current);
    viewRef.current?.focus();
  };

  const editorUsesOwnScroll = (view: EditorView): boolean => {
    return view.scrollDOM.scrollHeight > view.scrollDOM.clientHeight + 1;
  };

  const scrollWindowToKeepPositionVisible = (view: EditorView, position: number) => {
    const coords = view.coordsAtPos(clampPosition(view, position));
    if (!coords) return;
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const targetTop = coords.top + window.scrollY;
    const targetBottom = coords.bottom + window.scrollY;
    const minVisibleTop = viewportTop + STREAMING_CURSOR_VIEWPORT_MARGIN_PX;
    const maxVisibleBottom = viewportBottom - STREAMING_CURSOR_VIEWPORT_MARGIN_PX;

    if (targetBottom > maxVisibleBottom) {
      window.scrollTo({ top: Math.max(0, targetBottom - window.innerHeight + STREAMING_CURSOR_VIEWPORT_MARGIN_PX) });
      return;
    }
    if (targetTop < minVisibleTop) {
      window.scrollTo({ top: Math.max(0, targetTop - STREAMING_CURSOR_VIEWPORT_MARGIN_PX) });
    }
  };

  const scrollPositionToViewportAnchor = (view: EditorView, position: number, anchorRatio = 0.3) => {
    const clampedRatio = Math.min(1, Math.max(0, anchorRatio));
    const clampedPosition = clampPosition(view, position);
    if (editorUsesOwnScroll(view)) {
      const block = view.lineBlockAt(clampedPosition);
      view.scrollDOM.scrollTop = Math.max(0, block.top - view.scrollDOM.clientHeight * clampedRatio);
      return;
    }
    const coords = view.coordsAtPos(clampedPosition);
    if (!coords) return;
    window.scrollTo({ top: Math.max(0, coords.top + window.scrollY - window.innerHeight * clampedRatio) });
  };

  const isPositionNearViewport = (view: EditorView, position: number): boolean => {
    const clampedPosition = clampPosition(view, position);
    if (!editorUsesOwnScroll(view)) {
      const coords = view.coordsAtPos(clampedPosition);
      if (!coords) return true;
      return (
        coords.top >= STREAMING_CURSOR_VIEWPORT_MARGIN_PX &&
        coords.bottom <= window.innerHeight - STREAMING_CURSOR_VIEWPORT_MARGIN_PX
      );
    }
    const lineBlock = view.lineBlockAt(clampedPosition);
    const viewportTop = view.scrollDOM.scrollTop;
    const viewportBottom = viewportTop + view.scrollDOM.clientHeight;
    const blockTop = lineBlock.top;
    const blockBottom = lineBlock.top + lineBlock.height;
    return (
      blockTop >= viewportTop - STREAMING_CURSOR_VIEWPORT_MARGIN_PX &&
      blockBottom <= viewportBottom + STREAMING_CURSOR_VIEWPORT_MARGIN_PX
    );
  };

  const scrollStreamingCursorIntoView = (view: EditorView, position: number) => {
    ignoreNextStreamingScrollEventRef.current = true;
    if (editorUsesOwnScroll(view)) {
      view.dispatch({
        effects: EditorView.scrollIntoView(clampPosition(view, position), {
          y: 'end',
          yMargin: STREAMING_CURSOR_VIEWPORT_MARGIN_PX,
        }),
      });
    } else {
      scrollWindowToKeepPositionVisible(view, position);
    }
    window.requestAnimationFrame(() => {
      ignoreNextStreamingScrollEventRef.current = false;
    });
  };

  openSearchRef.current = (view: EditorView) => {
    openSearchPanel(view);
    const selection = view.state.selection.main;
    const selectedText =
      !selection.empty && selection.to - selection.from <= 200 ? view.state.sliceDoc(selection.from, selection.to) : '';
    const currentSearchQuery = getSearchQuery(view.state);
    const nextQuery = selectedText && !selectedText.includes('\n') ? selectedText : currentSearchQuery.search;
    const nextCaseSensitive = currentSearchQuery.caseSensitive;
    const nextReplace = currentSearchQuery.replace;
    setSearchQueryState(nextQuery);
    setSearchCaseSensitive(nextCaseSensitive);
    setReplaceTextState(nextReplace);
    setSearchOpen(true);
    applySearchQuery(view, nextQuery, nextCaseSensitive, nextReplace);
    focusSearchInput();
    return true;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect; content/readOnly/placeholder synced via separate effects
  useEffect(() => {
    if (!containerRef.current) return;

    const onUpdate = (update: ViewUpdate) => {
      if (update.selectionSet || update.docChanged) {
        reportEligibleSelection(update.view);
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.heightChanged
      ) {
        bracePrompt.syncValidity(update.view);
      }
      if (!update.docChanged) return;
      if (update.transactions.every((tr) => isExternalSyncTransaction(tr))) return;
      const doc = update.state.doc.toString();
      const revision = latestLocalRevisionRef.current + 1;
      latestLocalRevisionRef.current = revision;
      hasPendingLocalEditsRef.current = true;
      onContentChangeRef.current({ content: doc, origin: 'userEdits', revision });
    };

    const state = EditorState.create({
      doc: content,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        syntaxHighlighting(appCodeMirrorHighlighter),
        bracketMatching(),
        autocompletion({
          override: [
            inlinePromptCompletionSource((request) => onInlinePromptSubmitRef.current?.(request)),
            emojiCompletionSource,
          ],
        }),
        markdownEditorLanguageSupport(),
        search({
          createPanel: () => createHiddenSearchPanel(),
          scrollToMatch: (range) => EditorView.scrollIntoView(range, { yMargin: SEARCH_SCROLL_MARGIN_PX }),
        }),
        highlightSelectionMatches(),
        promptListAnsweringCompartment.current.of(promptListAnsweringFacet.of(inlinePromptActive)),
        bracePromptPreviewCompartment.current.of([]),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        placeholderCompartment.current.of(placeholderExt(placeholder)),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        fencedCodeLineClassExtension,
        continuedIndentExtension({ mode: 'markdown', maxColumns: 10 }),
        EditorView.updateListener.of(onUpdate),
        EditorView.domEventHandlers({
          paste: (event, view) => {
            onPasteRef.current?.(event, view);
          },
          keydown: (event) => {
            if (!bracePrompt.isActive()) return false;
            if (event.key === 'ArrowDown') {
              bracePrompt.moveSelection(1);
              event.preventDefault();
              return true;
            }
            if (event.key === 'ArrowUp') {
              bracePrompt.moveSelection(-1);
              event.preventDefault();
              return true;
            }
            if (event.key === 'Escape') {
              bracePrompt.close();
              event.preventDefault();
              return true;
            }
            if (event.key === '/') {
              const chatInput = bracePromptChatInputRef.current;
              if (chatInput) {
                event.preventDefault();
                chatInput.focus();
                return true;
              }
            }
            return false;
          },
        }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-f',
              run: (view) => openSearchRef.current(view),
              preventDefault: true,
            },
            { key: 'Mod-b', run: (view) => wrapWithMarker(view, '**') },
            { key: 'Mod-i', run: (view) => wrapWithMarker(view, '*') },
            {
              key: 'Tab',
              run: (view) => {
                if (bracePrompt.isActive()) {
                  if ((bracePrompt.getPanel()?.options.length ?? 0) === 0) return true;
                  return bracePrompt.acceptSelection(view);
                }
                return bracePrompt.start(view);
              },
              shift: (view) => {
                if (bracePrompt.isActive()) return bracePrompt.loadMore(view) || true;
                return bracePrompt.start(view, { includeParagraphTail: true }) || indentLess(view);
              },
            },
            { key: 'ArrowDown', run: () => bracePrompt.moveSelection(1) },
            { key: 'ArrowUp', run: () => bracePrompt.moveSelection(-1) },
            {
              key: 'Enter',
              run: (view) => {
                if (acceptBracePromptSelectionOnEnter(view, bracePrompt)) return true;
                const request = getPromptListRequest(view.state);
                if (!request) return false;
                onPromptListSubmitRef.current?.(request);
                return true;
              },
            },
            { key: 'Enter', run: insertNewlineExitPromptQuestion },
            { key: 'Enter', run: insertNewlineContinuePromptAnswer },
            { key: 'Enter', run: insertNewlineContinuePromptComment },
            {
              key: 'Escape',
              run: () => {
                if (bracePrompt.isActive()) {
                  bracePrompt.close();
                  return true;
                }
                if (!inlinePromptActiveRef.current) return false;
                onCancelInlinePromptRef.current?.();
                return true;
              },
            },
            { key: 'Enter', run: insertNewlineExitBlockquote },
            { key: 'Enter', run: insertNewlineContinueLooseListItem },
            { key: 'Backspace', run: backspacePromptQuestionMarker },
            { key: 'Tab', run: indentMore, shift: indentLess },
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
            ...historyKeymap,
          ]),
        ),
        keymap.of(defaultKeymap),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    currentScrollStorageKeyRef.current = scrollStorageKey;
    editorControllerRef.current = {
      applyExternalChange: (change) => {
        const transaction = buildExternalEditorChangeTransaction(view.state, change);
        if (!transaction) return false;
        view.dispatch(transaction);
        return true;
      },
      getSelectionText: (maxChars) => {
        const selection = view.state.selection.main;
        if (selection.empty) return null;
        const selected = view.state.sliceDoc(selection.from, selection.to);
        if (typeof maxChars === 'number' && selected.length > maxChars) return null;
        return selected;
      },
      getTopVisibleText: (maxChars) => getTopVisibleText(view, maxChars),
      getViewportAnchorPosition: (anchorRatio) => getViewportAnchorPosition(view, anchorRatio),
      scrollToPosition: (position, anchorRatio) => {
        scrollPositionToViewportAnchor(view, position, anchorRatio);
      },
      startStreamingCursorTracking: (position) => {
        const clampedPosition = clampPosition(view, position);
        streamingCursorPositionRef.current = clampedPosition;
        streamingCursorFollowingRef.current = isPositionNearViewport(view, clampedPosition);
        if (streamingCursorFollowingRef.current) {
          scrollStreamingCursorIntoView(view, clampedPosition);
        }
      },
      updateStreamingCursorTracking: (position) => {
        if (streamingCursorPositionRef.current == null) return;
        const clampedPosition = clampPosition(view, position);
        streamingCursorPositionRef.current = clampedPosition;
        if (!streamingCursorFollowingRef.current) return;
        scrollStreamingCursorIntoView(view, clampedPosition);
      },
      stopStreamingCursorTracking: () => {
        streamingCursorPositionRef.current = null;
        streamingCursorFollowingRef.current = false;
        ignoreNextStreamingScrollEventRef.current = false;
      },
    };
    onEditorReadyRef.current?.(editorControllerRef.current);
    reportEligibleSelection(view);

    restoreScrollPositionRef.current = () => {
      if (streamingCursorPositionRef.current != null) return;
      const key = currentScrollStorageKeyRef.current;
      const nextScrollTop = key ? (getStoredScrollPosition(key) ?? 0) : 0;
      const useEditorScroll = editorUsesOwnScroll(view);
      window.requestAnimationFrame(() => {
        if (viewRef.current !== view || streamingCursorPositionRef.current != null) return;
        if (useEditorScroll) {
          view.scrollDOM.scrollTop = nextScrollTop;
        } else {
          window.scrollTo({ top: nextScrollTop });
        }
      });
    };

    const syncScrollPosition = () => {
      bracePrompt.syncLayout(view);
      if (streamingCursorPositionRef.current != null && !ignoreNextStreamingScrollEventRef.current) {
        streamingCursorFollowingRef.current = isPositionNearViewport(view, streamingCursorPositionRef.current);
      }
      const key = currentScrollStorageKeyRef.current;
      if (!key) return;
      setStoredScrollPosition(key, readScrollPosition(view));
    };
    view.scrollDOM.addEventListener('scroll', syncScrollPosition, { passive: true });
    window.addEventListener('scroll', syncScrollPosition, { passive: true });

    const persistOnPageHide = () => {
      syncScrollPosition();
    };
    window.addEventListener('pagehide', persistOnPageHide);
    window.addEventListener('beforeunload', persistOnPageHide);

    restoreScrollPositionRef.current();

    return () => {
      syncScrollPosition();
      view.scrollDOM.removeEventListener('scroll', syncScrollPosition);
      window.removeEventListener('scroll', syncScrollPosition);
      window.removeEventListener('pagehide', persistOnPageHide);
      window.removeEventListener('beforeunload', persistOnPageHide);
      restoreScrollPositionRef.current = null;
      editorControllerRef.current = null;
      bracePrompt.destroy();
      streamingCursorPositionRef.current = null;
      streamingCursorFollowingRef.current = false;
      ignoreNextStreamingScrollEventRef.current = false;
      onEligibleSelectionChangeRef.current?.(false);
      onEditorReadyRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    onEditorReady?.(editorControllerRef.current);
  }, [onEditorReady]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (bracePrompt.isActive()) bracePrompt.close();
    const currentDoc = view.state.doc.toString();
    const selection = view.state.selection.main;
    if (content === currentDoc) {
      hasPendingLocalEditsRef.current = false;
      if (pendingScrollRestoreKeyRef.current === scrollStorageKey) pendingScrollRestoreKeyRef.current = null;
      return;
    }
    if (hasPendingLocalEditsRef.current) return;
    if (contentOrigin === 'userEdits' && contentRevision <= latestLocalRevisionRef.current) return;
    if (contentOrigin === 'streaming') return;
    if (streamingCursorPositionRef.current != null && contentOrigin === 'external') return;

    console.warn('[editor-sync] applying external content while docs differ', {
      contentOrigin,
      contentRevision,
      latestLocalRevision: latestLocalRevisionRef.current,
      currentDocLength: currentDoc.length,
      incomingLength: content.length,
      selection: {
        anchor: selection.anchor,
        head: selection.head,
        from: selection.from,
        to: selection.to,
      },
      currentAroundCaret: currentDoc.slice(Math.max(0, selection.head - 20), selection.head + 20),
      incomingAroundCaret: content.slice(Math.max(0, selection.head - 20), selection.head + 20),
    });

    const transaction = buildExternalContentSyncTransaction(view.state, content, contentSelection);
    if (!transaction) return;
    view.dispatch(transaction);
    hasPendingLocalEditsRef.current = false;

    if (pendingScrollRestoreKeyRef.current === scrollStorageKey) {
      pendingScrollRestoreKeyRef.current = null;
    }
    restoreScrollPositionRef.current?.();
  }, [
    bracePrompt.close,
    bracePrompt.isActive,
    content,
    contentOrigin,
    contentRevision,
    contentSelection,
    scrollStorageKey,
  ]);

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
    hasPendingLocalEditsRef.current = false;
    restoreScrollPositionRef.current?.();
  }, [scrollStorageKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (readOnly) bracePrompt.close();
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [bracePrompt.close, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: promptListAnsweringCompartment.current.reconfigure(promptListAnsweringFacet.of(inlinePromptActive)),
    });
  }, [inlinePromptActive]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure(placeholderExt(placeholder)),
    });
  }, [placeholder]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const preview = bracePrompt.getPreview();
    view.dispatch({
      effects: bracePromptPreviewCompartment.current.reconfigure(bracePromptPreviewExtension(preview)),
    });
  }, [bracePrompt.getPreview]);

  useEffect(() => {
    if (!bracePrompt.panel) return;
    const sync = () => {
      const view = viewRef.current;
      if (!view) return;
      bracePrompt.syncValidity(view);
    };
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [bracePrompt.panel, bracePrompt.syncValidity]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: helper is stable enough for this local sync effect
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQuery, searchCaseSensitive, replaceText);
  }, [replaceText, searchCaseSensitive, searchQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: helper only forwards focus to the current input ref
  useEffect(() => {
    if (!searchOpen) return;
    focusSearchInput();
  }, [searchOpen]);

  const showGenerateMore = bracePrompt.panel ? canBracePromptGenerateMore(bracePrompt.panel) : false;

  const goToNextMatch = () => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current, replaceTextRef.current);
    if (!searchQueryRef.current) return;
    findNext(view);
  };

  const goToPreviousMatch = () => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current, replaceTextRef.current);
    if (!searchQueryRef.current) return;
    findPrevious(view);
  };

  const replaceCurrentMatch = () => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current, replaceTextRef.current);
    if (!searchQueryRef.current) return;
    replaceNext(view);
  };

  const replaceAllMatches = () => {
    const view = viewRef.current;
    if (!view) return;
    applySearchQuery(view, searchQueryRef.current, searchCaseSensitiveRef.current, replaceTextRef.current);
    if (!searchQueryRef.current) return;
    replaceAll(view);
  };

  // Measure the brace-prompt panel after first render and flip above cursor if it overflows.
  // Direction is locked for the lifetime of the panel (won't re-flip as options stream in).
  useLayoutEffect(() => {
    const panel = bracePrompt.panel;
    const el = bracePromptPanelRef.current;
    const root = rootRef.current;
    if (!panel || !el || !root || panel.flipped) return;
    const rootRect = root.getBoundingClientRect();
    const panelRect = el.getBoundingClientRect();
    if (panelRect.bottom > rootRect.bottom && panelRect.bottom > window.innerHeight) {
      bracePrompt.setFlipped(true);
    }
  }, [bracePrompt.panel?.request.from, bracePrompt.panel?.request.to, bracePrompt.panel?.flipped]);

  return (
    <div ref={rootRef} class={`doc-editor-shell${className ? ` ${className}` : ''}`}>
      {searchOpen ? (
        <CodeMirrorSearchPanel
          query={searchQuery}
          caseSensitive={searchCaseSensitive}
          inputRef={searchInputRef}
          replaceValue={replaceText}
          replaceInputRef={replaceInputRef}
          onQueryChange={setSearchQueryState}
          onReplaceChange={setReplaceTextState}
          onToggleCaseSensitive={() => setSearchCaseSensitive((value) => !value)}
          onNext={goToNextMatch}
          onPrevious={goToPreviousMatch}
          onReplace={replaceCurrentMatch}
          onReplaceAll={replaceAllMatches}
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
          onReplaceKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSearch();
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey) {
                replaceAllMatches();
              } else {
                replaceCurrentMatch();
              }
            }
          }}
        />
      ) : null}
      <div ref={containerRef} class="doc-editor-shell__editor" />
      {bracePrompt.panel ? (
        <div
          ref={bracePromptPanelRef}
          class="brace-prompt-panel"
          style={bracePrompt.panel.flipped
            ? {
                bottom: `calc(100% - ${bracePrompt.panel.cursorTop - 8}px)`,
                left: `${bracePrompt.panel.left}px`,
                maxWidth: `${bracePrompt.panel.maxWidth}px`,
              }
            : {
                top: `${bracePrompt.panel.top}px`,
                left: `${bracePrompt.panel.left}px`,
                maxWidth: `${bracePrompt.panel.maxWidth}px`,
              }
          }
          role="listbox"
          aria-label="AI completions"
        >
          {bracePrompt.panel.request.mode === 'replace-with-paragraph-tail' ? (
            <div class="brace-prompt-panel__header">Used full paragraph as context</div>
          ) : null}
          <div class="brace-prompt-panel__options">
            {bracePrompt.panel.options.map((option, index) => (
              <div
                key={`${bracePrompt.panel!.request.from}:${index}:${option}`}
                class={`brace-prompt-panel__option${index === bracePrompt.panel!.selectedIndex ? ' is-selected' : ''}`}
              >
                <button
                  type="button"
                  class="brace-prompt-panel__option-label"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const view = viewRef.current;
                    if (!view) return;
                    bracePrompt.acceptSelection(view, index);
                    view.focus();
                  }}
                >
                  {option}
                </button>
                <button
                  type="button"
                  class="brace-prompt-panel__option-preview"
                  aria-label="Preview"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    bracePrompt.scheduleHoverPreview(index);
                  }}
                >
                  <Eye size={13} />
                </button>
              </div>
            ))}
            {bracePrompt.panel.draftOption ? (
              <div class="brace-prompt-panel__option brace-prompt-panel__option--draft">
                {bracePrompt.panel.draftOption}
              </div>
            ) : null}
            {bracePrompt.panel.loading ? (
              <div class="brace-prompt-panel__status">
                <span class="editor-loading-spinner brace-prompt-panel__spinner" aria-hidden="true" />
              </div>
            ) : null}
            {showGenerateMore ? (
              <button
                type="button"
                class={`brace-prompt-panel__option brace-prompt-panel__option--action brace-prompt-panel__option--close${
                  bracePrompt.panel.selectedIndex === bracePrompt.panel.options.length ? ' is-selected' : ''
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const view = viewRef.current;
                  if (!view) return;
                  bracePrompt.loadMore(view);
                }}
              >
                Generate more
                <span class="brace-prompt-panel__option-caption">Shift-Tab</span>
              </button>
            ) : null}
            <button
              type="button"
              class={`brace-prompt-panel__option brace-prompt-panel__option--action brace-prompt-panel__option--close${
                bracePrompt.panel.selectedIndex === bracePrompt.panel.options.length + (showGenerateMore ? 1 : 0)
                  ? ' is-selected'
                  : ''
              }`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const view = viewRef.current;
                if (view) view.focus();
                bracePrompt.close();
              }}
            >
              Close
              <span class="brace-prompt-panel__option-caption">Esc</span>
            </button>
            {!bracePrompt.panel.loading ? (
              <div class="brace-prompt-panel__chat">
                <input
                  ref={bracePromptChatInputRef}
                  type="text"
                  class="brace-prompt-panel__chat-input"
                  placeholder="Ask for specific completions"
                  value={bracePrompt.panel.chatInputValue}
                  onInput={(e) => {
                    bracePrompt.setChatInputValue((e.target as HTMLInputElement).value);
                  }}
                  onKeyDown={(e) => {
                    const input = e.target as HTMLInputElement;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const val = input.value.trim();
                      if (!val) return;
                      const view = viewRef.current;
                      if (view) bracePrompt.refine(view, val);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      if (input.value) {
                        bracePrompt.setChatInputValue('');
                      } else {
                        bracePrompt.close();
                        viewRef.current?.focus();
                      }
                    } else if (e.key === 'Tab') {
                      e.preventDefault();
                    } else if (e.key === 'ArrowUp') {
                      if (input.selectionStart === 0 && input.selectionEnd === 0) {
                        e.preventDefault();
                        input.blur();
                        viewRef.current?.focus();
                      }
                    }
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              </div>
            ) : null}
            {bracePrompt.panel.error ? (
              <div class="brace-prompt-panel__status brace-prompt-panel__status--error">Couldn't load suggestions</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
