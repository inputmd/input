import type { EditorView } from '@codemirror/view';
import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ExternalLink,
  Highlighter,
  History,
  LockOpen,
  Pin,
} from 'lucide-react';
import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { EditorChangeMarker } from '../components/codemirror_change_markers';
import type { EditorConflictWidget } from '../components/codemirror_conflict_widgets';
import type { EditorDiffPreview } from '../components/codemirror_diff_preview';
import type { BracePromptRequest } from '../components/codemirror_inline_prompt';
import type { EditorController, EditorProtectedRange } from '../components/editor_controller';
import { MarkdownEditor } from '../components/MarkdownEditor';
import type { PromptListRequest } from '../components/markdown_editor_commands';
import { PreviewHighlightsPopoverContent } from '../components/PreviewHighlightsPopover';
import { collectPreviewHighlights, type PreviewHighlightEntry } from '../components/preview_highlights';
import { TextEditor } from '../components/TextEditor';
import type { MarkdownSyncBlock } from '../markdown';
import {
  findPreviewHashTarget,
  resolveInternalNavigationRoute,
  resolveInternalPreviewRoute,
} from '../preview_navigation';
import { toggleNthMarkdownTaskCheckbox } from '../preview_task_list';
import {
  navigatePromptListBranch,
  setPromptListCollapsedStateInUrl,
  syncPromptListBranchNavigationButtons,
  syncPromptListCollapsedStateFromUrl,
  togglePromptAnswerExpandedState,
  togglePromptListCollapsedStateInUrl,
} from '../prompt_list_state';
import type { ReaderAiEditorOverlay } from '../reader_ai_editor_state';
import { getStoredScrollPosition } from '../scroll_positions';
import { findToggleListFromTarget, syncToggleListPersistedState, toggleToggleListState } from '../toggle_list_state';
import { MARKDOWN_EXT_RE } from '../util';
import { syncPromptPaneBleedVars } from './prompt_pane_vars';

const PREVIEW_SCROLL_LOCK_STORAGE_KEY = 'input_preview_scroll_locked_v1';
const PREVIEW_RESTORE_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th';
const PREVIEW_SYNC_SELECTOR = '[data-sync-id]';
const SCROLL_SYNC_ANCHOR_RATIO = 0.3;
const PREVIEW_LAYOUT_DRIFT_TOLERANCE_PX = 8;
const PREVIEW_RESTORE_MIN_SCROLL_TOP_PX = 24;

type ScrollPane = 'editor' | 'preview';

interface MarkdownLinkPreview {
  title: string;
  html: string;
}

interface LinkPreviewState {
  visible: boolean;
  loading: boolean;
  top: number;
  left: number;
  title: string;
  html: string;
  url: string | null;
}

