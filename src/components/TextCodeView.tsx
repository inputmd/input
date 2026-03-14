import { css } from '@codemirror/lang-css';
import { html as htmlLanguage } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';
import { appCodeMirrorHighlighter } from './codemirror_theme';

function extensionForFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const match = /\.([^.]+)$/i.exec(fileName);
  return match ? match[1].toLowerCase() : null;
}

interface DetectedLanguage {
  label: string;
  extensions: Extension[];
}

function detectedLanguageForFileName(fileName: string | null | undefined): DetectedLanguage | null {
  const extension = extensionForFileName(fileName);
  switch (extension) {
    case 'js':
    case 'jsonc':
    case 'json':
      return { label: 'JavaScript', extensions: [javascript()] };
    case 'ts':
      return { label: 'TypeScript', extensions: [javascript({ typescript: true })] };
    case 'jsx':
      return { label: 'JSX', extensions: [javascript({ jsx: true })] };
    case 'tsx':
      return { label: 'TSX', extensions: [javascript({ typescript: true, jsx: true })] };
    case 'py':
      return { label: 'Python', extensions: [python()] };
    case 'css':
    case 'scss':
      return { label: 'CSS', extensions: [css()] };
    case 'html':
      return { label: 'HTML', extensions: [htmlLanguage()] };
    case 'yml':
    case 'yaml':
      return { label: 'YAML', extensions: [yaml()] };
    case 'md':
    case 'mdown':
    case 'mdwn':
    case 'markdown':
    case 'mdx':
      return {
        label: 'Markdown',
        extensions: [markdown({ base: markdownLanguage, extensions: [{ remove: ['IndentedCode'] }] })],
      };
    default:
      return null;
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
