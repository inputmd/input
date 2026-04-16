import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { suppressNextPromptAnswerToggle } from '../prompt_list_state';

const COMMENT_COMPOSER_OFFSET_PX = 8;
const COMMENT_COMPOSER_VIEWPORT_PADDING_PX = 12;
const COMMENT_SELECTION_HIGHLIGHT_NAME = 'prompt-answer-comment-selection';
const REPLY_BUTTON_LABEL = 'Ask about this';
const DISABLED_REPLY_BUTTON_LABEL = 'Open editor to ask';

interface PromptAnswerCommentComposerProps {
  enabled?: boolean;
  resetKey?: string | null;
  rootRef: { current: HTMLElement | null };
  currentUserAvatarUrl?: string | null;
  canReply?: boolean;
  onReplySelection?: (selection: PromptAnswerCommentSelection) => boolean;
}

export interface PromptAnswerCommentSelection {
  promptListId: string;
  answerItemIndex: number;
  quotedText: string;
}

interface ActivePromptAnswerSelection extends PromptAnswerCommentSelection {
  answer: HTMLElement;
  range: Range;
}

interface ComposerPosition {
  left: number;
  top: number;
}

interface CssHighlightsRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

let activeCommentSelectionHighlightOwner: symbol | null = null;

function elementForNode(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

function findPromptAnswerTarget(node: Node | null, root: HTMLElement): HTMLElement | null {
  const answer = elementForNode(node)?.closest('li.prompt-answer');
  if (!(answer instanceof HTMLElement) || !root.contains(answer)) return null;
  return answer;
}

function findPromptAnswerForNode(node: Node | null, root: HTMLElement): HTMLElement | null {
  const answer = findPromptAnswerTarget(node, root);
  if (!answer) return null;
  if (answer.getAttribute('data-expanded') === 'false') return null;
  return answer;
}

function rangesEqual(left: Range | null, right: Range | null): boolean {
  if (!left || !right) return false;
  return (
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset
  );
}

function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readPromptAnswerSelection(root: HTMLElement): ActivePromptAnswerSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const startAnswer = findPromptAnswerForNode(range.startContainer, root);
  const endAnswer = findPromptAnswerForNode(range.endContainer, root);
  if (!startAnswer || startAnswer !== endAnswer) return null;

  const quotedText = normalizeSelectionText(selection.toString());
  if (!quotedText) return null;

  const promptListId = startAnswer.getAttribute('data-prompt-list-id')?.trim() ?? '';
  const answerItemIndexRaw = startAnswer.getAttribute('data-prompt-list-item-index')?.trim() ?? '';
  const answerItemIndex = Number.parseInt(answerItemIndexRaw, 10);
  if (!promptListId || !Number.isInteger(answerItemIndex) || answerItemIndex < 0) return null;

  return {
    answer: startAnswer,
    range: range.cloneRange(),
    promptListId,
    answerItemIndex,
    quotedText,
  };
}

function rangeAnchorBounds(range: Range): { left: number; top: number; bottom: number } | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (rects.length > 0) {
    const first = rects[0];
    const last = rects[rects.length - 1];
    return { left: first.left, top: first.top, bottom: last.bottom };
  }

  const rect = range.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

function composerPositionForRange(range: Range, composer: HTMLElement | null): ComposerPosition | null {
  if (typeof window === 'undefined') return null;

  const anchor = rangeAnchorBounds(range);
  if (!anchor) return null;

  const width = composer?.offsetWidth ?? 160;
  const height = composer?.offsetHeight ?? 48;
  const maxLeft = Math.max(
    COMMENT_COMPOSER_VIEWPORT_PADDING_PX,
    window.innerWidth - width - COMMENT_COMPOSER_VIEWPORT_PADDING_PX,
  );
  const left = Math.min(maxLeft, Math.max(COMMENT_COMPOSER_VIEWPORT_PADDING_PX, anchor.left));
  let top = anchor.bottom + COMMENT_COMPOSER_OFFSET_PX;

  const maxTop = window.innerHeight - height - COMMENT_COMPOSER_VIEWPORT_PADDING_PX;
  if (top > maxTop) {
    top = Math.max(COMMENT_COMPOSER_VIEWPORT_PADDING_PX, anchor.top - height - COMMENT_COMPOSER_OFFSET_PX);
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
  };
}

