import { autocompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder as placeholderExt,
  type ViewUpdate,
} from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';
import { getStoredScrollPosition, setStoredScrollPosition } from '../scroll_positions';
import { continuedIndentExtension } from './codemirror_continued_indent';
import { emojiCompletionSource } from './codemirror_emoji_completion';
import { fencedCodeLineClassExtension } from './codemirror_fenced_code_lines';
import { type InlinePromptRequest, inlinePromptCompletionSource } from './codemirror_inline_prompt';
import { markdownEditorLanguageSupport, promptListAnsweringFacet } from './codemirror_markdown';
import { appCodeMirrorHighlighter } from './codemirror_theme';
import type { EditorController } from './editor_controller';
import {
  buildExternalContentSyncTransaction,
  buildExternalEditorChangeTransaction,
  getPromptListRequest,
  insertNewlineContinueLooseListItem,
  insertNewlineContinuePromptAnswer,
  insertNewlineExitBlockquote,
  insertNewlineExitPromptQuestion,
  isExternalSyncTransaction,
  type PromptListRequest,
  wrapWithMarker,
} from './markdown_editor_commands';

interface MarkdownEditorProps {
  content: string;
  contentOrigin?: 'local' | 'external';
  contentRevision?: number;
  contentSelection?: { anchor: number; head: number } | null;
  onContentChange: (update: { content: string; origin: 'local'; revision: number }) => void;
  onInlinePromptSubmit?: (request: InlinePromptRequest) => void;
  onPromptListSubmit?: (request: PromptListRequest) => void;
  onCancelInlinePrompt?: () => void;
  inlinePromptActive?: boolean;
  onPaste?: (event: ClipboardEvent, view: EditorView) => void;
  readOnly?: boolean;
  placeholder?: string;
  scrollStorageKey?: string | null;
  onEditorReady?: (controller: EditorController | null) => void;
  class?: string;
}

