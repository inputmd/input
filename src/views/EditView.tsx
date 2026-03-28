import type { EditorView } from '@codemirror/view';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowUpDown, LockOpen } from 'lucide-react';
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BracePromptRequest, InlinePromptRequest } from '../components/codemirror_inline_prompt';
import type { EditorController } from '../components/editor_controller';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { MarkdownLinkPreviewPopover } from '../components/MarkdownLinkPreviewPopover';
import type { PromptListRequest } from '../components/markdown_editor_commands';
import { TextEditor } from '../components/TextEditor';
import { type PreviewPositionForAnchor, useMarkdownLinkPreview } from '../hooks/useMarkdownLinkPreview';
import type { MarkdownSyncBlock } from '../markdown';
import type { MarkdownLinkPreview } from '../markdown_link_preview';
import { resolveInternalRoute } from '../markdown_link_preview';
import {
  syncPromptListCollapsedStateFromUrl,
  togglePromptAnswerExpandedState,
  togglePromptListCollapsedStateInUrl,
} from '../prompt_list_state';
import { getStoredScrollPosition } from '../scroll_positions';
import { syncPromptPaneBleedVars } from './prompt_pane_vars';

const PREVIEW_SCROLL_LOCK_STORAGE_KEY = 'input_preview_scroll_locked_v1';
const PREVIEW_RESTORE_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th';
const PREVIEW_SYNC_SELECTOR = '[data-sync-id]';
const SCROLL_SYNC_ANCHOR_RATIO = 0.3;

function shouldAttemptPreviewScrollRestore({
  markdown,
  previewVisible,
  canRenderPreview,
  loading,
  scrollStorageKey,
}: {
  markdown: boolean;
  previewVisible: boolean;
  canRenderPreview: boolean;
  loading: boolean;
  scrollStorageKey: string | null;
}): boolean {
  if (typeof window === 'undefined') return false;
  if (!markdown || !previewVisible || !canRenderPreview || loading || !scrollStorageKey) return false;
  return (getStoredScrollPosition(scrollStorageKey) ?? 0) > 0;
}

