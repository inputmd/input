import { useCallback, useRef, useState } from 'preact/hooks';

/** Minimum width of each stack layer as a percentage of available width. */
export const STACK_LAYER_MIN_WIDTH_PCT = 70;

/** Width in pixels of the exposed "peek" strip for underlying layers. */
export const STACK_PEEK_WIDTH_PX = 40;

/** Hard cap on the number of stacked layers (including the base document). */
export const STACK_MAX_LAYERS = 6;

/** Duration of slide animations in milliseconds. */
export const STACK_ANIMATION_MS = 250;

export interface StackEntry {
  /** Route pathname for this document (e.g. "owner/repo/path/to/file.md"). */
  route: string;
  /** Rendered HTML content. */
  html: string;
  /** Display title (file name). */
  title: string;
  /** Whether this is a markdown document. */
  markdown: boolean;
}

export interface DocumentStackState {
  /** All stack entries. Index 0 is always the base document (not shown in the stack overlay). */
  entries: StackEntry[];
  /** Index of the topmost visible layer. */
  activeIndex: number;
}

export function useDocumentStack() {
  const [entries, setEntries] = useState<StackEntry[]>([]);
  const entriesRef = useRef<StackEntry[]>([]);
  entriesRef.current = entries;

  const pushEntry = useCallback((entry: StackEntry) => {
    setEntries((prev) => [...prev, entry]);
  }, []);

  const popToIndex = useCallback((index: number) => {
    setEntries((prev) => {
      if (index < 0) return [];
      return prev.slice(0, index + 1);
    });
  }, []);

  const clearStack = useCallback(() => {
    setEntries([]);
  }, []);

  const canPush = useCallback(
    (availableWidth: number): boolean => {
      const currentCount = entriesRef.current.length;
      if (currentCount >= STACK_MAX_LAYERS) return false;
      // Each stack layer plus the base document each need STACK_PEEK_WIDTH_PX,
      // and the topmost needs STACK_LAYER_MIN_WIDTH_PCT of available width
      const minTopWidth = (availableWidth * STACK_LAYER_MIN_WIDTH_PCT) / 100;
      const peekSpace = (currentCount + 1) * STACK_PEEK_WIDTH_PX;
      return peekSpace + minTopWidth <= availableWidth;
    },
    [],
  );

  return {
    entries,
    pushEntry,
    popToIndex,
    clearStack,
    canPush,
    hasStack: entries.length > 0,
  };
}
