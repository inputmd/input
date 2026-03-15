import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';
import { getStoredScrollPosition, setStoredScrollPosition } from '../scroll_positions';
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
  const languageCompartmentRef = useRef(new Compartment());
  const initialContentRef = useRef(content);
  const initialFileNameRef = useRef(fileName);
  const initialScrollStorageKeyRef = useRef(scrollStorageKey);
  const currentScrollStorageKeyRef = useRef<string | null>(scrollStorageKey);
  const pendingScrollRestoreKeyRef = useRef<string | null>(null);
  const restoreScrollPositionRef = useRef<(() => void) | null>(null);
  const detectedLanguage = detectedLanguageForFileName(fileName);

  // Create viewer on mount; content and language changes are synced in separate effects.
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: initialContentRef.current,
      extensions: [
        highlightSpecialChars(),
        syntaxHighlighting(appCodeMirrorHighlighter, { fallback: true }),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        continuedIndentExtension({ mode: 'indent', maxColumns: 10 }),
        keymap.of([
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

  return (
    <div class="content-code-view-wrap">
      {detectedLanguage ? <div class="content-code-view-language-tag">{detectedLanguage.label}</div> : null}
      <div ref={containerRef} class="content-code-view" />
    </div>
  );
}