function normalizePreviewAnchorText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, ' $1 ')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, ' $1 ')
    .replace(/\[\[([^\]]+)\]\]/g, ' $1 ')
    .replace(/`([^`]*)`/g, ' $1 ')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|\d+[.)]\s+|[-+*]\s+|\[[ xX]\]\s+)/, '')
        .replace(/^\s{0,3}```.*$/, '')
        .trim(),
    )
    .join(' ')
    .replace(/[*_~>#`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findPreviewRestoreTarget(root: HTMLElement, anchorText: string): HTMLElement | null {
  const anchor = normalizePreviewAnchorText(anchorText);
  if (!anchor) return null;

  const anchorPrefix = anchor.slice(0, Math.min(anchor.length, 96));
  let bestElement: HTMLElement | null = null;
  let bestScore = -1;

  root.querySelectorAll<HTMLElement>(PREVIEW_RESTORE_SELECTOR).forEach((element) => {
    const text = normalizePreviewAnchorText(element.textContent ?? '');
    if (!text) return;

    let score = -1;
    if (text === anchor) {
      score = 4000;
    } else if (text.startsWith(anchor)) {
      score = 3000 - Math.abs(text.length - anchor.length);
    } else if (anchor.startsWith(text) && text.length >= Math.min(32, anchor.length)) {
      score = 2500 - Math.abs(text.length - anchor.length);
    } else {
      const exactIndex = text.indexOf(anchor);
      if (exactIndex >= 0) {
        score = 2000 - exactIndex;
      } else if (anchorPrefix.length >= 12) {
        const prefixIndex = text.indexOf(anchorPrefix);
        if (prefixIndex >= 0) score = 1000 - prefixIndex;
      }
    }

    if (score < 0) return;
    if (score > bestScore) {
      bestScore = score;
      bestElement = element;
    }
  });

  return bestElement;
}

function maxScrollTop(node: { scrollHeight: number; clientHeight: number }): number {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

function clampScrollTop(scrollTop: number, max: number): number {
  return Math.min(max, Math.max(0, scrollTop));
}

interface SyncBlockHit {
  block: MarkdownSyncBlock;
  progress: number;
  /** Non-null when position is in a gap between two blocks. */
  nextBlock: MarkdownSyncBlock | null;
  /** 0–1 fraction through the gap between `block` and `nextBlock`. */
  gapFraction: number;
}

function findSyncBlockForPosition(blocks: MarkdownSyncBlock[], position: number): SyncBlockHit | null {
  let previous: MarkdownSyncBlock | null = null;
  for (const block of blocks) {
    if (position < block.from) {
      if (previous) {
        // Position is in a gap between `previous` and `block`.
        const gapLength = Math.max(1, block.from - previous.to);
        const gapFraction = Math.max(0, Math.min(1, (position - previous.to) / gapLength));
        return { block: previous, progress: 1, nextBlock: block, gapFraction };
      }
      // Before the first block — treat as start of that block.
      return { block, progress: 0, nextBlock: null, gapFraction: 0 };
    }
    if (position <= block.to) {
      const length = Math.max(1, block.to - block.from);
      return {
        block,
        progress: Math.max(0, Math.min(1, (position - block.from) / length)),
        nextBlock: null,
        gapFraction: 0,
      };
    }
    previous = block;
  }
  if (previous) {
    return { block: previous, progress: 1, nextBlock: null, gapFraction: 0 };
  }
  return null;
}

function findSyncBlockById(blocks: MarkdownSyncBlock[], id: string): MarkdownSyncBlock | null {
  return blocks.find((block) => block.id === id) ?? null;
}

export interface EditViewProps {
  fileName?: string | null;
  markdown?: boolean;
  content: string;
  contentOrigin?: 'userEdits' | 'external' | 'streaming' | 'appEdits';
  contentRevision?: number;
  contentSelection?: { anchor: number; head: number } | null;
  previewHtml: string;
  previewCustomCss?: string | null;
  previewCustomCssScope?: string | null;
  previewFrontMatterError?: string | null;
  previewCssWarning?: string | null;
  previewSyncBlocks?: MarkdownSyncBlock[];
  previewVisible: boolean;
  canRenderPreview: boolean;
  scrollStorageKey?: string | null;
  loading?: boolean;
  onTogglePreview: () => void;
  onContentChange: (update: { content: string; origin: 'userEdits'; revision: number }) => void;
  onInlinePromptSubmit?: (request: InlinePromptRequest) => void;
  onBracePromptStream?: (
    request: BracePromptRequest,
    callbacks: { onDelta: (delta: string) => void },
    signal: AbortSignal,
  ) => Promise<void>;
  onPromptListSubmit?: (request: PromptListRequest) => void;
  onCancelInlinePrompt?: () => void;
  inlinePromptActive?: boolean;
  onInternalLinkNavigate?: (route: string) => void;
  onRequestMarkdownLinkPreview?: (route: string) => Promise<MarkdownLinkPreview | null>;
  onPreviewImageClick?: (image: HTMLImageElement) => void;
  onEditorPaste?: (event: ClipboardEvent, view: EditorView) => void;
  onEditorReady?: (controller: EditorController | null) => void;
  onEligibleSelectionChange?: (eligible: boolean) => void;
  saving: boolean;
  canSave: boolean;
  hasUserTypedUnsavedChanges?: boolean;
  onSave: () => void;
  readOnly?: boolean;
  locked?: boolean;
  showLockIndicator?: boolean;
  lockLabel?: string;
  imageUploadIssue?: {
    message: string;
    onRetry: () => void;
    onRemovePlaceholder: () => void;
  } | null;
}

export function EditView({
  fileName = null,
  markdown = true,
  content,
  contentOrigin = 'external',
  contentRevision = 0,
  contentSelection = null,
  previewHtml,
  previewCustomCss = null,
  previewCustomCssScope = null,
  previewFrontMatterError = null,
  previewCssWarning = null,
  previewSyncBlocks = [],
  previewVisible,
  canRenderPreview,
  scrollStorageKey = null,
  loading = false,
  onTogglePreview,
  onContentChange,
  onInlinePromptSubmit,
  onBracePromptStream,
  onPromptListSubmit,
  onCancelInlinePrompt,
  inlinePromptActive = false,
  onInternalLinkNavigate,
  onRequestMarkdownLinkPreview,
  onPreviewImageClick,
  onEditorPaste,
  onEditorReady,
  onEligibleSelectionChange,
  saving,
  canSave,
  hasUserTypedUnsavedChanges = false,
  onSave,
  readOnly = false,
  locked = false,
  showLockIndicator = true,
  lockLabel = 'Reader AI',
  imageUploadIssue,
}: EditViewProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const previewPaneRef = useRef<HTMLDivElement | null>(null);
  const mobilePreviewPaneRef = useRef<HTMLDivElement | null>(null);
  const renderedMarkdownRef = useRef<HTMLDivElement | null>(null);
  const editorControllerRef = useRef<EditorController | null>(null);
  const editorToPreviewScrollFrameRef = useRef<number | null>(null);
  const previewToEditorScrollFrameRef = useRef<number | null>(null);
  const ignorePreviewScrollFrameRef = useRef<number | null>(null);
  const ignoreEditorScrollFrameRef = useRef<number | null>(null);
  const editorScrollLerpTargetRef = useRef<number | null>(null);
  const editorScrollLerpFrameRef = useRef<number | null>(null);
  const previewRestoreFrameRef = useRef<number | null>(null);
  const previewScrollTooltipCloseTimeoutRef = useRef<number | null>(null);
  const previewSyncElementsRef = useRef<HTMLElement[]>([]);
  const previewSyncElementByIdRef = useRef<Map<string, HTMLElement>>(new Map());
  const [splitPercent, setSplitPercent] = useState(52);
  const [previewScrollLocked, setPreviewScrollLocked] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      const raw = window.localStorage.getItem(PREVIEW_SCROLL_LOCK_STORAGE_KEY);
      return raw !== 'false';
    } catch {
      return true;
    }
  });
  const [previewRestorePending, setPreviewRestorePending] = useState(() =>
    shouldAttemptPreviewScrollRestore({
      markdown,
      previewVisible,
      canRenderPreview,
      loading,
      scrollStorageKey,
    }),
  );
  const [previewScrollTooltipOpen, setPreviewScrollTooltipOpen] = useState(false);
  const lastPreviewRestoreKeyRef = useRef<string | null>(null);

  const getPreviewPosition = useCallback((anchor: HTMLAnchorElement): PreviewPositionForAnchor => {
    const rect = anchor.getBoundingClientRect();
    return {
      top: Math.round(rect.bottom + 8),
      left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
    };
  }, []);

  const {
    preview,
    hidePreview,
    onRenderedMarkdownMouseMove,
    onRenderedMarkdownMouseDown,
    onRenderedMarkdownMouseUp,
    pointerDraggedRef,
  } = useMarkdownLinkPreview({
    renderedMarkdownRef,
    onRequestMarkdownLinkPreview,
    getPreviewPosition,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!loading && !locked && !readOnly && canSave && !saving) onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canSave, loading, saving, onSave, locked, readOnly]);

  const openPreviewScrollTooltip = useCallback(() => {
    if (previewScrollTooltipCloseTimeoutRef.current != null) {
      window.clearTimeout(previewScrollTooltipCloseTimeoutRef.current);
      previewScrollTooltipCloseTimeoutRef.current = null;
    }
    setPreviewScrollTooltipOpen(true);
  }, []);

  const closePreviewScrollTooltipSoon = useCallback(() => {
    if (previewScrollTooltipCloseTimeoutRef.current != null) {
      window.clearTimeout(previewScrollTooltipCloseTimeoutRef.current);
    }
    previewScrollTooltipCloseTimeoutRef.current = window.setTimeout(() => {
      previewScrollTooltipCloseTimeoutRef.current = null;
      setPreviewScrollTooltipOpen(false);
    }, 120);
  }, []);

  const getEditorScrollMetrics = useCallback(() => {
    const workspace = splitRef.current;
    const editorScroller = workspace?.querySelector<HTMLElement>('.doc-editor .cm-scroller') ?? null;
    const editorUsesOwnScroll =
      editorScroller !== null && editorScroller.scrollHeight > editorScroller.clientHeight + 1;
    const max =
      editorUsesOwnScroll && editorScroller
        ? maxScrollTop(editorScroller)
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const top = editorUsesOwnScroll && editorScroller ? editorScroller.scrollTop : window.scrollY;
    return { editorScroller, editorUsesOwnScroll, max, top };
  }, []);

  const ignoreNextPreviewScrollRef = useRef(false);
  const ignoreNextEditorScrollRef = useRef(false);

  const schedulePreviewScrollIgnoreReset = useCallback(() => {
    if (ignorePreviewScrollFrameRef.current != null) {
      window.cancelAnimationFrame(ignorePreviewScrollFrameRef.current);
    }
    ignorePreviewScrollFrameRef.current = window.requestAnimationFrame(() => {
      ignorePreviewScrollFrameRef.current = null;
      ignoreNextPreviewScrollRef.current = false;
    });
  }, []);

  const scheduleEditorScrollIgnoreReset = useCallback(() => {
    if (ignoreEditorScrollFrameRef.current != null) {
      window.cancelAnimationFrame(ignoreEditorScrollFrameRef.current);
    }
    ignoreEditorScrollFrameRef.current = window.requestAnimationFrame(() => {
      ignoreEditorScrollFrameRef.current = null;
      ignoreNextEditorScrollRef.current = false;
    });
  }, []);

  const setPreviewScrollTop = useCallback(
    (scrollTop: number) => {
      const pane = previewPaneRef.current;
      if (!pane) return;
      const nextScrollTop = clampScrollTop(scrollTop, maxScrollTop(pane));
      if (Math.abs(pane.scrollTop - nextScrollTop) < 1) return;
      ignoreNextPreviewScrollRef.current = true;
      schedulePreviewScrollIgnoreReset();
      pane.scrollTop = nextScrollTop;
    },
    [schedulePreviewScrollIgnoreReset],
  );

  const applyEditorScrollTop = useCallback(
    (nextScrollTop: number) => {
      const { editorScroller, editorUsesOwnScroll } = getEditorScrollMetrics();
      if (editorUsesOwnScroll && editorScroller) {
        if (Math.abs(editorScroller.scrollTop - nextScrollTop) < 1) return;
        ignoreNextEditorScrollRef.current = true;
        scheduleEditorScrollIgnoreReset();
        editorScroller.scrollTop = nextScrollTop;
        return;
      }
      if (Math.abs(window.scrollY - nextScrollTop) < 1) return;
      ignoreNextEditorScrollRef.current = true;
      scheduleEditorScrollIgnoreReset();
      window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
    },
    [getEditorScrollMetrics, scheduleEditorScrollIgnoreReset],
  );

  const editorScrollLerpTick = useCallback(() => {
    editorScrollLerpFrameRef.current = null;
    const target = editorScrollLerpTargetRef.current;
    if (target == null) return;

    const { editorScroller, editorUsesOwnScroll, max } = getEditorScrollMetrics();
    const clampedTarget = clampScrollTop(target, max);
    const current = editorUsesOwnScroll && editorScroller ? editorScroller.scrollTop : window.scrollY;
    const delta = clampedTarget - current;

    if (Math.abs(delta) < 1) {
      editorScrollLerpTargetRef.current = null;
      applyEditorScrollTop(clampedTarget);
      return;
    }

    applyEditorScrollTop(current + delta * 0.25);
    editorScrollLerpFrameRef.current = window.requestAnimationFrame(editorScrollLerpTick);
  }, [applyEditorScrollTop, getEditorScrollMetrics]);

  const setEditorScrollTop = useCallback(
    (scrollTop: number) => {
      const { max } = getEditorScrollMetrics();
      editorScrollLerpTargetRef.current = clampScrollTop(scrollTop, max);
      if (editorScrollLerpFrameRef.current == null) {
        editorScrollLerpFrameRef.current = window.requestAnimationFrame(editorScrollLerpTick);
      }
    },
    [getEditorScrollMetrics, editorScrollLerpTick],
  );

  const getPreviewSyncAnchor = useCallback((): { id: string; progress: number } | null => {
    const pane = previewPaneRef.current;
    if (!pane) return null;
    const anchorY = pane.scrollTop + pane.clientHeight * SCROLL_SYNC_ANCHOR_RATIO;

    let bestElement: HTMLElement | null = null;
    let bestTop = 0;
    let bestHeight = 1;
    let bestDistance = Number.POSITIVE_INFINITY;
    const paneRect = pane.getBoundingClientRect();

    for (const element of previewSyncElementsRef.current) {
      const id = element.dataset.syncId;
      if (!id) continue;
      const rect = element.getBoundingClientRect();
      const top = rect.top - paneRect.top + pane.scrollTop;
      const height = Math.max(1, rect.height);
      const bottom = top + height;
      const distance = anchorY < top ? top - anchorY : anchorY > bottom ? anchorY - bottom : 0;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      bestElement = element;
      bestTop = top;
      bestHeight = height;
    }

    if (!bestElement?.dataset.syncId) return null;
    return {
      id: bestElement.dataset.syncId,
      progress: Math.max(0, Math.min(1, (anchorY - bestTop) / bestHeight)),
    };
  }, []);

  const getPreviewSyncElementTop = useCallback((id: string): { top: number; height: number } | null => {
    const pane = previewPaneRef.current;
    const target = previewSyncElementByIdRef.current.get(id);
    if (!pane || !target) return null;
    const paneRect = pane.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return { top: rect.top - paneRect.top + pane.scrollTop, height: Math.max(1, rect.height) };
  }, []);

  const scrollPreviewToSyncHit = useCallback(
    (hit: SyncBlockHit): boolean => {
      const pane = previewPaneRef.current;
      if (!pane) return false;

      const primary = getPreviewSyncElementTop(hit.block.id);
      if (!primary) return false;

      const anchorOffset = pane.clientHeight * SCROLL_SYNC_ANCHOR_RATIO;

      if (hit.nextBlock && hit.gapFraction > 0) {
        const next = getPreviewSyncElementTop(hit.nextBlock.id);
        if (next) {
          const fromY = primary.top + primary.height;
          const toY = next.top;
          const interpolatedY = fromY + (toY - fromY) * hit.gapFraction;
          setPreviewScrollTop(interpolatedY - anchorOffset);
          return true;
        }
      }

      const nextScrollTop = primary.top + primary.height * hit.progress - anchorOffset;
      setPreviewScrollTop(nextScrollTop);
      return true;
    },
    [getPreviewSyncElementTop, setPreviewScrollTop],
  );

  const scrollEditorToSyncTarget = useCallback(
    (position: number): boolean => {
      const controller = editorControllerRef.current;
      if (!controller) return false;
      const scrollTop = controller.getScrollTopForPosition(position, SCROLL_SYNC_ANCHOR_RATIO);
      if (scrollTop == null) return false;
      setEditorScrollTop(scrollTop);
      return true;
    },
    [setEditorScrollTop],
  );

  const syncPreviewToEditorScroll = useCallback(() => {
    if (!markdown || !previewVisible || !canRenderPreview || loading || !previewScrollLocked) return;
    const pane = previewPaneRef.current;
    if (!pane) return;

    const controller = editorControllerRef.current;
    if (controller && previewSyncBlocks.length > 0 && previewSyncElementByIdRef.current.size > 0) {
      const position = controller.getViewportAnchorPosition(SCROLL_SYNC_ANCHOR_RATIO);
      const hit = findSyncBlockForPosition(previewSyncBlocks, position);
      if (hit && scrollPreviewToSyncHit(hit)) return;
    }

    const previewMax = maxScrollTop(pane);
    if (previewMax <= 0) {
      setPreviewScrollTop(0);
      return;
    }

    const { top: sourceTop, max: sourceMax } = getEditorScrollMetrics();
    const progress = sourceMax <= 0 ? 0 : Math.max(0, Math.min(1, sourceTop / sourceMax));
    setPreviewScrollTop(progress * previewMax);
  }, [
    canRenderPreview,
    getEditorScrollMetrics,
    loading,
    markdown,
    previewScrollLocked,
    previewSyncBlocks,
    previewVisible,
    scrollPreviewToSyncHit,
    setPreviewScrollTop,
  ]);

  const requestPreviewScrollSync = useCallback(() => {
    if (editorToPreviewScrollFrameRef.current != null) return;
    editorToPreviewScrollFrameRef.current = window.requestAnimationFrame(() => {
      editorToPreviewScrollFrameRef.current = null;
      syncPreviewToEditorScroll();
    });
  }, [syncPreviewToEditorScroll]);

  const syncEditorToPreviewScroll = useCallback(() => {
    if (!markdown || !previewVisible || !canRenderPreview || loading || !previewScrollLocked) return;
    const pane = previewPaneRef.current;
    if (!pane) return;

    if (previewSyncBlocks.length > 0) {
      const anchor = getPreviewSyncAnchor();
      const block = anchor ? findSyncBlockById(previewSyncBlocks, anchor.id) : null;
      if (anchor && block) {
        const targetPosition = Math.round(block.from + (block.to - block.from) * anchor.progress);
        if (scrollEditorToSyncTarget(targetPosition)) return;
      }
    }

    const previewMax = maxScrollTop(pane);
    const { max: editorMax } = getEditorScrollMetrics();
    const progress = previewMax <= 0 ? 0 : Math.max(0, Math.min(1, pane.scrollTop / previewMax));
    setEditorScrollTop(progress * editorMax);
  }, [
    canRenderPreview,
    getPreviewSyncAnchor,
    getEditorScrollMetrics,
    loading,
    markdown,
    previewScrollLocked,
    previewSyncBlocks,
    previewVisible,
    scrollEditorToSyncTarget,
    setEditorScrollTop,
  ]);

  const requestEditorScrollSync = useCallback(() => {
    if (previewToEditorScrollFrameRef.current != null) return;
    previewToEditorScrollFrameRef.current = window.requestAnimationFrame(() => {
      previewToEditorScrollFrameRef.current = null;
      syncEditorToPreviewScroll();
    });
  }, [syncEditorToPreviewScroll]);

  useEffect(() => {
    return () => {
      if (previewScrollTooltipCloseTimeoutRef.current != null) {
        window.clearTimeout(previewScrollTooltipCloseTimeoutRef.current);
        previewScrollTooltipCloseTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PREVIEW_SCROLL_LOCK_STORAGE_KEY, previewScrollLocked ? 'true' : 'false');
    } catch {
      // Best-effort only.
    }
  }, [previewScrollLocked]);

  useEffect(() => {
    if (!scrollStorageKey) {
      lastPreviewRestoreKeyRef.current = null;
      return;
    }
    if (lastPreviewRestoreKeyRef.current === scrollStorageKey) return;
    setPreviewRestorePending(
      shouldAttemptPreviewScrollRestore({
        markdown,
        previewVisible,
        canRenderPreview,
        loading,
        scrollStorageKey,
      }),
    );
  }, [canRenderPreview, loading, markdown, previewVisible, scrollStorageKey]);

  useEffect(() => {
    if (!previewRestorePending) return;
    lastPreviewRestoreKeyRef.current = scrollStorageKey;
  }, [previewRestorePending, scrollStorageKey]);

  useEffect(() => {
    if (!previewRestorePending) return;
    const pane = previewPaneRef.current;
    const root = renderedMarkdownRef.current;
    const controller = editorControllerRef.current;
    if (!pane || !root || !controller) return;

    let cancelled = false;
    const runAlignment = () => {
      previewRestoreFrameRef.current = window.requestAnimationFrame(() => {
        previewRestoreFrameRef.current = window.requestAnimationFrame(() => {
          previewRestoreFrameRef.current = null;
          if (cancelled) return;
          const topVisibleText = controller.getTopVisibleText(240);
          const target = topVisibleText ? findPreviewRestoreTarget(root, topVisibleText) : null;
          if (target) {
            pane.scrollTop = Math.max(0, target.offsetTop - 8);
          }
          setPreviewRestorePending(false);
        });
      });
    };

    runAlignment();
    return () => {
      cancelled = true;
      if (previewRestoreFrameRef.current != null) {
        window.cancelAnimationFrame(previewRestoreFrameRef.current);
        previewRestoreFrameRef.current = null;
      }
    };
  }, [previewRestorePending]);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !previewVisible || !previewHtml || !root) {
      previewSyncElementsRef.current = [];
      previewSyncElementByIdRef.current = new Map();
      return;
    }

    const elements = Array.from(root.querySelectorAll<HTMLElement>(PREVIEW_SYNC_SELECTOR)).filter((element) =>
      Boolean(element.dataset.syncId),
    );
    previewSyncElementsRef.current = elements;
    const elementEntries: Array<[string, HTMLElement]> = [];
    for (const element of elements) {
      const id = element.dataset.syncId;
      if (!id) continue;
      elementEntries.push([id, element]);
    }
    previewSyncElementByIdRef.current = new Map(elementEntries);
  }, [markdown, previewHtml, previewVisible]);

  useEffect(() => {
    if (!markdown || !previewVisible || !canRenderPreview || loading) return;
    if (!previewScrollLocked) return;
    const pane = previewPaneRef.current;
    if (!pane) return;
    const { editorScroller, editorUsesOwnScroll } = getEditorScrollMetrics();

    const requestEditorDrivenSync = () => {
      if (ignoreNextEditorScrollRef.current) return;
      requestPreviewScrollSync();
    };
    const requestPreviewDrivenSync = () => {
      if (ignoreNextPreviewScrollRef.current) return;
      requestEditorScrollSync();
    };

    requestPreviewScrollSync();
    if (editorUsesOwnScroll && editorScroller) {
      editorScroller.addEventListener('scroll', requestEditorDrivenSync, { passive: true });
    } else {
      window.addEventListener('scroll', requestEditorDrivenSync, { passive: true });
    }
    pane.addEventListener('scroll', requestPreviewDrivenSync, { passive: true });
    window.addEventListener('resize', requestPreviewScrollSync);

    const resizeObserver = new ResizeObserver(requestPreviewScrollSync);
    resizeObserver.observe(pane);
    if (editorScroller) resizeObserver.observe(editorScroller);

    return () => {
      if (editorUsesOwnScroll && editorScroller) {
        editorScroller.removeEventListener('scroll', requestEditorDrivenSync);
      } else {
        window.removeEventListener('scroll', requestEditorDrivenSync);
      }
      pane.removeEventListener('scroll', requestPreviewDrivenSync);
      window.removeEventListener('resize', requestPreviewScrollSync);
      resizeObserver.disconnect();
    };
  }, [
    canRenderPreview,
    getEditorScrollMetrics,
    loading,
    markdown,
    previewScrollLocked,
    previewVisible,
    requestEditorScrollSync,
    requestPreviewScrollSync,
  ]);

  useEffect(() => {
    return () => {
      if (editorToPreviewScrollFrameRef.current != null) {
        window.cancelAnimationFrame(editorToPreviewScrollFrameRef.current);
        editorToPreviewScrollFrameRef.current = null;
      }
      if (previewToEditorScrollFrameRef.current != null) {
        window.cancelAnimationFrame(previewToEditorScrollFrameRef.current);
        previewToEditorScrollFrameRef.current = null;
      }
      if (ignorePreviewScrollFrameRef.current != null) {
        window.cancelAnimationFrame(ignorePreviewScrollFrameRef.current);
        ignorePreviewScrollFrameRef.current = null;
      }
      if (ignoreEditorScrollFrameRef.current != null) {
        window.cancelAnimationFrame(ignoreEditorScrollFrameRef.current);
        ignoreEditorScrollFrameRef.current = null;
      }
      if (editorScrollLerpFrameRef.current != null) {
        window.cancelAnimationFrame(editorScrollLerpFrameRef.current);
        editorScrollLerpFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const markdownRoot = renderedMarkdownRef.current;
    const pane = canRenderPreview ? previewPaneRef.current : mobilePreviewPaneRef.current;
    if (!markdown || !previewVisible || !markdownRoot || !pane) return;

    const sync = () => syncPromptPaneBleedVars(markdownRoot, pane);
    sync();

    const observer = new ResizeObserver(sync);
    observer.observe(pane);
    observer.observe(markdownRoot);
    window.addEventListener('resize', sync);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [canRenderPreview, markdown, previewVisible]);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !previewVisible || !previewHtml || !root) return;

    syncPromptListCollapsedStateFromUrl(root);
  }, [markdown, previewHtml, previewVisible]);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !previewVisible || !root) return;

    const sync = () => syncPromptListCollapsedStateFromUrl(root);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [markdown, previewVisible]);

  const onSplitPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!previewVisible || !canRenderPreview) return;
    const container = splitRef.current;
    if (!container) return;

    const startRect = container.getBoundingClientRect();
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const relativeX = moveEvent.clientX - startRect.left;
      const next = (relativeX / startRect.width) * 100;
      setSplitPercent(Math.max(25, Math.min(75, next)));
    };
    const cleanupPointerListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanupPointerListeners);
      window.removeEventListener('pointercancel', cleanupPointerListeners);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanupPointerListeners);
    window.addEventListener('pointercancel', cleanupPointerListeners);
    event.preventDefault();
  };

  const layoutStyle =
    markdown && previewVisible && canRenderPreview
      ? { gridTemplateColumns: `${splitPercent}% 0 minmax(0, 1fr)` }
      : undefined;

  const onPreviewClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const answerToggle = target?.closest('.prompt-answer-toggle');
    if (answerToggle instanceof HTMLElement) {
      event.preventDefault();
      const answer = answerToggle.closest('li.prompt-answer');
      if (answer instanceof HTMLElement) {
        const conversation = answer.closest('.prompt-list-conversation');
        if (conversation instanceof HTMLElement && conversation.getAttribute('data-collapsed') === 'true') {
          togglePromptListCollapsedStateInUrl(conversation);
        }
        togglePromptAnswerExpandedState(answer);
      }
      return;
    }

    const toggle = target?.closest('.prompt-list-caption');
    if (toggle instanceof HTMLElement) {
      event.preventDefault();
      const container = toggle.closest('.prompt-list-conversation');
      if (container instanceof HTMLElement) {
        togglePromptListCollapsedStateInUrl(container);
      }
      return;
    }

    const anchor = target?.closest('a') as HTMLAnchorElement | null;
    if (anchor && !pointerDraggedRef.current) {
      const route = resolveInternalRoute(anchor);
      if (route && onInternalLinkNavigate) {
        event.preventDefault();
        onInternalLinkNavigate(route);
        return;
      }
    }

    const image = target?.closest('img');
    if (!image || !onPreviewImageClick) return;

    event.preventDefault();
    onPreviewImageClick(image);
  };

  const onPreviewKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest('.prompt-list-caption');
    if (!(toggle instanceof HTMLElement)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const container = toggle.closest('.prompt-list-conversation');
    if (container instanceof HTMLElement) {
      togglePromptListCollapsedStateInUrl(container);
    }
  };

  const handleEditorReady = useCallback(
    (controller: EditorController | null) => {
      editorControllerRef.current = controller;
      onEditorReady?.(controller);
    },
    [onEditorReady],
  );
  const showModelStatusIndicator = locked;

  return (
    <div class="edit-view" data-has-user-typed-unsaved-changes={hasUserTypedUnsavedChanges ? 'true' : 'false'}>
      {imageUploadIssue ? (
        <div class="editor-inline-alert" role="status" aria-live="polite">
          <span>{imageUploadIssue.message}</span>
          <div class="editor-inline-alert-actions">
            <button type="button" onClick={imageUploadIssue.onRetry}>
              Retry Upload
            </button>
            <button type="button" onClick={imageUploadIssue.onRemovePlaceholder}>
              Remove Placeholder
            </button>
          </div>
        </div>
      ) : null}
      <div class="editor-workspace" ref={splitRef} style={layoutStyle}>
        {locked && showLockIndicator ? (
          <div class="editor-lock-indicator" role="status" aria-live="polite">
            <span class="editor-loading-spinner" aria-hidden="true" />
            <span>{lockLabel}</span>
          </div>
        ) : null}
        {loading ? (
          <div class="editor-loading-overlay" role="status" aria-live="polite" aria-label="Loading file into editor">
            <span class="editor-loading-spinner" aria-hidden="true" />
          </div>
        ) : null}
        {markdown ? (
          <MarkdownEditor
            class="doc-editor"
            content={content}
            contentOrigin={contentOrigin}
            contentRevision={contentRevision}
            contentSelection={contentSelection}
            scrollStorageKey={scrollStorageKey}
            onContentChange={onContentChange}
            onEditorReady={handleEditorReady}
            onEligibleSelectionChange={onEligibleSelectionChange}
            onInlinePromptSubmit={onInlinePromptSubmit}
            onBracePromptStream={onBracePromptStream}
            onPromptListSubmit={onPromptListSubmit}
            onCancelInlinePrompt={onCancelInlinePrompt}
            inlinePromptActive={inlinePromptActive}
            onPaste={onEditorPaste}
            readOnly={readOnly || locked || loading}
          />
        ) : (
          <TextEditor
            class="doc-editor"
            fileName={fileName}
            content={content}
            contentOrigin={contentOrigin}
            contentRevision={contentRevision}
            contentSelection={contentSelection}
            scrollStorageKey={scrollStorageKey}
            onContentChange={onContentChange}
            onEditorReady={handleEditorReady}
            onEligibleSelectionChange={onEligibleSelectionChange}
            readOnly={readOnly || locked || loading}
          />
        )}
        {markdown && previewVisible && canRenderPreview && !loading && (
          <>
            <Tooltip.Provider delayDuration={150}>
              <Tooltip.Root open={previewScrollTooltipOpen} onOpenChange={setPreviewScrollTooltipOpen}>
                <Tooltip.Trigger asChild>
                  <button
                    type="button"
                    class={`editor-preview-scroll-toggle${previewScrollLocked ? ' is-locked' : ' is-unlocked'}${showModelStatusIndicator ? ' is-model-status-below' : ''}`}
                    aria-pressed={previewScrollLocked}
                    aria-label={previewScrollLocked ? 'Unlock preview scroll' : 'Lock preview scroll'}
                    onMouseEnter={openPreviewScrollTooltip}
                    onMouseLeave={closePreviewScrollTooltipSoon}
                    onClick={() => setPreviewScrollLocked((locked) => !locked)}
                  >
                    {previewScrollLocked ? (
                      <ArrowUpDown size={14} aria-hidden="true" />
                    ) : (
                      <LockOpen size={14} aria-hidden="true" />
                    )}
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    class="editor-preview-scroll-toggle-tooltip"
                    side="left"
                    align="center"
                    sideOffset={8}
                    onMouseEnter={openPreviewScrollTooltip}
                    onMouseLeave={closePreviewScrollTooltipSoon}
                  >
                    {previewScrollLocked ? 'Scroll sync on' : 'Scroll sync off'}
                    <Tooltip.Arrow class="editor-preview-scroll-toggle-tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
            <div
              class="editor-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSplitPointerDown}
            />
            <div
              class={`editor-preview-pane${previewRestorePending ? ' is-restoring-preview' : ''}`}
              ref={previewPaneRef}
            >
              {previewFrontMatterError ? <div class="editor-preview-alert">{previewFrontMatterError}</div> : null}
              {!previewFrontMatterError && previewCssWarning ? (
                <div class="editor-preview-alert">{previewCssWarning}</div>
              ) : null}
              {previewCustomCss ? (
                <style key={previewCustomCssScope ?? previewCustomCss}>{previewCustomCss}</style>
              ) : null}
              <div
                ref={renderedMarkdownRef}
                class="rendered-markdown"
                data-markdown-custom-css={previewCustomCssScope ?? undefined}
                onClick={onPreviewClick}
                onKeyDown={onPreviewKeyDown}
                onMouseDown={onRenderedMarkdownMouseDown}
                onMouseUp={onRenderedMarkdownMouseUp}
                onMouseMove={onRenderedMarkdownMouseMove}
                onMouseLeave={hidePreview}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          </>
        )}
      </div>
      {markdown && previewVisible && !canRenderPreview && !loading && (
        <>
          <div class="mobile-preview-backdrop" onClick={onTogglePreview} />
          <div class="mobile-preview-pane" ref={mobilePreviewPaneRef}>
            {previewFrontMatterError ? <div class="editor-preview-alert">{previewFrontMatterError}</div> : null}
            {!previewFrontMatterError && previewCssWarning ? (
              <div class="editor-preview-alert">{previewCssWarning}</div>
            ) : null}
            {previewCustomCss ? (
              <style key={previewCustomCssScope ?? previewCustomCss}>{previewCustomCss}</style>
            ) : null}
            <div
              ref={renderedMarkdownRef}
              class="rendered-markdown"
              data-markdown-custom-css={previewCustomCssScope ?? undefined}
              onClick={onPreviewClick}
              onKeyDown={onPreviewKeyDown}
              onMouseDown={onRenderedMarkdownMouseDown}
              onMouseUp={onRenderedMarkdownMouseUp}
              onMouseMove={onRenderedMarkdownMouseMove}
              onMouseLeave={hidePreview}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        </>
      )}
      <MarkdownLinkPreviewPopover preview={preview} />
    </div>
  );
}
