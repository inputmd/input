import { isolateHistory } from '@codemirror/commands';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { useCallback, useRef, useState } from 'preact/hooks';
import { type BracePromptRequest, findBracePromptMatch } from './codemirror_inline_prompt';

export interface BracePromptPanelState {
  request: BracePromptRequest;
  options: string[];
  draftOption: string;
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  top: number;
  left: number;
  maxWidth: number;
}

interface BracePromptPreviewState {
  from: number;
  to: number;
  text: string;
}

export type BracePromptStreamFn = (
  request: BracePromptRequest,
  callbacks: { onDelta: (delta: string) => void },
  signal: AbortSignal,
) => Promise<void>;

const BRACE_PROMPT_INACTIVITY_TIMEOUT_MS = 10_000;
const BRACE_PROMPT_MAX_DURATION_MS = 30_000;
const BRACE_PROMPT_MAX_RENDERED_OPTIONS = 4;
const BRACE_PROMPT_HOVER_PREVIEW_DEBOUNCE_MS = 150;

class BracePromptPreviewWidget extends WidgetType {
  private readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  eq(other: BracePromptPreviewWidget): boolean {
    return this.text === other.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-brace-prompt-preview';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function bracePromptPreviewExtension(preview: BracePromptPreviewState | null) {
  if (!preview) return [];
  return EditorView.decorations.of(
    Decoration.set([
      Decoration.replace({
        widget: new BracePromptPreviewWidget(preview.text),
        inclusive: true,
      }).range(preview.from, preview.to),
    ]),
  );
}

function adjustedBracePromptInsertionRange(doc: EditorState['doc'], from: number, option: string): number {
  if (!/^[,.;:!?)]/.test(option)) return from;

  let nextFrom = from;
  while (nextFrom > 0) {
    const previousChar = doc.sliceString(nextFrom - 1, nextFrom);
    if (previousChar !== ' ') break;
    nextFrom -= 1;
  }
  return nextFrom;
}

export function canBracePromptGenerateMore(panel: BracePromptPanelState): boolean {
  return !panel.loading && panel.options.length >= 3;
}

interface UseBracePromptPanelOptions {
  rootRef: { current: HTMLDivElement | null };
  onBracePromptStreamRef: { current: BracePromptStreamFn | undefined };
}