function isMarkdownHref(href: string): boolean {
  const withoutSuffix = href.split(/[?#]/, 1)[0] ?? '';
  return MARKDOWN_EXT_RE.test(withoutSuffix);
}

function lastPathSegment(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  const parts = withoutQuery.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function footnoteTargetIdFromAnchor(anchor: HTMLAnchorElement): string | null {
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href.startsWith('#fn-')) return null;
  return href.slice(1);
}

function isMissingWikiLink(anchor: HTMLAnchorElement): boolean {
  return anchor.classList.contains('missing-wikilink');
}

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
  return (getStoredScrollPosition(scrollStorageKey) ?? 0) > PREVIEW_RESTORE_MIN_SCROLL_TOP_PX;
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

function isPointerDownOnVerticalScrollbar(pane: HTMLDivElement, event: PointerEvent): boolean {
  const scrollbarWidth = pane.offsetWidth - pane.clientWidth;
  if (scrollbarWidth <= 0) return false;
  const rect = pane.getBoundingClientRect();
  return event.clientX >= rect.right - scrollbarWidth;
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
  readerAiEditorOverlay?: ReaderAiEditorOverlay | null;
  onChangeMarkerClick?: (marker: EditorChangeMarker) => void;
  onReaderAiOpenReviewTarget?: (target: { changeId: string; hunkId?: string }) => void;
  onReaderAiApplyReviewTarget?: (target: { changeId: string; hunkId: string }) => void;
  onReaderAiKeepLocalReviewTarget?: (target: { changeId: string; hunkId: string }) => void;
  onReaderAiRestoreCheckpoint?: () => void;
  previewHtml: string;
  previewCustomCss?: string | null;
  previewCustomCssScope?: string | null;
  previewFrontMatterError?: string | null;
  previewCssWarning?: string | null;
  previewSyncBlocks?: MarkdownSyncBlock[];
  previewVisible: boolean;
  canRenderPreview: boolean;
  sidePaneWidth?: number;
  scrollStorageKey?: string | null;
  loading?: boolean;
  onTogglePreview: () => void;
  onSidePaneResize?: (width: number) => void;
  onContentChange: (update: { content: string; origin: 'userEdits'; revision: number }) => void;
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
  protectedEditRange?: EditorProtectedRange | null;
  onProtectedEditRangeChange?: (range: EditorProtectedRange | null) => void;
  onProtectedEditRangeBlocked?: () => void;
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

function readerAiBannerTone(
  fileStatus: ReaderAiEditorOverlay['fileStatus'],
): 'info' | 'success' | 'warning' | 'danger' {
  if (fileStatus === 'applied') return 'success';
  if (fileStatus === 'conflicted' || fileStatus === 'failed') return 'danger';
  if (fileStatus === 'stale' || fileStatus === 'partial' || fileStatus === 'superseded') return 'warning';
  return 'info';
}

function ReaderAiEditorReviewBar({
  overlay,
  onOpenReviewTarget,
  onRestoreCheckpoint,
}: {
  overlay: ReaderAiEditorOverlay;
  onOpenReviewTarget?: (target: { changeId: string; hunkId?: string }) => void;
  onRestoreCheckpoint?: () => void;
}) {
  if (overlay.fileStatus === 'idle' && !overlay.provenance && !overlay.checkpoint) return null;

  const tone = readerAiBannerTone(overlay.fileStatus);
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' ? AlertTriangle : History;
  const modelLabel = overlay.provenance?.modelId ?? 'Reader AI';
  const conflictCount = overlay.conflicts.length;
  const conflictSummary =
    conflictCount > 0
      ? `${conflictCount} conflicted hunk${conflictCount === 1 ? '' : 's'} need review in the editor below.`
      : null;

  return (
    <div class={`editor-reader-ai-banner editor-reader-ai-banner--${tone}`} role="status" aria-live="polite">
      <div class="editor-reader-ai-banner-main">
        <div class="editor-reader-ai-banner-copy">
          <div class="editor-reader-ai-banner-pills">
            <span class={`editor-reader-ai-pill editor-reader-ai-pill--${tone}`}>
              <Icon size={13} aria-hidden="true" />
              <span>{overlay.statusLabel}</span>
            </span>
            {overlay.provenance ? <span class="editor-reader-ai-pill">Reader AI</span> : null}
            {overlay.provenance?.modelId ? (
              <span class="editor-reader-ai-pill">{overlay.provenance.modelId}</span>
            ) : null}
            {overlay.checkpoint ? <span class="editor-reader-ai-pill">Checkpoint ready</span> : null}
          </div>
          <div class="editor-reader-ai-banner-title">{modelLabel}</div>
          {overlay.statusMessage ? <div class="editor-reader-ai-banner-message">{overlay.statusMessage}</div> : null}
        </div>
        <div class="editor-reader-ai-banner-actions">
          {overlay.primaryChangeId ? (
            <button
              type="button"
              class="editor-reader-ai-action editor-reader-ai-action--secondary"
              onClick={() => onOpenReviewTarget?.({ changeId: overlay.primaryChangeId! })}
            >
              Review in panel
            </button>
          ) : null}
          {overlay.checkpoint ? (
            <button
              type="button"
              class="editor-reader-ai-action editor-reader-ai-action--primary"
              onClick={() => onRestoreCheckpoint?.()}
            >
              Restore checkpoint
            </button>
          ) : null}
        </div>
      </div>
      {conflictSummary ? (
        <div class="editor-reader-ai-conflict-summary">
          <span>{conflictSummary}</span>
          {overlay.primaryChangeId ? (
            <button
              type="button"
              class="editor-reader-ai-action editor-reader-ai-action--secondary"
              onClick={() => onOpenReviewTarget?.({ changeId: overlay.primaryChangeId! })}
            >
              Review in panel
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function EditView({
  fileName = null,
  markdown = true,
  content,
  contentOrigin = 'external',
  contentRevision = 0,
  contentSelection = null,
  readerAiEditorOverlay = null,
  onChangeMarkerClick,
  onReaderAiOpenReviewTarget,
  onReaderAiApplyReviewTarget,
  onReaderAiKeepLocalReviewTarget,
  onReaderAiRestoreCheckpoint,
  previewHtml,
  previewCustomCss = null,
  previewCustomCssScope = null,
  previewFrontMatterError = null,
  previewCssWarning = null,
  previewSyncBlocks = [],
  previewVisible,
  canRenderPreview,
  sidePaneWidth = 480,
  scrollStorageKey = null,
  loading = false,
  onTogglePreview,
  onSidePaneResize,
  onContentChange,
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
  protectedEditRange = null,
  onProtectedEditRangeChange,
  onProtectedEditRangeBlocked,
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
  const diffPreview: EditorDiffPreview | null = readerAiEditorOverlay?.diffPreview ?? null;
  const changeMarkers: EditorChangeMarker[] | null = readerAiEditorOverlay?.markers ?? null;
  const conflictWidgets: EditorConflictWidget[] | null = readerAiEditorOverlay
    ? readerAiEditorOverlay.hunks.flatMap((hunk) => {
        if (!hunk.conflictReason) return [];
        const conflict =
          readerAiEditorOverlay.conflicts.find(
            (entry) => entry.changeId === hunk.changeId && entry.hunkId === hunk.hunkId,
          ) ?? null;
        return [
          {
            id: `${hunk.changeId}:${hunk.hunkId}`,
            lineNumber: hunk.lineStart,
            title: hunk.header,
            message: conflict?.message ?? readerAiEditorOverlay.statusMessage ?? 'Reader AI needs review.',
            currentText: conflict?.currentText ?? null,
            proposedText: conflict?.proposedText ?? null,
            baseText: conflict?.baseText ?? null,
            tone: hunk.status === 'stale' ? 'stale' : 'conflicted',
            changeId: hunk.changeId,
            hunkId: hunk.hunkId,
            disabled: readOnly || locked || loading,
          } satisfies EditorConflictWidget,
        ];
      })
    : null;
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
  const scrollOwnerRef = useRef<ScrollPane | null>('editor');
  const hoverAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const hoverRequestIdRef = useRef(0);
  const hoverDelayTimerRef = useRef<number | null>(null);
  const previewRestoreFrameRef = useRef<number | null>(null);
  const previewScrollTooltipCloseTimeoutRef = useRef<number | null>(null);
  const previewHighlightsPopoverCloseTimeoutRef = useRef<number | null>(null);
  const previewSyncElementsRef = useRef<HTMLElement[]>([]);
  const previewSyncElementByIdRef = useRef<Map<string, HTMLElement>>(new Map());
  const previewHighlightElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const lastAppliedPreviewHashKeyRef = useRef<string | null>(null);
  const lastUnlockedPreviewScrollTopRef = useRef(0);
  const lastPreviewSyncEditorTopRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const pointerDraggedRef = useRef(false);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
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
  const [desktopHighlightsPopoverOpen, setDesktopHighlightsPopoverOpen] = useState(false);
  const [desktopHighlightsPopoverPinned, setDesktopHighlightsPopoverPinned] = useState(false);
  const [mobileHighlightsPopoverOpen, setMobileHighlightsPopoverOpen] = useState(false);
  const [previewHighlightEntries, setPreviewHighlightEntries] = useState<PreviewHighlightEntry[]>([]);
  const [editorControllerReadyVersion, setEditorControllerReadyVersion] = useState(0);
  const lastPreviewRestoreKeyRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<LinkPreviewState>({
    visible: false,
    loading: false,
    top: 0,
    left: 0,
    title: '',
    html: '',
    url: null,
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

  const clearHoverDelay = useCallback(() => {
    if (hoverDelayTimerRef.current == null) return;
    window.clearTimeout(hoverDelayTimerRef.current);
    hoverDelayTimerRef.current = null;
  }, []);

  const hidePreview = useCallback(() => {
    clearHoverDelay();
    hoverAnchorRef.current = null;
    hoverRequestIdRef.current += 1;
    setPreview((prev) => (prev.visible || prev.loading ? { ...prev, visible: false, loading: false } : prev));
  }, [clearHoverDelay]);

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

  const clearPreviewHighlightsPopoverCloseTimeout = useCallback(() => {
    if (previewHighlightsPopoverCloseTimeoutRef.current == null) return;
    window.clearTimeout(previewHighlightsPopoverCloseTimeoutRef.current);
    previewHighlightsPopoverCloseTimeoutRef.current = null;
  }, []);

  const openDesktopHighlightsPopover = useCallback(() => {
    clearPreviewHighlightsPopoverCloseTimeout();
    setMobileHighlightsPopoverOpen(false);
    setDesktopHighlightsPopoverOpen(true);
  }, [clearPreviewHighlightsPopoverCloseTimeout]);

  const closeDesktopHighlightsPopoverSoon = useCallback(() => {
    if (desktopHighlightsPopoverPinned) return;
    clearPreviewHighlightsPopoverCloseTimeout();
    previewHighlightsPopoverCloseTimeoutRef.current = window.setTimeout(() => {
      previewHighlightsPopoverCloseTimeoutRef.current = null;
      setDesktopHighlightsPopoverOpen(false);
    }, 120);
  }, [clearPreviewHighlightsPopoverCloseTimeout, desktopHighlightsPopoverPinned]);

  const toggleDesktopHighlightsPopoverPinned = useCallback(() => {
    clearPreviewHighlightsPopoverCloseTimeout();
    setMobileHighlightsPopoverOpen(false);
    setDesktopHighlightsPopoverPinned((pinned) => {
      const nextPinned = !pinned;
      setDesktopHighlightsPopoverOpen(nextPinned);
      return nextPinned;
    });
  }, [clearPreviewHighlightsPopoverCloseTimeout]);

  const handleDesktopHighlightsPopoverOpenChange = useCallback(
    (open: boolean) => {
      clearPreviewHighlightsPopoverCloseTimeout();
      setDesktopHighlightsPopoverOpen(open);
      if (!open) setDesktopHighlightsPopoverPinned(false);
      if (open) setMobileHighlightsPopoverOpen(false);
    },
    [clearPreviewHighlightsPopoverCloseTimeout],
  );

  const handleMobileHighlightsPopoverOpenChange = useCallback(
    (open: boolean) => {
      setMobileHighlightsPopoverOpen(open);
      if (open) {
        clearPreviewHighlightsPopoverCloseTimeout();
        setDesktopHighlightsPopoverOpen(false);
      }
    },
    [clearPreviewHighlightsPopoverCloseTimeout],
  );

  const scrollToHash = useCallback((hash: string, behavior: ScrollBehavior = 'auto') => {
    const target = findPreviewHashTarget(renderedMarkdownRef.current, hash);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'start', behavior });
    return true;
  }, []);

  const getEditorScrollMetrics = useCallback(() => {
    return (
      editorControllerRef.current?.getScrollMetrics() ?? {
        top: window.scrollY,
        max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      }
    );
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

  const cancelPendingPreviewSyncFromEditor = useCallback(() => {
    if (editorToPreviewScrollFrameRef.current != null) {
      window.cancelAnimationFrame(editorToPreviewScrollFrameRef.current);
      editorToPreviewScrollFrameRef.current = null;
    }
    if (ignorePreviewScrollFrameRef.current != null) {
      window.cancelAnimationFrame(ignorePreviewScrollFrameRef.current);
      ignorePreviewScrollFrameRef.current = null;
    }
    ignoreNextPreviewScrollRef.current = false;
  }, []);

  const cancelPendingEditorSyncFromPreview = useCallback(() => {
    if (previewToEditorScrollFrameRef.current != null) {
      window.cancelAnimationFrame(previewToEditorScrollFrameRef.current);
      previewToEditorScrollFrameRef.current = null;
    }
    if (editorScrollLerpFrameRef.current != null) {
      window.cancelAnimationFrame(editorScrollLerpFrameRef.current);
      editorScrollLerpFrameRef.current = null;
    }
    if (ignoreEditorScrollFrameRef.current != null) {
      window.cancelAnimationFrame(ignoreEditorScrollFrameRef.current);
      ignoreEditorScrollFrameRef.current = null;
    }
    editorScrollLerpTargetRef.current = null;
    ignoreNextEditorScrollRef.current = false;
  }, []);

  const claimScrollOwnership = useCallback(
    (pane: ScrollPane) => {
      if (scrollOwnerRef.current === pane) return;
      scrollOwnerRef.current = pane;
      if (pane === 'editor') {
        cancelPendingEditorSyncFromPreview();
        return;
      }
      cancelPendingPreviewSyncFromEditor();
    },
    [cancelPendingEditorSyncFromPreview, cancelPendingPreviewSyncFromEditor],
  );

  const handlePreviewHighlightSelect = useCallback(
    (id: string) => {
      const pane = canRenderPreview ? previewPaneRef.current : mobilePreviewPaneRef.current;
      const element = previewHighlightElementsRef.current.get(id);
      if (!pane || !element) return;

      if (canRenderPreview && previewScrollLocked) {
        claimScrollOwnership('preview');
      }

      const paneRect = pane.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const nextScrollTop = clampScrollTop(
        elementRect.top - paneRect.top + pane.scrollTop - pane.clientHeight / 2 + elementRect.height / 2,
        maxScrollTop(pane),
      );

      pane.scrollTop = nextScrollTop;
      lastUnlockedPreviewScrollTopRef.current = nextScrollTop;
      setDesktopHighlightsPopoverOpen(false);
      setMobileHighlightsPopoverOpen(false);
    },
    [canRenderPreview, claimScrollOwnership, previewScrollLocked],
  );

  const setPreviewScrollTop = useCallback(
    (scrollTop: number, tolerancePx = 1) => {
      const pane = previewPaneRef.current;
      if (!pane) return;
      const nextScrollTop = clampScrollTop(scrollTop, maxScrollTop(pane));
      if (Math.abs(pane.scrollTop - nextScrollTop) < tolerancePx) return;
      ignoreNextPreviewScrollRef.current = true;
      schedulePreviewScrollIgnoreReset();
      pane.scrollTop = nextScrollTop;
    },
    [schedulePreviewScrollIgnoreReset],
  );

  const applyEditorScrollTop = useCallback(
    (nextScrollTop: number) => {
      const controller = editorControllerRef.current;
      if (!controller) return;
      const { top, max } = controller.getScrollMetrics();
      const clampedScrollTop = clampScrollTop(nextScrollTop, max);
      if (Math.abs(top - clampedScrollTop) < 1) return;
      ignoreNextEditorScrollRef.current = true;
      scheduleEditorScrollIgnoreReset();
      controller.setScrollTop(clampedScrollTop);
    },
    [scheduleEditorScrollIgnoreReset],
  );

  const editorScrollLerpTick = useCallback(() => {
    editorScrollLerpFrameRef.current = null;
    const target = editorScrollLerpTargetRef.current;
    if (target == null) return;

    const controller = editorControllerRef.current;
    if (!controller) {
      editorScrollLerpTargetRef.current = null;
      return;
    }
    const { top: current, max } = controller.getScrollMetrics();
    const clampedTarget = clampScrollTop(target, max);
    const delta = clampedTarget - current;

    if (Math.abs(delta) < 1) {
      editorScrollLerpTargetRef.current = null;
      applyEditorScrollTop(clampedTarget);
      return;
    }

    applyEditorScrollTop(current + delta * 0.25);
    editorScrollLerpFrameRef.current = window.requestAnimationFrame(editorScrollLerpTick);
  }, [applyEditorScrollTop]);

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
    (hit: SyncBlockHit, tolerancePx = 1): boolean => {
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
          setPreviewScrollTop(interpolatedY - anchorOffset, tolerancePx);
          return true;
        }
      }

      const nextScrollTop = primary.top + primary.height * hit.progress - anchorOffset;
      setPreviewScrollTop(nextScrollTop, tolerancePx);
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
    if (!markdown || !previewVisible || !canRenderPreview || loading || !previewScrollLocked || previewRestorePending)
      return;
    const pane = previewPaneRef.current;
    if (!pane) return;
    const { top: sourceTop, max: sourceMax } = getEditorScrollMetrics();
    const previewMax = maxScrollTop(pane);
    const editorScrollStable =
      lastPreviewSyncEditorTopRef.current != null && Math.abs(sourceTop - lastPreviewSyncEditorTopRef.current) < 0.5;
    const driftTolerancePx = editorScrollStable ? PREVIEW_LAYOUT_DRIFT_TOLERANCE_PX : 1;

    if (sourceTop <= 1 || sourceMax <= 0) {
      setPreviewScrollTop(0);
      lastPreviewSyncEditorTopRef.current = sourceTop;
      return;
    }
    if (previewMax > 0 && sourceTop >= sourceMax - 1) {
      setPreviewScrollTop(previewMax);
      lastPreviewSyncEditorTopRef.current = sourceTop;
      return;
    }

    const controller = editorControllerRef.current;
    if (controller && previewSyncBlocks.length > 0 && previewSyncElementByIdRef.current.size > 0) {
      const position = controller.getViewportAnchorPosition(SCROLL_SYNC_ANCHOR_RATIO);
      const hit = findSyncBlockForPosition(previewSyncBlocks, position);
      if (hit && scrollPreviewToSyncHit(hit, driftTolerancePx)) {
        lastPreviewSyncEditorTopRef.current = sourceTop;
        return;
      }
    }

    if (previewMax <= 0) {
      setPreviewScrollTop(0);
      lastPreviewSyncEditorTopRef.current = sourceTop;
      return;
    }

    const progress = sourceMax <= 0 ? 0 : Math.max(0, Math.min(1, sourceTop / sourceMax));
    setPreviewScrollTop(progress * previewMax, driftTolerancePx);
    lastPreviewSyncEditorTopRef.current = sourceTop;
  }, [
    canRenderPreview,
    getEditorScrollMetrics,
    loading,
    markdown,
    previewRestorePending,
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
    if (!markdown || !previewVisible || !canRenderPreview || loading || !previewScrollLocked || previewRestorePending)
      return;
    const pane = previewPaneRef.current;
    if (!pane) return;
    const previewMax = maxScrollTop(pane);

    if (pane.scrollTop <= 1 || previewMax <= 0) {
      setEditorScrollTop(0);
      return;
    }

    const { max: editorMax } = getEditorScrollMetrics();
    if (pane.scrollTop >= previewMax - 1) {
      setEditorScrollTop(editorMax);
      return;
    }

    if (previewSyncBlocks.length > 0) {
      const anchor = getPreviewSyncAnchor();
      const block = anchor ? findSyncBlockById(previewSyncBlocks, anchor.id) : null;
      if (anchor && block) {
        const targetPosition = Math.round(block.from + (block.to - block.from) * anchor.progress);
        if (scrollEditorToSyncTarget(targetPosition)) return;
      }
    }

    const progress = previewMax <= 0 ? 0 : Math.max(0, Math.min(1, pane.scrollTop / previewMax));
    setEditorScrollTop(progress * editorMax);
  }, [
    canRenderPreview,
    getPreviewSyncAnchor,
    getEditorScrollMetrics,
    loading,
    markdown,
    previewRestorePending,
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
      clearHoverDelay();
    };
  }, [clearHoverDelay]);

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
    if (!previewScrollLocked) {
      scrollOwnerRef.current = null;
      cancelPendingPreviewSyncFromEditor();
      cancelPendingEditorSyncFromPreview();
      return;
    }
    claimScrollOwnership('editor');
    requestPreviewScrollSync();
  }, [
    cancelPendingEditorSyncFromPreview,
    cancelPendingPreviewSyncFromEditor,
    claimScrollOwnership,
    previewScrollLocked,
    requestPreviewScrollSync,
  ]);

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
    void editorControllerReadyVersion;
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
          ignoreNextPreviewScrollRef.current = true;
          schedulePreviewScrollIgnoreReset();
          scrollOwnerRef.current = null;

          let restored = false;
          if (previewSyncBlocks.length > 0 && previewSyncElementByIdRef.current.size > 0) {
            const position = controller.getViewportAnchorPosition(SCROLL_SYNC_ANCHOR_RATIO);
            const hit = findSyncBlockForPosition(previewSyncBlocks, position);
            if (hit) {
              restored = scrollPreviewToSyncHit(hit, 0);
            }
          }

          if (!restored) {
            const topVisibleText = controller.getTopVisibleText(240);
            const target = topVisibleText ? findPreviewRestoreTarget(root, topVisibleText) : null;
            if (target) {
              pane.scrollTop = Math.max(0, target.offsetTop - 8);
              restored = true;
            }
          }

          scrollOwnerRef.current = 'editor';
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
  }, [
    editorControllerReadyVersion,
    previewRestorePending,
    previewSyncBlocks,
    schedulePreviewScrollIgnoreReset,
    scrollPreviewToSyncHit,
  ]);

  useLayoutEffect(() => {
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

  useLayoutEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !previewVisible || !previewHtml || !root) return;

    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][disabled]').forEach((checkbox) => {
      checkbox.disabled = false;
      checkbox.setAttribute('aria-label', checkbox.checked ? 'Mark task incomplete' : 'Mark task complete');
    });
  }, [markdown, previewHtml, previewVisible]);

  useEffect(() => {
    if (!markdown || !previewVisible || !previewHtml) {
      lastAppliedPreviewHashKeyRef.current = null;
      return;
    }

    const hash = window.location.hash;
    if (!hash) {
      lastAppliedPreviewHashKeyRef.current = null;
      return;
    }

    const routeKey = `${fileName ?? ''}:${hash}`;
    if (lastAppliedPreviewHashKeyRef.current === routeKey) return;

    let cancelled = false;
    window.requestAnimationFrame(() => {
      if (cancelled) return;
      if (canRenderPreview && previewScrollLocked) claimScrollOwnership('preview');
      if (!scrollToHash(hash, 'auto')) return;
      lastAppliedPreviewHashKeyRef.current = routeKey;
    });

    return () => {
      cancelled = true;
    };
  }, [
    canRenderPreview,
    claimScrollOwnership,
    fileName,
    markdown,
    previewHtml,
    previewScrollLocked,
    previewVisible,
    scrollToHash,
  ]);

  useLayoutEffect(() => {
    if (!markdown || !previewVisible || !canRenderPreview || loading || !previewScrollLocked || previewRestorePending)
      return;
    if (scrollOwnerRef.current == null) scrollOwnerRef.current = 'editor';
    requestPreviewScrollSync();
  }, [
    canRenderPreview,
    loading,
    markdown,
    previewRestorePending,
    previewScrollLocked,
    previewVisible,
    requestPreviewScrollSync,
  ]);

  useLayoutEffect(() => {
    if (!previewHtml) return;
    if (!markdown || !previewVisible || !canRenderPreview || loading || !previewScrollLocked || previewRestorePending)
      return;
    if (scrollOwnerRef.current == null) scrollOwnerRef.current = 'editor';
    requestPreviewScrollSync();
  }, [
    canRenderPreview,
    loading,
    markdown,
    previewHtml,
    previewRestorePending,
    previewScrollLocked,
    previewVisible,
    requestPreviewScrollSync,
  ]);

  useEffect(() => {
    if (!markdown || !previewVisible || !canRenderPreview || loading || previewRestorePending) return;
    if (!previewScrollLocked) return;
    void editorControllerReadyVersion;
    const pane = previewPaneRef.current;
    const controller = editorControllerRef.current;
    if (!pane || !controller) return;

    const handleEditorInteraction = () => {
      claimScrollOwnership('editor');
    };
    const handlePreviewInteraction = () => {
      claimScrollOwnership('preview');
    };
    const handlePreviewPointerDown = (event: PointerEvent) => {
      if (!isPointerDownOnVerticalScrollbar(pane, event)) return;
      claimScrollOwnership('preview');
    };
    const requestEditorDrivenSync = () => {
      if (ignoreNextEditorScrollRef.current) return;
      if (scrollOwnerRef.current !== 'editor') return;
      requestPreviewScrollSync();
    };
    const requestPreviewDrivenSync = () => {
      if (ignoreNextPreviewScrollRef.current) return;
      if (scrollOwnerRef.current !== 'preview') return;
      requestEditorScrollSync();
    };
    requestPreviewScrollSync();
    const unsubscribeEditorScroll = controller.subscribeScroll(requestEditorDrivenSync);
    const unsubscribeEditorInteraction = controller.subscribeInteraction(handleEditorInteraction);
    pane.addEventListener('wheel', handlePreviewInteraction, { passive: true });
    pane.addEventListener('touchmove', handlePreviewInteraction, { passive: true });
    pane.addEventListener('pointerdown', handlePreviewPointerDown, { passive: true });
    pane.addEventListener('scroll', requestPreviewDrivenSync, { passive: true });

    return () => {
      unsubscribeEditorScroll();
      unsubscribeEditorInteraction();
      pane.removeEventListener('wheel', handlePreviewInteraction);
      pane.removeEventListener('touchmove', handlePreviewInteraction);
      pane.removeEventListener('pointerdown', handlePreviewPointerDown);
      pane.removeEventListener('scroll', requestPreviewDrivenSync);
    };
  }, [
    canRenderPreview,
    claimScrollOwnership,
    editorControllerReadyVersion,
    loading,
    markdown,
    previewRestorePending,
    previewScrollLocked,
    previewVisible,
    requestEditorScrollSync,
    requestPreviewScrollSync,
  ]);

  useEffect(() => {
    if (!markdown || !previewVisible || !canRenderPreview || loading || previewRestorePending) return;
    if (!previewScrollLocked) return;

    const handleWindowResize = () => {
      if (scrollOwnerRef.current === 'preview') {
        requestEditorScrollSync();
        return;
      }
      requestPreviewScrollSync();
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [
    canRenderPreview,
    loading,
    markdown,
    previewRestorePending,
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
      scrollOwnerRef.current = null;
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

    syncToggleListPersistedState(root);
    syncPromptListCollapsedStateFromUrl(root, false);
    syncPromptListBranchNavigationButtons(root);
  }, [markdown, previewHtml, previewVisible]);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !previewVisible || !root) return;

    const sync = () => syncPromptListCollapsedStateFromUrl(root, false);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [markdown, previewVisible]);

  const onSplitPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!previewVisible || !canRenderPreview || !onSidePaneResize) return;
    const container = splitRef.current;
    if (!container) return;

    const startRect = container.getBoundingClientRect();
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      onSidePaneResize(startRect.right - moveEvent.clientX);
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
      ? { gridTemplateColumns: `minmax(0, 1fr) 7px ${sidePaneWidth}px` }
      : undefined;

  const showPreviewForAnchor = useCallback(
    (anchor: HTMLAnchorElement) => {
      if (!onRequestMarkdownLinkPreview) return;
      if (isMissingWikiLink(anchor)) {
        hidePreview();
        return;
      }
      const route = resolveInternalPreviewRoute(anchor);
      if (!route || !isMarkdownHref(route)) {
        hidePreview();
        return;
      }

      const rect = anchor.getBoundingClientRect();
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: true,
        top: Math.round(rect.bottom + 8),
        left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
        title: lastPathSegment(route),
        html: '',
        url: null,
      });

      void onRequestMarkdownLinkPreview(route)
        .then((result) => {
          if (hoverRequestIdRef.current !== requestId) return;
          if (!result) {
            hidePreview();
            return;
          }
          setPreview((prev) => ({
            ...prev,
            visible: true,
            loading: false,
            title: result.title || prev.title,
            html: result.html,
            url: null,
          }));
        })
        .catch(() => {
          if (hoverRequestIdRef.current !== requestId) return;
          hidePreview();
        });
    },
    [hidePreview, onRequestMarkdownLinkPreview],
  );

  const showCitationPreviewForAnchor = useCallback(
    (anchor: HTMLAnchorElement) => {
      const targetId = footnoteTargetIdFromAnchor(anchor);
      if (!targetId) {
        hidePreview();
        return;
      }

      const root = renderedMarkdownRef.current;
      if (!root) {
        hidePreview();
        return;
      }

      const target = root.querySelector<HTMLElement>(`#${CSS.escape(targetId)}`);
      if (!target) {
        hidePreview();
        return;
      }

      const clone = target.cloneNode(true);
      if (!(clone instanceof HTMLElement)) {
        hidePreview();
        return;
      }

      clone.querySelectorAll('.footnote-backrefs').forEach((backrefs) => {
        backrefs.remove();
      });
      const htmlContent = clone.innerHTML.trim();
      if (!htmlContent) {
        hidePreview();
        return;
      }

      const rect = anchor.getBoundingClientRect();
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: false,
        top: Math.round(rect.bottom + 8),
        left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
        title: `Citation ${anchor.textContent?.trim() || ''}`.trim(),
        html: htmlContent,
        url: null,
      });
    },
    [hidePreview],
  );

  const onRenderedMarkdownMouseMove = useCallback(
    (event: MouseEvent) => {
      if (pointerDownRef.current && pointerDownPositionRef.current) {
        const dx = Math.abs(event.clientX - pointerDownPositionRef.current.x);
        const dy = Math.abs(event.clientY - pointerDownPositionRef.current.y);
        if (dx > 4 || dy > 4) pointerDraggedRef.current = true;
      }
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a') as HTMLAnchorElement | null;
      if (!anchor) {
        if (hoverAnchorRef.current) hidePreview();
        return;
      }

      if (anchor === hoverAnchorRef.current && preview.visible) return;
      clearHoverDelay();
      hoverDelayTimerRef.current = window.setTimeout(() => {
        if (isMissingWikiLink(anchor)) {
          hidePreview();
          return;
        }
        if (footnoteTargetIdFromAnchor(anchor)) {
          showCitationPreviewForAnchor(anchor);
          return;
        }
        const route = resolveInternalPreviewRoute(anchor);
        if (route && isMarkdownHref(route) && onRequestMarkdownLinkPreview) {
          showPreviewForAnchor(anchor);
          return;
        }
        hidePreview();
      }, 120);
    },
    [
      clearHoverDelay,
      hidePreview,
      onRequestMarkdownLinkPreview,
      preview.visible,
      showCitationPreviewForAnchor,
      showPreviewForAnchor,
    ],
  );

  const onRenderedMarkdownMouseDown = useCallback((event: MouseEvent) => {
    if (event.button !== 0) return;
    pointerDownRef.current = true;
    pointerDraggedRef.current = false;
    pointerDownPositionRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const onRenderedMarkdownMouseUp = useCallback(() => {
    pointerDownRef.current = false;
    pointerDownPositionRef.current = null;
  }, []);

  const handlePreviewPromptListLayoutChange = useCallback(() => {
    const pane = previewPaneRef.current;
    if (!pane) return;

    ignoreNextPreviewScrollRef.current = true;
    schedulePreviewScrollIgnoreReset();

    if (previewScrollLocked) {
      if (scrollOwnerRef.current === 'preview') {
        requestEditorScrollSync();
      } else {
        requestPreviewScrollSync();
      }
      return;
    }

    pane.scrollTop = clampScrollTop(pane.scrollTop, maxScrollTop(pane));
  }, [previewScrollLocked, requestEditorScrollSync, requestPreviewScrollSync, schedulePreviewScrollIgnoreReset]);

  const handlePreviewPaneScroll = useCallback((event: JSX.TargetedEvent<HTMLDivElement, Event>) => {
    lastUnlockedPreviewScrollTopRef.current = (event.currentTarget as HTMLDivElement).scrollTop;
  }, []);

  useLayoutEffect(() => {
    if (!markdown || !previewVisible || loading || previewScrollLocked) return;
    void previewHtml;
    const pane = canRenderPreview ? previewPaneRef.current : mobilePreviewPaneRef.current;
    if (!pane) return;

    pane.scrollTop = clampScrollTop(lastUnlockedPreviewScrollTopRef.current, maxScrollTop(pane));
  }, [canRenderPreview, loading, markdown, previewHtml, previewVisible, previewScrollLocked]);

  useEffect(() => {
    const pane = canRenderPreview ? previewPaneRef.current : mobilePreviewPaneRef.current;
    const root = renderedMarkdownRef.current;
    previewHighlightElementsRef.current.clear();

    if (!markdown || !previewVisible || !previewHtml || !pane || !root) {
      setPreviewHighlightEntries([]);
      return;
    }

    const { entries, elementsById } = collectPreviewHighlights(root);
    previewHighlightElementsRef.current = elementsById;
    setPreviewHighlightEntries(entries);
  }, [canRenderPreview, markdown, previewHtml, previewVisible]);

  useEffect(() => {
    if (previewVisible) return;
    setDesktopHighlightsPopoverOpen(false);
    setDesktopHighlightsPopoverPinned(false);
    setMobileHighlightsPopoverOpen(false);
  }, [previewVisible]);

  useEffect(() => {
    return () => {
      clearPreviewHighlightsPopoverCloseTimeout();
    };
  }, [clearPreviewHighlightsPopoverCloseTimeout]);

  const togglePreviewTaskCheckbox = useCallback(
    (checkbox: HTMLInputElement) => {
      const controller = editorControllerRef.current;
      if (!controller) return false;

      const syncElement = checkbox.closest<HTMLElement>('[data-sync-id]');
      const syncId = syncElement?.dataset.syncId?.trim() ?? '';
      if (!syncElement || !syncId) return false;

      const syncBlock = findSyncBlockById(previewSyncBlocks, syncId);
      if (!syncBlock) return false;

      const checkboxIndex = Array.from(
        syncElement.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ).indexOf(checkbox);
      if (checkboxIndex < 0) return false;

      const blockSource = content.slice(syncBlock.from, syncBlock.to);
      const toggle = toggleNthMarkdownTaskCheckbox(blockSource, checkboxIndex);
      if (!toggle) return false;

      return controller.applyExternalChange({
        from: syncBlock.from + toggle.from,
        to: syncBlock.from + toggle.to,
        insert: toggle.insert,
        addToHistory: true,
      });
    },
    [content, previewSyncBlocks],
  );

  const onPreviewClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const taskCheckbox = target?.closest('input[type="checkbox"]');
    if (taskCheckbox instanceof HTMLInputElement) {
      event.preventDefault();
      claimScrollOwnership('preview');
      if (togglePreviewTaskCheckbox(taskCheckbox)) {
        handlePreviewPromptListLayoutChange();
      }
      return;
    }

    const branchNav = target?.closest('.prompt-list-branch-nav');
    if (branchNav instanceof HTMLElement) {
      event.preventDefault();
      claimScrollOwnership('preview');
      navigatePromptListBranch(branchNav, { behavior: 'smooth' });
      return;
    }

    const answerToggle = target?.closest('.prompt-answer-toggle');
    if (answerToggle instanceof HTMLElement) {
      event.preventDefault();
      claimScrollOwnership('preview');
      const answer = answerToggle.closest('li.prompt-answer');
      if (answer instanceof HTMLElement) {
        const conversation = answer.closest('.prompt-list-conversation');
        if (conversation instanceof HTMLElement && conversation.getAttribute('data-collapsed') === 'true') {
          setPromptListCollapsedStateInUrl(conversation, false, false, { syncAnswers: false });
        }
        togglePromptAnswerExpandedState(answer, { keepTopInViewOnCollapse: true });
        handlePreviewPromptListLayoutChange();
      }
      return;
    }

    const toggleList = findToggleListFromTarget(target);
    if (toggleList) {
      event.preventDefault();
      claimScrollOwnership('preview');
      toggleToggleListState(toggleList);
      handlePreviewPromptListLayoutChange();
      return;
    }

    const toggle = target?.closest('.prompt-list-caption');
    if (toggle instanceof HTMLElement) {
      event.preventDefault();
      claimScrollOwnership('preview');
      const container = toggle.closest('.prompt-list-conversation');
      if (container instanceof HTMLElement) {
        togglePromptListCollapsedStateInUrl(container, false);
        handlePreviewPromptListLayoutChange();
      }
      return;
    }

    const anchor = target?.closest('a') as HTMLAnchorElement | null;
    if (anchor && !pointerDraggedRef.current) {
      const href = (anchor.getAttribute('href') || '').trim();
      if (href.startsWith('#')) {
        event.preventDefault();
        claimScrollOwnership('preview');
        scrollToHash(href, 'smooth');
        return;
      }

      const route = resolveInternalNavigationRoute(anchor);
      if (route && onInternalLinkNavigate) {
        event.preventDefault();
        claimScrollOwnership('preview');
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
    const toggleList = findToggleListFromTarget(target);
    if (toggleList && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      claimScrollOwnership('preview');
      toggleToggleListState(toggleList);
      handlePreviewPromptListLayoutChange();
      return;
    }

    const toggle = target?.closest('.prompt-list-caption');
    if (!(toggle instanceof HTMLElement)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    claimScrollOwnership('preview');
    const container = toggle.closest('.prompt-list-conversation');
    if (container instanceof HTMLElement) {
      togglePromptListCollapsedStateInUrl(container, false);
      handlePreviewPromptListLayoutChange();
    }
  };

  const handleEditorReady = useCallback(
    (controller: EditorController | null) => {
      editorControllerRef.current = controller;
      setEditorControllerReadyVersion((version) => version + 1);
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
        {readerAiEditorOverlay ? (
          <ReaderAiEditorReviewBar
            overlay={readerAiEditorOverlay}
            onOpenReviewTarget={onReaderAiOpenReviewTarget}
            onRestoreCheckpoint={onReaderAiRestoreCheckpoint}
          />
        ) : null}
        {markdown ? (
          <MarkdownEditor
            class="doc-editor"
            content={content}
            contentOrigin={contentOrigin}
            contentRevision={contentRevision}
            contentSelection={contentSelection}
            diffPreview={diffPreview}
            changeMarkers={changeMarkers}
            onChangeMarkerClick={onChangeMarkerClick}
            conflictWidgets={conflictWidgets}
            onConflictWidgetKeepMine={onReaderAiKeepLocalReviewTarget}
            onConflictWidgetUseAi={onReaderAiApplyReviewTarget}
            onConflictWidgetReview={(target) => onReaderAiOpenReviewTarget?.(target)}
            scrollStorageKey={scrollStorageKey}
            onContentChange={onContentChange}
            onEditorReady={handleEditorReady}
            onEligibleSelectionChange={onEligibleSelectionChange}
            onBracePromptStream={onBracePromptStream}
            onPromptListSubmit={onPromptListSubmit}
            onCancelInlinePrompt={onCancelInlinePrompt}
            inlinePromptActive={inlinePromptActive}
            onPaste={onEditorPaste}
            readOnly={readOnly || locked || loading}
            protectedEditRange={protectedEditRange}
            onProtectedEditRangeChange={onProtectedEditRangeChange}
            onProtectedEditRangeBlocked={onProtectedEditRangeBlocked}
          />
        ) : (
          <TextEditor
            class="doc-editor"
            fileName={fileName}
            content={content}
            contentOrigin={contentOrigin}
            contentRevision={contentRevision}
            contentSelection={contentSelection}
            diffPreview={diffPreview}
            changeMarkers={changeMarkers}
            onChangeMarkerClick={onChangeMarkerClick}
            conflictWidgets={conflictWidgets}
            onConflictWidgetKeepMine={onReaderAiKeepLocalReviewTarget}
            onConflictWidgetUseAi={onReaderAiApplyReviewTarget}
            onConflictWidgetReview={(target) => onReaderAiOpenReviewTarget?.(target)}
            scrollStorageKey={scrollStorageKey}
            onContentChange={onContentChange}
            onEditorReady={handleEditorReady}
            onEligibleSelectionChange={onEligibleSelectionChange}
            readOnly={readOnly || locked || loading}
          />
        )}
        {markdown && previewVisible && canRenderPreview && !loading && (
          <>
            <div class={`editor-preview-controls${showModelStatusIndicator ? ' is-model-status-below' : ''}`}>
              <Popover.Root open={desktopHighlightsPopoverOpen} onOpenChange={handleDesktopHighlightsPopoverOpenChange}>
                <Popover.Anchor asChild>
                  <button
                    type="button"
                    class="editor-preview-highlights-toggle"
                    aria-label="Show document highlights"
                    aria-haspopup="dialog"
                    aria-expanded={desktopHighlightsPopoverOpen}
                    onMouseEnter={openDesktopHighlightsPopover}
                    onMouseLeave={closeDesktopHighlightsPopoverSoon}
                    onClick={toggleDesktopHighlightsPopoverPinned}
                  >
                    {desktopHighlightsPopoverPinned ? (
                      <Pin size={14} aria-hidden="true" />
                    ) : (
                      <Highlighter size={14} aria-hidden="true" />
                    )}
                  </button>
                </Popover.Anchor>
                <Popover.Portal>
                  <Popover.Content
                    class="editor-preview-highlights-popover-content"
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={12}
                    onOpenAutoFocus={(event: Event) => {
                      event.preventDefault();
                    }}
                    onCloseAutoFocus={(event: Event) => {
                      event.preventDefault();
                    }}
                    onInteractOutside={(event: Event) => {
                      if (!desktopHighlightsPopoverPinned) return;
                      event.preventDefault();
                    }}
                    onMouseEnter={openDesktopHighlightsPopover}
                    onMouseLeave={closeDesktopHighlightsPopoverSoon}
                  >
                    <PreviewHighlightsPopoverContent
                      entries={previewHighlightEntries}
                      onSelect={handlePreviewHighlightSelect}
                    />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              <Tooltip.Provider delayDuration={150}>
                <Tooltip.Root open={previewScrollTooltipOpen} onOpenChange={setPreviewScrollTooltipOpen}>
                  <Tooltip.Trigger asChild>
                    <button
                      type="button"
                      class={`editor-preview-scroll-toggle${previewScrollLocked ? ' is-locked' : ' is-unlocked'}`}
                      aria-pressed={previewScrollLocked}
                      aria-label={previewScrollLocked ? 'Lock preview scroll' : 'Unlock preview scroll'}
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
                      side="top"
                      align="end"
                      sideOffset={8}
                      onMouseEnter={openPreviewScrollTooltip}
                      onMouseLeave={closePreviewScrollTooltipSoon}
                    >
                      {previewScrollLocked ? 'Scroll sync on' : 'Scroll sync off'}
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            </div>
            <div
              class="editor-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSplitPointerDown}
            />
            <div
              class={`editor-preview-pane${previewRestorePending ? ' is-restoring-preview' : ''}`}
              ref={previewPaneRef}
              data-markdown-custom-css-content={previewCustomCssScope ?? undefined}
              data-markdown-custom-css-main={previewCustomCssScope ?? undefined}
              onScroll={handlePreviewPaneScroll}
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
                data-enable-task-list-toggles="true"
                data-hide-prompt-answer-less="true"
                data-toggle-list-storage-key={scrollStorageKey ?? undefined}
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
          <div
            class="mobile-preview-pane"
            ref={mobilePreviewPaneRef}
            data-markdown-custom-css-content={previewCustomCssScope ?? undefined}
            data-markdown-custom-css-main={previewCustomCssScope ?? undefined}
            onScroll={handlePreviewPaneScroll}
          >
            <div class="mobile-preview-controls">
              <Popover.Root open={mobileHighlightsPopoverOpen} onOpenChange={handleMobileHighlightsPopoverOpenChange}>
                <Popover.Anchor asChild>
                  <button
                    type="button"
                    class="mobile-preview-highlights-toggle"
                    aria-label="Show document highlights"
                    aria-haspopup="dialog"
                    aria-expanded={mobileHighlightsPopoverOpen}
                    onClick={() => setMobileHighlightsPopoverOpen(true)}
                  >
                    <Highlighter size={14} aria-hidden="true" />
                    <span>Highlights</span>
                  </button>
                </Popover.Anchor>
                <Popover.Portal>
                  <Popover.Content
                    class="editor-preview-highlights-popover-content mobile-preview-highlights-popover-content"
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={16}
                    onOpenAutoFocus={(event: Event) => {
                      event.preventDefault();
                    }}
                    onCloseAutoFocus={(event: Event) => {
                      event.preventDefault();
                    }}
                  >
                    <PreviewHighlightsPopoverContent
                      entries={previewHighlightEntries}
                      onSelect={handlePreviewHighlightSelect}
                    />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>
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
              data-enable-task-list-toggles="true"
              data-hide-prompt-answer-less="true"
              data-toggle-list-storage-key={scrollStorageKey ?? undefined}
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
      {preview.visible ? (
        <div
          class={`markdown-link-preview-popover${preview.url ? ' markdown-link-preview-popover--url' : ''}`}
          style={{
            top: `${preview.top}px`,
            left: `${preview.left}px`,
          }}
          aria-live="polite"
        >
          {preview.url ? null : <div class="markdown-link-preview-title">{preview.title}</div>}
          {preview.loading ? (
            <div class="markdown-link-preview-status">Loading preview...</div>
          ) : preview.url ? (
            <div class="markdown-link-preview-url">
              <span class="markdown-link-preview-url-text">{preview.url}</span>
              <ExternalLink aria-hidden="true" size={12} strokeWidth={2} />
            </div>
          ) : (
            <div class="markdown-link-preview-body" dangerouslySetInnerHTML={{ __html: preview.html }} />
          )}
        </div>
      ) : null}
    </div>
  );
}
