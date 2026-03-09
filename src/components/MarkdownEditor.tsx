import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
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
import { tagHighlighter, tags } from '@lezer/highlight';
import type { InlineParser, MarkdownExtension } from '@lezer/markdown';
import { useEffect, useRef } from 'preact/hooks';
import {
  buildExternalContentSyncTransaction,
  isExternalSyncTransaction,
  markdownListContinuation,
  wrapWithMarker,
} from './markdown_editor_commands';

const markdownHighlighter = tagHighlighter([
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.heading1, class: 'tok-heading tok-heading1' },
  { tag: tags.heading2, class: 'tok-heading tok-heading2' },
  { tag: tags.heading3, class: 'tok-heading tok-heading3' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strikethrough, class: 'tok-strikethrough' },
  { tag: tags.monospace, class: 'tok-monospace' },
  { tag: tags.link, class: 'tok-link' },
  { tag: tags.url, class: 'tok-url' },
  { tag: tags.list, class: 'tok-list' },
  { tag: tags.quote, class: 'tok-quote' },
  { tag: tags.contentSeparator, class: 'tok-contentSeparator' },
  { tag: tags.processingInstruction, class: 'tok-processingInstruction' },
  { tag: tags.meta, class: 'tok-meta' },
  { tag: tags.labelName, class: 'tok-labelName' },
  { tag: tags.string, class: 'tok-string' },
  { tag: tags.atom, class: 'tok-atom' },
  { tag: tags.comment, class: 'tok-comment' },
  { tag: tags.content, class: 'tok-content' },
]);

const wikiLinkInlineParser: InlineParser = {
  name: 'WikiLink',
  before: 'Link',
  parse(cx, next, pos) {
    if (next !== 91 || cx.char(pos + 1) !== 91) return -1; // `[[`

    for (let index = pos + 2; index < cx.end; index += 1) {
      const ch = cx.char(index);
      if (ch === 10 || ch === 13) return -1; // don't span lines
      if (ch === 93 && cx.char(index + 1) === 93) {
        if (index === pos + 2) return -1; // disallow empty `[[ ]]`
        return cx.addElement(cx.elt('WikiLink', pos, index + 2));
      }
    }

    return -1;
  },
};

const wikiLinkMarkdownExtension: MarkdownExtension = {
  defineNodes: [{ name: 'WikiLink', style: tags.link }],
  parseInline: [wikiLinkInlineParser],
};

interface MarkdownEditorProps {
  content: string;
  onContentChange: (content: string) => void;
  onPaste?: (event: ClipboardEvent, view: EditorView) => void;
  readOnly?: boolean;
  placeholder?: string;
  class?: string;
}

export function MarkdownEditor({
  content,
  onContentChange,
  onPaste,
  readOnly = false,
  placeholder = 'Write your markdown here...',
  class: className,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const placeholderCompartment = useRef(new Compartment());

  // Stable refs for callbacks
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onPasteRef = useRef(onPaste);
  onPasteRef.current = onPaste;

  // Track the last content we set externally to avoid echo
  const lastExternalContentRef = useRef(content);

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
      lastExternalContentRef.current = doc;
      onContentChangeRef.current(doc);
    };

    const state = EditorState.create({
      doc: content,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        syntaxHighlighting(markdownHighlighter),
        bracketMatching(),
        markdown({ extensions: [{ remove: ['SetextHeading'] }, wikiLinkMarkdownExtension] }),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        placeholderCompartment.current.of(placeholderExt(placeholder)),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        EditorView.updateListener.of(onUpdate),
        EditorView.domEventHandlers({
          paste: (event, view) => {
            onPasteRef.current?.(event, view);
          },
        }),
        Prec.high(
          keymap.of([
            { key: 'Enter', run: markdownListContinuation },
            { key: 'Mod-b', run: (view) => wrapWithMarker(view, '**') },
            { key: 'Mod-i', run: (view) => wrapWithMarker(view, '*') },
            { key: 'Tab', run: indentMore, shift: indentLess },
            ...historyKeymap,
          ]),
        ),
        keymap.of(defaultKeymap),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external content changes (Reader AI applying edits, file switch, etc.)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Skip if we already know about this content (it came from us)
    if (content === lastExternalContentRef.current) return;
    lastExternalContentRef.current = content;

    const transaction = buildExternalContentSyncTransaction(view.state, content);
    if (!transaction) return;
    view.dispatch(transaction);
  }, [content]);

  // Sync readOnly
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

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