function cssHighlightsRegistry(): CssHighlightsRegistry | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { CSS?: { highlights?: CssHighlightsRegistry } }).CSS?.highlights ?? null;
}

function highlightConstructor(): HighlightConstructor | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { Highlight?: HighlightConstructor }).Highlight ?? null;
}

function syncCommentSelectionHighlight(owner: symbol, range: Range | null) {
  const registry = cssHighlightsRegistry();
  const HighlightCtor = highlightConstructor();
  if (!registry || !HighlightCtor) return;

  if (!range) {
    if (activeCommentSelectionHighlightOwner !== owner) return;
    registry.delete(COMMENT_SELECTION_HIGHLIGHT_NAME);
    activeCommentSelectionHighlightOwner = null;
    return;
  }

  registry.set(COMMENT_SELECTION_HIGHLIGHT_NAME, new HighlightCtor(range.cloneRange()));
  activeCommentSelectionHighlightOwner = owner;
}

export function PromptAnswerCommentComposer({
  enabled = true,
  resetKey = null,
  rootRef,
  currentUserAvatarUrl = null,
  canReply = false,
  onReplySelection,
}: PromptAnswerCommentComposerProps) {
  const canShowReply = Boolean(canReply && onReplySelection);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const activeSelectionRef = useRef<ActivePromptAnswerSelection | null>(null);
  const highlightOwnerRef = useRef(Symbol('prompt-answer-comment-highlight'));
  const pointerDownRef = useRef(false);
  const pendingSelectionSyncRef = useRef(false);
  const suppressedSelectionSyncCountRef = useRef(0);
  const [composerPosition, setComposerPosition] = useState<ComposerPosition | null>(null);

  const composerContainsActiveElement = useCallback(() => {
    const composer = composerRef.current;
    const activeElement = composer?.ownerDocument.activeElement ?? null;
    return Boolean(composer && activeElement && composer.contains(activeElement));
  }, []);

  const setComposerPositionFromActiveSelection = useCallback(() => {
    const activeSelection = activeSelectionRef.current;
    if (!activeSelection) return false;
    if (!activeSelection.answer.isConnected || !activeSelection.range.startContainer.isConnected) return false;

    syncCommentSelectionHighlight(highlightOwnerRef.current, activeSelection.range);
    const nextPosition = composerPositionForRange(activeSelection.range, composerRef.current);
    if (!nextPosition) return false;
    setComposerPosition((current) =>
      current && current.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition,
    );
    return true;
  }, []);

  const closeComposer = useCallback(() => {
    syncCommentSelectionHighlight(highlightOwnerRef.current, null);
    activeSelectionRef.current = null;
    setComposerPosition(null);
  }, []);

  const withSuppressedSelectionSync = useCallback((callback: () => void) => {
    suppressedSelectionSyncCountRef.current += 1;
    try {
      callback();
    } finally {
      window.setTimeout(() => {
        suppressedSelectionSyncCountRef.current = Math.max(0, suppressedSelectionSyncCountRef.current - 1);
      }, 0);
    }
  }, []);

  const clearDocumentSelection = useCallback(() => {
    const root = rootRef.current;
    const document = root?.ownerDocument ?? window.document;
    withSuppressedSelectionSync(() => {
      document.getSelection()?.removeAllRanges();
    });
  }, [rootRef, withSuppressedSelectionSync]);

  const syncComposerFromSelection = useCallback(() => {
    if (!enabled) {
      closeComposer();
      return;
    }

    const root = rootRef.current;
    if (!root) {
      closeComposer();
      return;
    }

    const selection = readPromptAnswerSelection(root);
    const currentSelection = activeSelectionRef.current;

    if (selection && currentSelection && rangesEqual(selection.range, currentSelection.range)) {
      activeSelectionRef.current = selection;
      setComposerPositionFromActiveSelection();
      return;
    }

    if (!selection) {
      if (!currentSelection) return;
      if (composerContainsActiveElement()) {
        setComposerPositionFromActiveSelection();
        return;
      }
      closeComposer();
      return;
    }

    activeSelectionRef.current = selection;
    syncCommentSelectionHighlight(highlightOwnerRef.current, selection.range);
    setComposerPosition(composerPositionForRange(selection.range, composerRef.current));
  }, [closeComposer, composerContainsActiveElement, enabled, rootRef, setComposerPositionFromActiveSelection]);

  const dismissComposer = useCallback(() => {
    clearDocumentSelection();
    closeComposer();
  }, [clearDocumentSelection, closeComposer]);

  const handleReplyClick = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const activeSelection = activeSelectionRef.current;
      if (!activeSelection || !canReply || !onReplySelection) return;

      const handled = onReplySelection({
        promptListId: activeSelection.promptListId,
        answerItemIndex: activeSelection.answerItemIndex,
        quotedText: activeSelection.quotedText,
      });
      if (!handled) return;

      dismissComposer();
    },
    [canReply, dismissComposer, onReplySelection],
  );

  useEffect(() => {
    if (!enabled) closeComposer();
  }, [closeComposer, enabled]);

  useEffect(() => () => syncCommentSelectionHighlight(highlightOwnerRef.current, null), []);

  useEffect(() => {
    void resetKey;
    closeComposer();
  }, [closeComposer, resetKey]);

  useEffect(() => {
    if (!enabled) return undefined;

    const root = rootRef.current;

    const onSelectionChange = () => {
      if (suppressedSelectionSyncCountRef.current > 0) return;
      if (pointerDownRef.current) {
        pendingSelectionSyncRef.current = true;
        return;
      }
      syncComposerFromSelection();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Node | null;
      if (composerRef.current?.contains(target)) return;
      if (activeSelectionRef.current && root) {
        const targetAnswer = findPromptAnswerTarget(target, root);
        if (targetAnswer) suppressNextPromptAnswerToggle(targetAnswer);
      }
      pointerDownRef.current = true;
      pendingSelectionSyncRef.current = true;
    };

    const onPointerUp = () => {
      if (pointerDownRef.current) pointerDownRef.current = false;
      if (!pendingSelectionSyncRef.current) return;
      pendingSelectionSyncRef.current = false;
      syncComposerFromSelection();
    };

    const onScrollOrResize = () => {
      if (suppressedSelectionSyncCountRef.current > 0) return;
      if (!activeSelectionRef.current) return;
      if (!setComposerPositionFromActiveSelection()) closeComposer();
    };

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);

    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [closeComposer, enabled, rootRef.current, setComposerPositionFromActiveSelection, syncComposerFromSelection]);

  if (!enabled || !composerPosition) return null;

  return (
    <div
      ref={composerRef}
      class="prompt-answer-comment-composer"
      style={{
        top: `${composerPosition.top}px`,
        left: `${composerPosition.left}px`,
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <div class="prompt-answer-comment-composer__avatar" aria-hidden="true">
        {currentUserAvatarUrl ? (
          <img
            class="prompt-answer-comment-composer__avatar-image"
            src={currentUserAvatarUrl}
            alt=""
            width={28}
            height={28}
          />
        ) : (
          <span class="prompt-answer-comment-composer__avatar-placeholder" />
        )}
      </div>
      <div class="prompt-answer-comment-composer__body">
        <button
          type="button"
          class="prompt-answer-comment-composer__action"
          disabled={!canShowReply}
          onClick={handleReplyClick}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            dismissComposer();
          }}
        >
          {canShowReply ? REPLY_BUTTON_LABEL : DISABLED_REPLY_BUTTON_LABEL}
        </button>
      </div>
    </div>
  );
}
