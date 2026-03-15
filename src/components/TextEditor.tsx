import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
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
import { detectedLanguageForFileName } from './codemirror_languages';
import { appCodeMirrorHighlighter } from './codemirror_theme';
import { buildExternalContentSyncTransaction, isExternalSyncTransaction } from './markdown_editor_commands';

interface TextEditorProps {
  content: string;
  fileName?: string | null;
  contentOrigin?: 'local' | 'external';
  contentRevision?: number;
  contentSelection?: { anchor: number; head: number } | null;
  onContentChange: (update: { content: string; origin: 'local'; revision: number }) => void;
  readOnly?: boolean;
  placeholder?: string;
  scrollStorageKey?: string | null;
  class?: string;
}

export function TextEditor({
  content,
  fileName = null,
  contentOrigin = 'external',
  contentRevision = 0,
  contentSelection = null,
  onContentChange,
  readOnly = false,
  placeholder = 'Write your text here...',
  scrollStorageKey = null,
  class: className,
}: TextEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const placeholderCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const currentScrollStorageKeyRef = useRef<string | null>(scrollStorageKey);
  const pendingScrollRestoreKeyRef = useRef<string | null>(null);
  const restoreScrollPositionRef = useRef<(() => void) | null>(null);
  const detectedLanguage = detectedLanguageForFileName(fileName, { includeMarkdown: false });

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const latestLocalRevisionRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect; synced via dedicated effects
  useEffect(() => {
    if (!containerRef.current) return;

    const onUpdate = (update: ViewUpdate) => {
      if (!update.docChanged) return;
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
        syntaxHighlighting(appCodeMirrorHighlighter, { fallback: true }),
        bracketMatching(),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        placeholderCompartment.current.of(placeholderExt(placeholder)),
        languageCompartment.current.of(detectedLanguage?.extensions ?? []),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        continuedIndentExtension({ mode: 'indent', maxColumns: 10 }),
        EditorView.updateListener.of(onUpdate),
        keymap.of([...historyKeymap, ...defaultKeymap]),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    currentScrollStorageKeyRef.current = scrollStorageKey;

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
      view.destroy();
      viewRef.current = null;
    };
  }, []);

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
      effects: placeholderCompartment.current.reconfigure(placeholderExt(placeholder)),
    });
  }, [placeholder]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(detectedLanguage?.extensions ?? []),
    });
  }, [detectedLanguage]);

  return <div ref={containerRef} class={className} />;
}
