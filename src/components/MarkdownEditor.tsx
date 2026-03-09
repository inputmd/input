import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder as placeholderExt,
  type ViewUpdate,
} from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';
import { useEffect, useRef } from 'preact/hooks';

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

/** Continue markdown lists on Enter: `- `, `* `, `+ `, `1. `, `1) `, `- [ ] `, etc. */
function markdownListContinuation({ state, dispatch }: EditorView): boolean {
  const { from, to } = state.selection.main;
  if (from !== to) return false;

  const line = state.doc.lineAt(from);
  if (from !== line.to) return false;
  const text = line.text;

  const match = text.match(/^(\s*)([-*+]|\d+[.)]) (\[[ xX]\] )?/);
  if (!match) return false;

  const [fullMatch, indent, marker, checkbox] = match;

  // Empty list item — clear the marker
  if (text.trimEnd() === fullMatch.trimEnd()) {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: indent },
        selection: EditorSelection.cursor(line.from + indent.length),
      }),
    );
    return true;
  }

  // Continue the list
  let nextMarker = marker;
  const numMatch = marker.match(/^(\d+)([.)])/);
  if (numMatch) {
    nextMarker = `${Number(numMatch[1]) + 1}${numMatch[2]}`;
  }

  const continuation = `\n${indent}${nextMarker} ${checkbox ? '[ ] ' : ''}`;
  dispatch(
    state.update({
      changes: { from, to: from, insert: continuation },
      selection: EditorSelection.cursor(from + continuation.length),
    }),
  );
  return true;
}

function wrapWithMarker(view: EditorView, marker: string): boolean {
  const { from, to } = view.state.selection.main;
  const len = marker.length;
  const doc = view.state.doc;

  // Check if already wrapped — unwrap if so
  const before = doc.sliceString(from - len, from);
  const after = doc.sliceString(to, to + len);

  if (before === marker && after === marker) {
    const selected = view.state.sliceDoc(from, to);
    view.dispatch(
      view.state.update({
        changes: { from: from - len, to: to + len, insert: selected },
        selection: from === to ? EditorSelection.cursor(from - len) : EditorSelection.range(from - len, to - len),
      }),
    );
    return true;
  }

  // Wrap
  const selected = view.state.sliceDoc(from, to);
  const replacement = `${marker}${selected}${marker}`;
  view.dispatch(
    view.state.update({
      changes: { from, to, insert: replacement },
      selection: from === to ? EditorSelection.cursor(from + len) : EditorSelection.range(from + len, to + len),
    }),
  );
  return true;
}

// Annotation to mark dispatches that are external syncs (not user edits)
const externalSync = Transaction.userEvent.of('external');

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
        if (tr.annotation(Transaction.userEvent) === 'external') return;
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
        markdown(),
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

    const currentDoc = view.state.doc.toString();
    if (currentDoc === content) return;

    const prevSel = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: content },
      selection: EditorSelection.cursor(Math.min(prevSel.head, content.length)),
      annotations: [externalSync, Transaction.addToHistory.of(false)],
    });
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
