import { css } from '@codemirror/lang-css';
import { html as htmlLanguage } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';

function extensionForFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const match = /\.([^.]+)$/i.exec(fileName);
  return match ? match[1].toLowerCase() : null;
}

function languageExtensionForFileName(fileName: string | null | undefined): Extension[] {
  const extension = extensionForFileName(fileName);
  switch (extension) {
    case 'js':
    case 'json':
    case 'jsonc':
      return [javascript()];
    case 'ts':
      return [javascript({ typescript: true })];
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })];
    case 'py':
      return [python()];
    case 'css':
    case 'scss':
      return [css()];
    case 'html':
      return [htmlLanguage()];
    case 'yml':
    case 'yaml':
      return [yaml()];
    case 'md':
    case 'mdown':
    case 'mdwn':
    case 'markdown':
    case 'mdx':
      return [markdown({ base: markdownLanguage })];
    default:
      return [];
  }
}

interface TextCodeViewProps {
  content: string;
  fileName?: string | null;
}

export function TextCodeView({ content, fileName = null }: TextCodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef(new Compartment());
  const initialContentRef = useRef(content);
  const initialFileNameRef = useRef(fileName);

  // Create viewer on mount; content and language changes are synced in separate effects.
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: initialContentRef.current,
      extensions: [
        highlightSpecialChars(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        keymap.of([
          {
            key: 'Tab',
            run: () => true,
          },
        ]),
        languageCompartmentRef.current.of(languageExtensionForFileName(initialFileNameRef.current)),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
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
    }
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(languageExtensionForFileName(fileName)),
    });
  }, [fileName]);

  return <div ref={containerRef} class="content-code-view" />;
}