export function MarkdownEditor({
  content,
  contentOrigin = 'external',
  contentRevision = 0,
  contentSelection = null,
  onContentChange,
  onInlinePromptSubmit,
  onPromptListSubmit,
  onCancelInlinePrompt,
  inlinePromptActive = false,
  onPaste,
  readOnly = false,
  placeholder = 'Write your markdown here...',
  scrollStorageKey = null,
  onEditorReady,
  class: className,
}: MarkdownEditorProps) {
  const STREAMING_CURSOR_VIEWPORT_MARGIN_PX = 72;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editorControllerRef = useRef<EditorController | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const placeholderCompartment = useRef(new Compartment());
  const promptListAnsweringCompartment = useRef(new Compartment());
  const currentScrollStorageKeyRef = useRef<string | null>(scrollStorageKey);
  const pendingScrollRestoreKeyRef = useRef<string | null>(null);
  const restoreScrollPositionRef = useRef<(() => void) | null>(null);
  const streamingCursorPositionRef = useRef<number | null>(null);
  const streamingCursorFollowingRef = useRef(false);
  const ignoreNextStreamingScrollEventRef = useRef(false);

  // Stable refs for callbacks
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onInlinePromptSubmitRef = useRef(onInlinePromptSubmit);
  onInlinePromptSubmitRef.current = onInlinePromptSubmit;
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

  const latestLocalRevisionRef = useRef(0);

  const readScrollPosition = (view: EditorView): number => {
    return view.scrollDOM.scrollTop;
  };

  const clampPosition = (view: EditorView, position: number): number => {
    return Math.max(0, Math.min(position, view.state.doc.length));
  };

  const isPositionNearViewport = (view: EditorView, position: number): boolean => {
    const clampedPosition = clampPosition(view, position);
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
    view.dispatch({
      effects: EditorView.scrollIntoView(clampPosition(view, position), {
        y: 'end',
        yMargin: STREAMING_CURSOR_VIEWPORT_MARGIN_PX,
      }),
    });
    window.requestAnimationFrame(() => {
      ignoreNextStreamingScrollEventRef.current = false;
    });
  };

  // Create editor on mount — intentionally empty deps
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect; content/readOnly/placeholder synced via separate effects
  useEffect(() => {
    if (!containerRef.current) return;

    const onUpdate = (update: ViewUpdate) => {
      if (!update.docChanged) return;
      // Skip if this was our own external sync
      for (const tr of update.transactions) {
        if (isExternalSyncTransaction(tr)) return;
      }
      const doc = update.state.doc.toString();
      const revision = latestLocalRevisionRef.current + 1;
      latestLocalRevisionRef.current = revision;
      onContentChangeRef.current({ content: doc, origin: 'local', revision });
    };

    const state = EditorState.create({
      doc: content,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
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
        promptListAnsweringCompartment.current.of(promptListAnsweringFacet.of(inlinePromptActive)),
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
        }),
        Prec.high(
          keymap.of([
            { key: 'Mod-b', run: (view) => wrapWithMarker(view, '**') },
            { key: 'Mod-i', run: (view) => wrapWithMarker(view, '*') },
            {
              key: 'Enter',
              run: (view) => {
                const request = getPromptListRequest(view.state);
                if (!request) return false;
                onPromptListSubmitRef.current?.(request);
                return true;
              },
            },
            { key: 'Enter', run: insertNewlineExitPromptQuestion },
            { key: 'Enter', run: insertNewlineContinuePromptAnswer },
            {
              key: 'Escape',
              run: () => {
                if (!inlinePromptActiveRef.current) return false;
                onCancelInlinePromptRef.current?.();
                return true;
              },
            },
            { key: 'Enter', run: insertNewlineExitBlockquote },
            { key: 'Enter', run: insertNewlineContinueLooseListItem },
            { key: 'Tab', run: indentMore, shift: indentLess },
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

    restoreScrollPositionRef.current = () => {
      const key = currentScrollStorageKeyRef.current;
      const nextScrollTop = key ? (getStoredScrollPosition(key) ?? 0) : 0;
      window.requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        view.scrollDOM.scrollTop = nextScrollTop;
      });
    };

    const syncScrollPosition = () => {
      if (streamingCursorPositionRef.current != null && !ignoreNextStreamingScrollEventRef.current) {
        streamingCursorFollowingRef.current = isPositionNearViewport(view, streamingCursorPositionRef.current);
      }
      const key = currentScrollStorageKeyRef.current;
      if (!key) return;
      setStoredScrollPosition(key, readScrollPosition(view));
    };
    view.scrollDOM.addEventListener('scroll', syncScrollPosition, { passive: true });

    const persistOnPageHide = () => {
      syncScrollPosition();
    };
    window.addEventListener('pagehide', persistOnPageHide);
    window.addEventListener('beforeunload', persistOnPageHide);

    restoreScrollPositionRef.current();

    return () => {
      syncScrollPosition();
      view.scrollDOM.removeEventListener('scroll', syncScrollPosition);
      window.removeEventListener('pagehide', persistOnPageHide);
      window.removeEventListener('beforeunload', persistOnPageHide);
      restoreScrollPositionRef.current = null;
      editorControllerRef.current = null;
      streamingCursorPositionRef.current = null;
      streamingCursorFollowingRef.current = false;
      ignoreNextStreamingScrollEventRef.current = false;
      onEditorReadyRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onEditorReady?.(editorControllerRef.current);
  }, [onEditorReady]);

  // Sync external content changes (Reader AI applying edits, file switch, etc.)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (content === currentDoc) {
      if (pendingScrollRestoreKeyRef.current === scrollStorageKey) {
        pendingScrollRestoreKeyRef.current = null;
        restoreScrollPositionRef.current?.();
      }
      return;
    }

    if (contentOrigin === 'local' && contentRevision <= latestLocalRevisionRef.current) {
      return;
    }

    const transaction = buildExternalContentSyncTransaction(view.state, content, contentSelection);
    if (!transaction) return;
    view.dispatch(transaction);

    if (pendingScrollRestoreKeyRef.current === scrollStorageKey) {
      pendingScrollRestoreKeyRef.current = null;
    }
    restoreScrollPositionRef.current?.();
  }, [content, contentOrigin, contentRevision, contentSelection, scrollStorageKey]);

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

  // Sync readOnly
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: promptListAnsweringCompartment.current.reconfigure(promptListAnsweringFacet.of(inlinePromptActive)),
    });
  }, [inlinePromptActive]);

  // Sync placeholder
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure(placeholderExt(placeholder)),
    });
  }, [placeholder]);

  return <div ref={containerRef} class={className} />;
}