export function useBracePromptPanel({
  rootRef,
  onBracePromptStreamRef,
}: UseBracePromptPanelOptions) {
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<BracePromptPanelState | null>(null);
  const rawBufferRef = useRef('');
  const draftFlushTimerRef = useRef<number | null>(null);
  const inactivityTimerRef = useRef<number | null>(null);
  const maxDurationTimerRef = useRef<number | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const [panel, setPanel] = useState<BracePromptPanelState | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const setPanelState = useCallback((next: BracePromptPanelState | null) => {
    panelRef.current = next;
    setPanel(next);
  }, []);

  const clampPosition = useCallback((view: EditorView, position: number): number => {
    return Math.max(0, Math.min(position, view.state.doc.length));
  }, []);

  const computeLayout = useCallback(
    (view: EditorView, position: number): { top: number; left: number; maxWidth: number } | null => {
      const root = rootRef.current;
      if (!root) return null;
      const coords = view.coordsAtPos(clampPosition(view, position));
      if (!coords) return null;
      const rootRect = root.getBoundingClientRect();
      const scrollerRect = view.scrollDOM.getBoundingClientRect();
      const scrollerStyles = window.getComputedStyle(view.scrollDOM);
      const paddingRight = Number.parseFloat(scrollerStyles.paddingRight || '0') || 0;
      const contentRight = Math.min(rootRect.width - 12, scrollerRect.right - rootRect.left - paddingRight);
      const availableWidth = Math.max(240, Math.min(680, contentRight - 12));
      const panelWidth = Math.min(420, availableWidth);
      const left = Math.max(12, contentRight - panelWidth);
      return {
        top: Math.max(12, coords.bottom - rootRect.top + 8),
        left,
        maxWidth: availableWidth,
      };
    },
    [clampPosition, rootRef],
  );

  const close = useCallback(
    (options?: { abort?: boolean }) => {
      if (draftFlushTimerRef.current != null) {
        window.clearTimeout(draftFlushTimerRef.current);
        draftFlushTimerRef.current = null;
      }
      if (inactivityTimerRef.current != null) {
        window.clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      if (maxDurationTimerRef.current != null) {
        window.clearTimeout(maxDurationTimerRef.current);
        maxDurationTimerRef.current = null;
      }
      if (hoverTimerRef.current != null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      rawBufferRef.current = '';
      if (options?.abort !== false) {
        abortRef.current?.abort();
        abortRef.current = null;
      }
      setHoverIndex(null);
      setPanelState(null);
    },
    [setPanelState],
  );

  const scheduleHoverPreview = useCallback((index: number | null) => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }

    if (index == null) {
      setHoverIndex(null);
      return;
    }

    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHoverIndex(index);
    }, BRACE_PROMPT_HOVER_PREVIEW_DEBOUNCE_MS);
  }, []);

  const syncLayout = useCallback(
    (view: EditorView) => {
      const currentPanel = panelRef.current;
      if (!currentPanel) return;
      const layout = computeLayout(view, currentPanel.request.to);
      if (!layout) {
        close();
        return;
      }
      setPanelState({ ...currentPanel, ...layout });
    },
    [close, computeLayout, setPanelState],
  );

  const syncValidity = useCallback(
    (view: EditorView) => {
      const currentPanel = panelRef.current;
      if (!currentPanel) return;

      const selection = view.state.selection.main;
      if (!selection.empty || selection.head !== currentPanel.request.to) {
        close();
        return;
      }

      const line = view.state.doc.lineAt(selection.head);
      const match = findBracePromptMatch(line.text, selection.head - line.from);
      if (!match) {
        close();
        return;
      }

      const nextFrom = line.from + match.from;
      const nextTo = line.from + match.to;
      if (nextFrom !== currentPanel.request.from || nextTo !== currentPanel.request.to) {
        close();
        return;
      }

      syncLayout(view);
    },
    [close, syncLayout],
  );

  const launch = (view: EditorView, request: BracePromptRequest): boolean => {
    const runBracePromptStream = onBracePromptStreamRef.current;
    if (!runBracePromptStream) return false;
    const layout = computeLayout(view, request.to);
    if (!layout) return false;

    close();
    const controller = new AbortController();
    abortRef.current = controller;
    rawBufferRef.current = '';
    setPanelState({
      request,
      options: [],
      draftOption: '',
      selectedIndex: 0,
      loading: true,
      error: null,
      ...layout,
    });

    const normalizeBracePromptOption = (raw: string): string =>
      raw
        .trim()
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim();

    const flushDraftOption = () => {
      draftFlushTimerRef.current = null;
      const currentPanel = panelRef.current;
      if (!currentPanel) return;
      setPanelState({
        ...currentPanel,
        draftOption: normalizeBracePromptOption(rawBufferRef.current),
      });
    };

    const scheduleDraftFlush = (immediate = false) => {
      if (draftFlushTimerRef.current != null) {
        window.clearTimeout(draftFlushTimerRef.current);
        draftFlushTimerRef.current = null;
      }
      if (immediate) {
        flushDraftOption();
        return;
      }
      draftFlushTimerRef.current = window.setTimeout(flushDraftOption, 60);
    };

    const addFinalizedOption = (raw: string) => {
      const option = normalizeBracePromptOption(raw);
      if (!option) return;
      const currentPanel = panelRef.current;
      if (
        !currentPanel ||
        currentPanel.options.includes(option) ||
        currentPanel.options.length >= BRACE_PROMPT_MAX_RENDERED_OPTIONS
      ) {
        return;
      }
      setPanelState({
        ...currentPanel,
        options: [...currentPanel.options, option],
        draftOption: normalizeBracePromptOption(rawBufferRef.current),
        selectedIndex: currentPanel.options.length === 0 ? 0 : currentPanel.selectedIndex,
        error: null,
      });
    };

    const failBracePrompt = (message: string) => {
      if (draftFlushTimerRef.current != null) {
        window.clearTimeout(draftFlushTimerRef.current);
        draftFlushTimerRef.current = null;
      }
      if (inactivityTimerRef.current != null) {
        window.clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      if (maxDurationTimerRef.current != null) {
        window.clearTimeout(maxDurationTimerRef.current);
        maxDurationTimerRef.current = null;
      }

      const currentPanel = panelRef.current;
      if (currentPanel) {
        setPanelState({
          ...currentPanel,
          draftOption: normalizeBracePromptOption(rawBufferRef.current),
          loading: false,
          error: message,
        });
      }

      abortRef.current = null;
      controller.abort();
    };

    const resetInactivityTimeout = () => {
      if (inactivityTimerRef.current != null) {
        window.clearTimeout(inactivityTimerRef.current);
      }
      inactivityTimerRef.current = window.setTimeout(() => {
        failBracePrompt('Suggestions timed out waiting for more output');
      }, BRACE_PROMPT_INACTIVITY_TIMEOUT_MS);
    };

    maxDurationTimerRef.current = window.setTimeout(() => {
      failBracePrompt('Suggestions timed out');
    }, BRACE_PROMPT_MAX_DURATION_MS);
    resetInactivityTimeout();

    void runBracePromptStream(
      request,
      {
        onDelta: (delta) => {
          if (controller.signal.aborted) return;
          if (!delta) return;
          resetInactivityTimeout();
          const currentPanel = panelRef.current;
          if (currentPanel && currentPanel.options.length >= BRACE_PROMPT_MAX_RENDERED_OPTIONS) return;
          rawBufferRef.current += delta.replace(/\r/g, '');
          const lines = rawBufferRef.current.split('\n');
          rawBufferRef.current = lines.pop() ?? '';
          for (const lineText of lines) addFinalizedOption(lineText);
          const nextPanel = panelRef.current;
          if (nextPanel && nextPanel.options.length >= BRACE_PROMPT_MAX_RENDERED_OPTIONS) {
            rawBufferRef.current = '';
            scheduleDraftFlush(true);
            return;
          }
          scheduleDraftFlush(/[\s.,!?;:)]$/.test(rawBufferRef.current));
        },
      },
      controller.signal,
    )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (inactivityTimerRef.current != null) {
          window.clearTimeout(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        if (maxDurationTimerRef.current != null) {
          window.clearTimeout(maxDurationTimerRef.current);
          maxDurationTimerRef.current = null;
        }
        setPanelState({
          ...(panelRef.current ?? {
            request,
            options: [],
            draftOption: '',
            selectedIndex: 0,
            loading: false,
            error: null,
            ...layout,
          }),
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load suggestions',
        });
      })
      .finally(() => {
        if (abortRef.current !== controller || controller.signal.aborted) return;
        abortRef.current = null;
        if (inactivityTimerRef.current != null) {
          window.clearTimeout(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        if (maxDurationTimerRef.current != null) {
          window.clearTimeout(maxDurationTimerRef.current);
          maxDurationTimerRef.current = null;
        }
        if (rawBufferRef.current) addFinalizedOption(rawBufferRef.current);
        rawBufferRef.current = '';
        if (draftFlushTimerRef.current != null) {
          window.clearTimeout(draftFlushTimerRef.current);
          draftFlushTimerRef.current = null;
        }
        const currentPanel = panelRef.current;
        if (!currentPanel) return;
        setPanelState({
          ...currentPanel,
          draftOption: '',
          loading: false,
          error: currentPanel.error ?? (currentPanel.options.length === 0 ? 'No suggestions returned' : null),
        });
      });

    return true;
  };

  const start = (view: EditorView): boolean => {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const line = view.state.doc.lineAt(selection.head);
    const match = findBracePromptMatch(line.text, selection.head - line.from);
    if (!match) return false;

    return launch(view, {
      prompt: match.prompt,
      from: line.from + match.from,
      to: line.from + match.to,
      documentContent: view.state.doc.sliceString(0, line.from + match.to),
    });
  };

  const moveSelection = (direction: -1 | 1): boolean => {
    const currentPanel = panelRef.current;
    if (!currentPanel) return false;
    const generateMore = canBracePromptGenerateMore(currentPanel);
    const optionCount = currentPanel.options.length + (generateMore ? 1 : 0) + 1;
    const nextIndex = (currentPanel.selectedIndex + direction + optionCount) % optionCount;
    setPanelState({ ...currentPanel, selectedIndex: nextIndex });
    return true;
  };

  const acceptSelection = (view: EditorView, index?: number): boolean => {
    const currentPanel = panelRef.current;
    if (!currentPanel) return false;
    const optionIndex = index ?? currentPanel.selectedIndex;
    const generateMore = canBracePromptGenerateMore(currentPanel);
    if (generateMore && optionIndex === currentPanel.options.length) {
      return launch(view, currentPanel.request);
    }
    const closeIndex = currentPanel.options.length + (generateMore ? 1 : 0);
    if (optionIndex === closeIndex) {
      close();
      view.focus();
      return true;
    }
    const option = currentPanel.options[optionIndex];
    if (!option) return false;

    const insertionFrom = adjustedBracePromptInsertionRange(view.state.doc, currentPanel.request.from, option);
    const selectionEnd = insertionFrom + option.length;
    close();
    view.dispatch(
      view.state.update({
        changes: {
          from: insertionFrom,
          to: currentPanel.request.to,
          insert: option,
        },
        annotations: isolateHistory.of('full'),
        selection: { anchor: selectionEnd, head: selectionEnd },
        scrollIntoView: true,
        userEvent: 'input',
      }),
    );
    return true;
  };

  const isActive = (): boolean => panelRef.current != null;

  const destroy = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    panelRef.current = null;
    rawBufferRef.current = '';
    if (draftFlushTimerRef.current != null) {
      window.clearTimeout(draftFlushTimerRef.current);
      draftFlushTimerRef.current = null;
    }
    if (inactivityTimerRef.current != null) {
      window.clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    if (maxDurationTimerRef.current != null) {
      window.clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const getPreview = (): BracePromptPreviewState | null => {
    const previewIndex = hoverIndex ?? panel?.selectedIndex ?? null;
    if (!panel || previewIndex == null || previewIndex < 0 || previewIndex >= panel.options.length) return null;
    return {
      from: panel.request.from,
      to: panel.request.to,
      text: panel.options[previewIndex] ?? '',
    };
  };

  return {
    panel,
    hoverIndex,
    close,
    launch,
    start,
    moveSelection,
    acceptSelection,
    scheduleHoverPreview,
    syncLayout,
    syncValidity,
    isActive,
    destroy,
    getPreview,
  };
}
