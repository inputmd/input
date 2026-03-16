import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ContentView } from './ContentView';
import {
  STACK_PEEK_WIDTH_PX,
  type StackEntry,
} from '../hooks/useDocumentStack';

interface MarkdownLinkPreview {
  title: string;
  html: string;
}

interface DocumentStackViewProps {
  entries: StackEntry[];
  baseTitle: string;
  onPopToIndex: (index: number) => void;
  onInternalLinkNavigate: (route: string) => void;
  onRequestMarkdownLinkPreview?: (route: string) => Promise<MarkdownLinkPreview | null>;
  onImageClick?: (image: HTMLImageElement) => void;
}

export function DocumentStackView({
  entries,
  baseTitle,
  onPopToIndex,
  onInternalLinkNavigate,
  onRequestMarkdownLinkPreview,
  onImageClick,
}: DocumentStackViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track which entries are "entering" for animation
  const [animatingIndex, setAnimatingIndex] = useState<number | null>(null);
  const prevEntryCountRef = useRef(entries.length);

  // Escape pops the topmost layer
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && entries.length > 0) {
        event.preventDefault();
        onPopToIndex(entries.length - 2);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [entries.length, onPopToIndex]);

  // Trigger slide-in animation when a new entry is pushed
  useEffect(() => {
    const prevCount = prevEntryCountRef.current;
    prevEntryCountRef.current = entries.length;

    if (entries.length > prevCount && entries.length > 0) {
      const newIndex = entries.length - 1;
      setAnimatingIndex(newIndex);
      // Force a reflow so the initial transform is applied before transition begins
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimatingIndex(null);
        });
      });
    }
  }, [entries.length]);

  const onLayerClick = useCallback(
    (index: number) => {
      if (index < entries.length - 1) {
        onPopToIndex(index);
      }
    },
    [entries.length, onPopToIndex],
  );

  const onBackdropClick = useCallback(
    (event: MouseEvent) => {
      // Only handle clicks directly on the backdrop (not on layers)
      if (event.target === containerRef.current) {
        onPopToIndex(-1);
      }
    },
    [onPopToIndex],
  );

  return (
    <div class="document-stack" ref={containerRef} onClick={onBackdropClick}>
      <div class="document-stack-base-peek">
        <span class="document-stack-base-peek-title">{baseTitle}</span>
      </div>
      {entries.map((entry, index) => {
        const isTopmost = index === entries.length - 1;
        const isAnimating = animatingIndex === index;
        // +1 to account for the base document underneath the stack
        const leftOffset = (index + 1) * STACK_PEEK_WIDTH_PX;

        return (
          <div
            key={`${entry.route}-${index}`}
            class={`document-stack-layer${isTopmost ? ' document-stack-layer--active' : ''}${isAnimating ? ' document-stack-layer--entering' : ''}`}
            style={{
              left: `${leftOffset}px`,
              width: `calc(100% - ${leftOffset}px)`,
              zIndex: index + 1,
            }}
            onClick={isTopmost ? undefined : () => onLayerClick(index)}
          >
            {!isTopmost ? (
              <div class="document-stack-layer-peek">
                <span class="document-stack-layer-peek-title">{entry.title}</span>
              </div>
            ) : null}
            <div class="document-stack-layer-content" inert={!isTopmost ? true : undefined}>
              <ContentView
                html={entry.html}
                markdown={entry.markdown}
                containScroll
                onInternalLinkNavigate={isTopmost ? onInternalLinkNavigate : undefined}
                onRequestMarkdownLinkPreview={isTopmost ? onRequestMarkdownLinkPreview : undefined}
                onImageClick={isTopmost ? onImageClick : undefined}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
