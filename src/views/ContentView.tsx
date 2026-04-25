import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { ArrowLeft, ChevronDown, ExternalLink, Highlighter, Pin } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { isClaudeSessionPath } from '../claude_session';
import { ClaudeSessionTreeView } from '../components/ClaudeSessionTreeView';
import { ContentAlert } from '../components/ContentAlert';
import { PiSessionTreeView } from '../components/PiSessionTreeView';
import { PreviewHighlightsPopoverContent } from '../components/PreviewHighlightsPopover';
import { PromptAnswerCommentComposer } from '../components/PromptAnswerCommentComposer';
import { collectPreviewHighlights, type PreviewHighlightEntry } from '../components/preview_highlights';
import { TextCodeView } from '../components/TextCodeView';
import { blurOnClose } from '../dom_utils';
import { useMarkdownCustomCss } from '../hooks/useMarkdownCustomCss';
import { parseMarkdownToHtml } from '../markdown';
import { isNotePath, parseNoteJsonl } from '../notes';
import { isPiSessionPath } from '../pi_session';
import {
  findPreviewHashTarget,
  resolveInternalNavigationRoute,
  resolveInternalPreviewRoute,
} from '../preview_navigation';
import {
  capturePromptAnswerExpandedStates,
  capturePromptListCollapsedStates,
  consumeSuppressedPromptAnswerToggle,
  hasNonCollapsedSelectionIntersectingNode,
  type PromptAnswerExpandedStateSnapshot,
  type PromptListCollapsedStateSnapshot,
  restorePromptAnswerExpandedStates,
  restorePromptListCollapsedStates,
  setPromptListMode,
  togglePromptAnswerExpandedState,
} from '../prompt_list_state';
import { getStoredScrollPosition, setStoredScrollPosition } from '../scroll_positions';
import type { SessionReferenceIndex } from '../session_index';
import { getSessionReferenceChildren, getSessionReferenceParents } from '../session_index';
import {
  formatSessionCardDate,
  formatSessionCardDateTitle,
  parseSessionCardMetadata,
  type SessionCardMetadata,
} from '../session_metadata';
import { findToggleListFromTarget, syncToggleListPersistedState, toggleToggleListState } from '../toggle_list_state';
import { isExternalHttpHref, MARKDOWN_EXT_RE } from '../util';
import { syncPromptPaneBleedVars } from './prompt_pane_vars';

interface MarkdownLinkPreview {
  title: string;
  html: string;
}

export interface ContentSessionFile {
  path: string;
  content: string;
}

export interface ContentSessionViewFile extends ContentSessionFile {
  deleted?: boolean;
}

interface ContentViewProps {
  html: string;
  markdown: boolean;
  fileSelected?: boolean;
  markdownCustomCss?: string | null;
  markdownCustomCssScope?: string | null;
  scrollStorageKey?: string | null;
  plainText?: string | null;
  plainTextFileName?: string | null;
  sessionFile?: ContentSessionViewFile | null;
  sessionFiles?: ContentSessionFile[];
  sessionFilesLoading?: boolean;
  claudeCredentialAvailable?: boolean | null;
  piCredentialAvailable?: boolean | null;
  onLaunchClaude?: () => boolean | undefined | Promise<boolean | undefined>;
  onLaunchPi?: () => boolean | undefined | Promise<boolean | undefined>;
  onAskClaude?: (message: string) => boolean | undefined | Promise<boolean | undefined>;
  onAskPi?: (message: string) => boolean | undefined | Promise<boolean | undefined>;
  onPostNote?: (message: string) => boolean | undefined | Promise<boolean | undefined>;
  onOpenSession?: (path: string) => void;
  onSessionHref?: (path: string) => string | null;
  onDeleteSession?: (path: string) => void | Promise<void>;
  onAddSessionChild?: (parentPath: string, childPath: string) => void | Promise<void>;
  onRemoveSessionChild?: (parentPath: string, childPath: string) => void | Promise<void>;
  sessionReferenceIndex?: SessionReferenceIndex;
  onBackFromSession?: () => void;
  onContinueClaudeSession?: (sessionId: string) => void;
  onContinuePiSession?: (sessionPath: string) => void;
  goToLineRequest?: { requestKey: number; lineNumber: number } | null;
  loading?: boolean;
  imagePreview?: { src: string; alt: string } | null;
  alertMessage?: string | null;
  alertDownloadHref?: string | null;
  alertDownloadName?: string | null;
  currentUserAvatarUrl?: string | null;
  /** When true, hash links scroll within the component instead of the window. */
  containScroll?: boolean;
  onInternalLinkNavigate?: (route: string) => void;
  onRequestMarkdownLinkPreview?: (route: string) => Promise<MarkdownLinkPreview | null>;
  onImageClick?: (image: HTMLImageElement) => void;
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

function formatAgentLaunchLabel(agentName: string, credentialAvailable: boolean | null): string {
  if (credentialAvailable === null) return `Checking ${agentName}...`;
  return credentialAvailable ? `Start empty ${agentName} session` : `Log in to ${agentName}`;
}

function formatSessionCardAgentLabel(agentName: string): string | null {
  if (agentName === 'Note') return null;
  return agentName;
}

function formatSessionReferenceLabel(path: string, metadata: SessionCardMetadata): string {
  const message = metadata.firstUserMessage?.replace(/\s+/g, ' ').trim();
  return message || lastPathSegment(path);
}

function footnoteTargetIdFromAnchor(anchor: HTMLAnchorElement): string | null {
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href.startsWith('#fn-')) return null;
  return href.slice(1);
}

function isMissingWikiLink(anchor: HTMLAnchorElement): boolean {
  return anchor.classList.contains('missing-wikilink');
}

export function ContentView({
  html,
  markdown,
  fileSelected = true,
  markdownCustomCss = null,
  markdownCustomCssScope = null,
  scrollStorageKey = null,
  plainText = null,
  plainTextFileName = null,
  sessionFile = null,
  sessionFiles = [],
  sessionFilesLoading = false,
  claudeCredentialAvailable = null,
  piCredentialAvailable = null,
  onLaunchClaude,
  onLaunchPi,
  onAskClaude,
  onAskPi,
  onPostNote,
  onOpenSession,
  onSessionHref,
  onDeleteSession,
  onAddSessionChild,
  onRemoveSessionChild,
  sessionReferenceIndex = { version: 1, children: {} },
  onBackFromSession,
  onContinueClaudeSession,
  onContinuePiSession,
  goToLineRequest = null,
  loading = false,
  imagePreview,
  alertMessage,
  alertDownloadHref,
  alertDownloadName,
  currentUserAvatarUrl = null,
  containScroll = false,
  onInternalLinkNavigate,
  onRequestMarkdownLinkPreview,
  onImageClick,
}: ContentViewProps) {
  const contentViewRef = useRef<HTMLDivElement | null>(null);
  const renderedMarkdownRef = useRef<HTMLDivElement | null>(null);
  const imagePreviewRef = useRef<HTMLImageElement | null>(null);
  const hoverAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const hoverRequestIdRef = useRef(0);
  const hoverDelayTimerRef = useRef<number | null>(null);
  const previewHighlightsPopoverCloseTimeoutRef = useRef<number | null>(null);
  const previewHighlightElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const pointerDownRef = useRef(false);
  const pointerDraggedRef = useRef(false);
  const pointerDownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const currentScrollStorageKeyRef = useRef<string | null>(null);
  const promptListCollapsedStatesRef = useRef<PromptListCollapsedStateSnapshot | null>(null);
  const promptAnswerExpandedStatesRef = useRef<PromptAnswerExpandedStateSnapshot | null>(null);
  const [previewHighlightEntries, setPreviewHighlightEntries] = useState<PreviewHighlightEntry[]>([]);
  const [previewHighlightsPopoverOpen, setPreviewHighlightsPopoverOpen] = useState(false);
  const [previewHighlightsPopoverPinned, setPreviewHighlightsPopoverPinned] = useState(false);
  const [preview, setPreview] = useState<LinkPreviewState>({
    visible: false,
    loading: false,
    top: 0,
    left: 0,
    title: '',
    html: '',
    url: null,
  });
  const [imagePreviewLoading, setImagePreviewLoading] = useState(true);
  const [newSessionMessage, setNewSessionMessage] = useState('');
  const [newSessionSubmittingAgent, setNewSessionSubmittingAgent] = useState<'claude' | 'pi' | 'note' | null>(null);
  const [newSessionMenuOpen, setNewSessionMenuOpen] = useState(false);
  const newSessionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { inlineCss: markdownInlineCss, pendingExternalFonts: markdownFontsPending } = useMarkdownCustomCss(
    markdown ? markdownCustomCss : null,
  );
  const isEmpty = html.trim().length === 0 && (plainText === null || plainText.length === 0) && !imagePreview;
  const sessionMetadataByPath = useMemo(() => {
    const metadata = new Map<string, SessionCardMetadata>();
    for (const session of sessionFiles) {
      metadata.set(session.path, parseSessionCardMetadata(session.path, session.content));
    }
    return metadata;
  }, [sessionFiles]);
  const sortedSessionFiles = useMemo(
    () =>
      [...sessionFiles].sort((left, right) => {
        const leftDate = sessionMetadataByPath.get(left.path)?.lastMessageDate?.getTime() ?? -Infinity;
        const rightDate = sessionMetadataByPath.get(right.path)?.lastMessageDate?.getTime() ?? -Infinity;
        if (leftDate !== rightDate) return rightDate - leftDate;
        return left.path.localeCompare(right.path);
      }),
    [sessionFiles, sessionMetadataByPath],
  );
  const sessionFileByPath = useMemo(
    () => new Map(sessionFiles.map((session) => [session.path, session])),
    [sessionFiles],
  );
  const sessionPaths = useMemo(() => new Set(sessionFiles.map((session) => session.path)), [sessionFiles]);
  const sortedSessionIndexByPath = useMemo(
    () => new Map(sortedSessionFiles.map((session, index) => [session.path, index])),
    [sortedSessionFiles],
  );
  const topLevelSessionFiles = useMemo(
    () =>
      sortedSessionFiles.filter((session) =>
        getSessionReferenceParents(sessionReferenceIndex, session.path).every(
          (parentPath) => !sessionPaths.has(parentPath),
        ),
      ),
    [sessionPaths, sessionReferenceIndex, sortedSessionFiles],
  );
  const childSessionFilesByParentPath = useMemo(() => {
    const childFilesByParentPath = new Map<string, ContentSessionFile[]>();
    for (const parentPath of sessionPaths) {
      const childFiles = getSessionReferenceChildren(sessionReferenceIndex, parentPath)
        .map((childPath) => sessionFileByPath.get(childPath))
        .filter((childFile): childFile is ContentSessionFile => Boolean(childFile))
        .sort((left, right) => {
          const leftIndex = sortedSessionIndexByPath.get(left.path) ?? Number.MAX_SAFE_INTEGER;
          const rightIndex = sortedSessionIndexByPath.get(right.path) ?? Number.MAX_SAFE_INTEGER;
          if (leftIndex !== rightIndex) return leftIndex - rightIndex;
          return left.path.localeCompare(right.path);
        });
      if (childFiles.length > 0) childFilesByParentPath.set(parentPath, childFiles);
    }
    return childFilesByParentPath;
  }, [sessionFileByPath, sessionPaths, sessionReferenceIndex, sortedSessionIndexByPath]);
  const sessionReferenceFileByPath = useMemo(() => {
    const filesByPath = new Map(sessionFileByPath);
    if (sessionFile && !sessionFile.deleted) filesByPath.set(sessionFile.path, sessionFile);
    return filesByPath;
  }, [sessionFile, sessionFileByPath]);
  const showSessionFile = sessionFile !== null;
  const showSessionList = !fileSelected && isEmpty && !showSessionFile;
  const showSessionLoading = !fileSelected && isEmpty && sessionFilesLoading && !showSessionFile;
  const newSessionMessageTrimmed = newSessionMessage.trim();
  const newSessionSubmitting = newSessionSubmittingAgent !== null;
  const claudeLoginRequired = claudeCredentialAvailable === false;
  const piLoginRequired = piCredentialAvailable === false;
  const askClaudeDisabled = newSessionSubmitting || claudeCredentialAvailable === null || !onAskClaude;
  const askPiDisabled = newSessionSubmitting || piCredentialAvailable === null || !onAskPi;
  const postNoteDisabled = newSessionSubmitting || !onPostNote;
  const showNewSessionMenu = Boolean(onLaunchClaude || onLaunchPi);

  const submitNewSessionMessage = useCallback(
    async (agent: 'claude' | 'pi') => {
      if (newSessionSubmittingAgent !== null) return;
      const handler = agent === 'claude' ? onAskClaude : onAskPi;
      const loginRequired = agent === 'claude' ? claudeLoginRequired : piLoginRequired;
      if (!handler || (!loginRequired && newSessionMessageTrimmed.length === 0)) return;
      setNewSessionSubmittingAgent(agent);
      try {
        const submitted = await handler(newSessionMessageTrimmed);
        if (!loginRequired && submitted !== false) setNewSessionMessage('');
      } finally {
        setNewSessionSubmittingAgent(null);
      }
    },
    [claudeLoginRequired, newSessionMessageTrimmed, newSessionSubmittingAgent, onAskClaude, onAskPi, piLoginRequired],
  );

  const submitNewNote = useCallback(async () => {
    if (newSessionSubmittingAgent !== null || !onPostNote || newSessionMessageTrimmed.length === 0) return;
    setNewSessionSubmittingAgent('note');
    try {
      const posted = await onPostNote(newSessionMessageTrimmed);
      if (posted !== false) setNewSessionMessage('');
    } finally {
      setNewSessionSubmittingAgent(null);
    }
  }, [newSessionMessageTrimmed, newSessionSubmittingAgent, onPostNote]);

  const noteMarkdown = useMemo(() => {
    if (!sessionFile || sessionFile.deleted || !isNotePath(sessionFile.path)) return null;
    return parseNoteJsonl(sessionFile.content)?.text ?? sessionFile.content;
  }, [sessionFile]);
  const noteHtml = useMemo(() => (noteMarkdown === null ? '' : parseMarkdownToHtml(noteMarkdown)), [noteMarkdown]);

  const resizeNewSessionTextarea = useCallback(() => {
    const textarea = newSessionTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }, []);

  useLayoutEffect(() => {
    void newSessionMessage;
    resizeNewSessionTextarea();
  }, [newSessionMessage, resizeNewSessionTextarea]);

  const scrollToHash = useCallback((hash: string, behavior: ScrollBehavior = 'auto') => {
    const target = findPreviewHashTarget(renderedMarkdownRef.current, hash);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'start', behavior });
    return true;
  }, []);

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

  const clearPreviewHighlightsPopoverCloseTimeout = useCallback(() => {
    if (previewHighlightsPopoverCloseTimeoutRef.current == null) return;
    window.clearTimeout(previewHighlightsPopoverCloseTimeoutRef.current);
    previewHighlightsPopoverCloseTimeoutRef.current = null;
  }, []);

  const openPreviewHighlightsPopover = useCallback(() => {
    clearPreviewHighlightsPopoverCloseTimeout();
    setPreviewHighlightsPopoverOpen(true);
  }, [clearPreviewHighlightsPopoverCloseTimeout]);

  const closePreviewHighlightsPopoverSoon = useCallback(() => {
    if (previewHighlightsPopoverPinned) return;
    clearPreviewHighlightsPopoverCloseTimeout();
    previewHighlightsPopoverCloseTimeoutRef.current = window.setTimeout(() => {
      previewHighlightsPopoverCloseTimeoutRef.current = null;
      setPreviewHighlightsPopoverOpen(false);
    }, 120);
  }, [clearPreviewHighlightsPopoverCloseTimeout, previewHighlightsPopoverPinned]);

  const togglePreviewHighlightsPopoverPinned = useCallback(() => {
    clearPreviewHighlightsPopoverCloseTimeout();
    setPreviewHighlightsPopoverPinned((pinned) => {
      const nextPinned = !pinned;
      setPreviewHighlightsPopoverOpen(nextPinned);
      return nextPinned;
    });
  }, [clearPreviewHighlightsPopoverCloseTimeout]);

  const handlePreviewHighlightsPopoverOpenChange = useCallback(
    (open: boolean) => {
      clearPreviewHighlightsPopoverCloseTimeout();
      setPreviewHighlightsPopoverOpen(open);
      if (!open) setPreviewHighlightsPopoverPinned(false);
    },
    [clearPreviewHighlightsPopoverCloseTimeout],
  );

  useEffect(() => {
    return () => {
      clearHoverDelay();
    };
  }, [clearHoverDelay]);

  useEffect(() => {
    return () => {
      clearPreviewHighlightsPopoverCloseTimeout();
    };
  }, [clearPreviewHighlightsPopoverCloseTimeout]);

  const rememberPromptListStates = useCallback(() => {
    const root = renderedMarkdownRef.current;
    if (!root) return;
    promptListCollapsedStatesRef.current = capturePromptListCollapsedStates(root);
    promptAnswerExpandedStatesRef.current = capturePromptAnswerExpandedStates(root);
  }, []);

  useEffect(() => {
    const syncScrollPosition = () => {
      const key = currentScrollStorageKeyRef.current;
      if (!key) return;
      setStoredScrollPosition(key, window.scrollY);
    };

    window.addEventListener('scroll', syncScrollPosition, { passive: true });
    return () => {
      syncScrollPosition();
      window.removeEventListener('scroll', syncScrollPosition);
    };
  }, []);

  useEffect(() => {
    const previousKey = currentScrollStorageKeyRef.current;
    if (previousKey === scrollStorageKey) return;

    if (previousKey) {
      setStoredScrollPosition(previousKey, window.scrollY);
    }

    currentScrollStorageKeyRef.current = scrollStorageKey;
    const nextScrollTop = scrollStorageKey ? (getStoredScrollPosition(scrollStorageKey) ?? 0) : 0;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
    });
  }, [scrollStorageKey]);

  useEffect(() => {
    if (loading) return;
    if (!scrollStorageKey) return;
    const nextScrollTop = getStoredScrollPosition(scrollStorageKey) ?? 0;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
    });
  }, [loading, scrollStorageKey]);

  useEffect(() => {
    if (!markdown || loading) return;
    if (!html) return;
    const hash = window.location.hash;
    if (!hash) return;
    window.requestAnimationFrame(() => scrollToHash(hash, 'auto'));
  }, [html, loading, markdown, scrollToHash]);

  useEffect(() => {
    if (!markdown) return;
    const onHashChange = () => scrollToHash(window.location.hash, 'auto');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [markdown, scrollToHash]);

  useEffect(() => {
    const contentView = contentViewRef.current;
    const pane = contentView?.closest('main') ?? contentView;
    const markdownRoot = renderedMarkdownRef.current;
    if (!markdown || markdownFontsPending || !pane || !markdownRoot) return;

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
  }, [markdown, markdownFontsPending]);

  useLayoutEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || markdownFontsPending || !html || !root) return;

    syncToggleListPersistedState(root);
    restorePromptListCollapsedStates(root, promptListCollapsedStatesRef.current, 'collapse-responses');
    restorePromptAnswerExpandedStates(root, promptAnswerExpandedStatesRef.current);
    rememberPromptListStates();
  }, [html, markdown, markdownFontsPending, rememberPromptListStates]);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    previewHighlightElementsRef.current.clear();

    if (!markdown || markdownFontsPending || !html || !root) {
      setPreviewHighlightEntries([]);
      return;
    }

    const { entries, elementsById } = collectPreviewHighlights(root);
    previewHighlightElementsRef.current = elementsById;
    setPreviewHighlightEntries(entries);
  }, [html, markdown, markdownFontsPending]);

  const handlePreviewHighlightSelect = useCallback((id: string) => {
    const target = previewHighlightElementsRef.current.get(id);
    if (!target) return;
    setPreviewHighlightsPopoverPinned(false);
    setPreviewHighlightsPopoverOpen(false);
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !root) return;

    const sync = () => {
      restorePromptListCollapsedStates(root, promptListCollapsedStatesRef.current, 'collapse-responses');
      restorePromptAnswerExpandedStates(root, promptAnswerExpandedStatesRef.current);
      rememberPromptListStates();
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [markdown, rememberPromptListStates]);

  useEffect(() => {
    const root = renderedMarkdownRef.current;
    if (!markdown || !html || !root) return;

    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
    if (images.length === 0) return;

    const clearLoading = (image: HTMLImageElement) => image.setAttribute('data-image-loading', 'false');
    const setLoading = (image: HTMLImageElement) => image.setAttribute('data-image-loading', 'true');
    const cleanups = images.map((image) => {
      if (image.complete) {
        clearLoading(image);
        return () => {};
      }

      setLoading(image);
      const onDone = () => clearLoading(image);
      image.addEventListener('load', onDone);
      image.addEventListener('error', onDone);
      return () => {
        image.removeEventListener('load', onDone);
        image.removeEventListener('error', onDone);
      };
    });

    return () => {
      cleanups.forEach((cleanup) => {
        cleanup();
      });
    };
  }, [html, markdown]);

  useEffect(() => {
    const image = imagePreviewRef.current;
    setImagePreviewLoading(!(imagePreview && image && image.complete));
  }, [imagePreview]);

  useEffect(() => {
    if (!preview.visible) return;

    const dismiss = () => hidePreview();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [hidePreview, preview.visible]);

  const onRenderedMarkdownClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const pointerDragged = pointerDraggedRef.current;
    pointerDraggedRef.current = false;
    pointerDownRef.current = false;
    pointerDownPositionRef.current = null;

    const promptMessage = target?.closest('li.prompt-question, li.prompt-answer');
    const messageToggleSuppressed =
      promptMessage instanceof HTMLElement && consumeSuppressedPromptAnswerToggle(promptMessage);
    const promptMessageInteractiveTarget = target?.closest('a, img, button, input, label, summary.toggle-list-summary');
    if (promptMessage instanceof HTMLElement && !promptMessageInteractiveTarget) {
      if (messageToggleSuppressed || pointerDragged || hasNonCollapsedSelectionIntersectingNode(promptMessage)) return;
      event.preventDefault();
      togglePromptAnswerExpandedState(promptMessage, { keepTopInViewOnCollapse: true });
      rememberPromptListStates();
      return;
    }

    const toggleList = findToggleListFromTarget(target);
    if (toggleList) {
      event.preventDefault();
      toggleToggleListState(toggleList);
      return;
    }

    const modeOption = target?.closest('.prompt-list-mode-option');
    if (modeOption instanceof HTMLButtonElement) {
      event.preventDefault();
      const container = modeOption.closest('.prompt-list-conversation');
      if (container instanceof HTMLElement) {
        const mode = modeOption.dataset.promptListMode;
        if (mode === 'collapse-all' || mode === 'collapse-responses' || mode === 'expand-all') {
          setPromptListMode(container, mode);
          rememberPromptListStates();
        }
      }
      return;
    }

    const image = target?.closest('img');
    if (image && onImageClick) {
      event.preventDefault();
      onImageClick(image);
      return;
    }

    if (!onInternalLinkNavigate) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = target?.closest('a');
    if (!anchor) return;
    if (pointerDragged || hasNonCollapsedSelectionIntersectingNode(anchor)) return;
    hidePreview();
    if (anchor.hasAttribute('download')) return;

    const href = (anchor.getAttribute('href') || '').trim();
    if (!href || href.startsWith('?')) return;
    if (href.startsWith('#')) {
      if (containScroll) {
        event.preventDefault();
        scrollToHash(href, 'smooth');
      }
      return;
    }
    if (isExternalHttpHref(href)) return;

    const route = resolveInternalNavigationRoute(anchor);
    if (!route) return;

    const resolved = new URL(href, window.location.href);
    if (resolved.origin !== window.location.origin) return;

    if (resolved.pathname === window.location.pathname && resolved.search === window.location.search && resolved.hash) {
      if (resolved.hash === window.location.hash) {
        event.preventDefault();
        scrollToHash(resolved.hash, 'smooth');
      }
      return;
    }

    event.preventDefault();
    onInternalLinkNavigate(route);
  };

  const onRenderedMarkdownKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const promptMessage = target?.closest('li.prompt-question, li.prompt-answer');
    if (
      promptMessage instanceof HTMLElement &&
      promptMessage === target &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      togglePromptAnswerExpandedState(promptMessage, { keepTopInViewOnCollapse: true });
      rememberPromptListStates();
      return;
    }

    const toggleList = findToggleListFromTarget(target);
    if (toggleList && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      toggleToggleListState(toggleList);
      return;
    }
  };

  const getPreviewPositionForAnchor = useCallback(
    (anchor: HTMLAnchorElement) => {
      const rect = anchor.getBoundingClientRect();
      if (!containScroll) {
        return {
          top: Math.round(rect.bottom + 8),
          left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
        };
      }

      const container = contentViewRef.current;
      if (!container) {
        return {
          top: Math.round(rect.bottom + 8),
          left: Math.round(Math.min(window.innerWidth - 380, Math.max(16, rect.left))),
        };
      }

      const containerRect = container.getBoundingClientRect();
      const maxLeft = Math.max(16, container.clientWidth - 380);
      return {
        top: Math.round(rect.bottom - containerRect.top + container.scrollTop + 8),
        left: Math.round(Math.min(maxLeft, Math.max(16, rect.left - containerRect.left + container.scrollLeft))),
      };
    },
    [containScroll],
  );

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

      const position = getPreviewPositionForAnchor(anchor);
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: true,
        top: position.top,
        left: position.left,
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
    [getPreviewPositionForAnchor, hidePreview, onRequestMarkdownLinkPreview],
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

      const position = getPreviewPositionForAnchor(anchor);
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      hoverAnchorRef.current = anchor;
      setPreview({
        visible: true,
        loading: false,
        top: position.top,
        left: position.left,
        title: `Citation ${anchor.textContent?.trim() || ''}`.trim(),
        html: htmlContent,
        url: null,
      });
    },
    [getPreviewPositionForAnchor, hidePreview],
  );

  const onRenderedMarkdownMouseMove = useCallback(
    (event: MouseEvent) => {
      if (pointerDownRef.current && pointerDownPositionRef.current) {
        const dx = Math.abs(event.clientX - pointerDownPositionRef.current.x);
        const dy = Math.abs(event.clientY - pointerDownPositionRef.current.y);
        if (dx > 4 || dy > 4) pointerDraggedRef.current = true;
      }
      if (!markdown) return;
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
      markdown,
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

  const sessionComposeForm = (
    <form
      class="content-session-compose"
      onSubmit={(event) => {
        event.preventDefault();
        if (askPiDisabled) return;
        void submitNewSessionMessage('pi');
      }}
    >
      <textarea
        ref={newSessionTextareaRef}
        class="content-session-compose-input"
        value={newSessionMessage}
        placeholder="Start a new thread..."
        rows={3}
        disabled={newSessionSubmitting}
        onInput={(event) => {
          setNewSessionMessage(event.currentTarget.value);
          resizeNewSessionTextarea();
        }}
      />
      <div class="content-session-compose-actions">
        <div class="content-session-compose-submit-actions">
          <button
            type="button"
            disabled={postNoteDisabled}
            onClick={() => {
              void submitNewNote();
            }}
          >
            Create note
          </button>
          {showNewSessionMenu ? (
            <Popover.Root open={newSessionMenuOpen} onOpenChange={setNewSessionMenuOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  class="content-session-new-menu-trigger"
                  aria-label="New session"
                  disabled={
                    (claudeCredentialAvailable === null || !onLaunchClaude) &&
                    (piCredentialAvailable === null || !onLaunchPi)
                  }
                >
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
              </Popover.Trigger>
              <Popover.Portal container={contentViewRef.current ?? undefined}>
                <Popover.Content
                  class="content-session-new-menu-content"
                  sideOffset={6}
                  align="start"
                  onOpenAutoFocus={(event: Event) => {
                    event.preventDefault();
                  }}
                  onCloseAutoFocus={(event: Event) => {
                    event.preventDefault();
                  }}
                >
                  <button
                    type="button"
                    class="content-session-new-menu-item"
                    disabled={claudeCredentialAvailable === null || !onLaunchClaude}
                    onClick={() => {
                      setNewSessionMenuOpen(false);
                      onLaunchClaude?.();
                    }}
                  >
                    {formatAgentLaunchLabel('Claude', claudeCredentialAvailable)}
                  </button>
                  <button
                    type="button"
                    class="content-session-new-menu-item"
                    disabled={piCredentialAvailable === null || !onLaunchPi}
                    onClick={() => {
                      setNewSessionMenuOpen(false);
                      onLaunchPi?.();
                    }}
                  >
                    {formatAgentLaunchLabel('Pi', piCredentialAvailable)}
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
          <button
            type="button"
            class="button-success-solid"
            disabled={askClaudeDisabled}
            onClick={() => {
              void submitNewSessionMessage('claude');
            }}
          >
            {claudeLoginRequired ? 'Log in to Claude' : 'Ask Claude'}
          </button>
          <button type="submit" class="button-success-solid" disabled={askPiDisabled}>
            {piLoginRequired ? 'Log in to Pi' : 'Ask Pi'}
          </button>
        </div>
      </div>
    </form>
  );

  const handleSessionCardClick = (event: MouseEvent, path: string, href: string | null) => {
    if (!href) {
      event.preventDefault();
      return;
    }
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onOpenSession?.(path);
  };

  const renderSessionCard = (session: ContentSessionFile, options?: { parentPath?: string }) => {
    const metadata = sessionMetadataByPath.get(session.path) ?? parseSessionCardMetadata(session.path, session.content);
    const isNewSessionCard = metadata.agentName !== 'Note' && !metadata.firstUserMessage;
    const sessionHref = onSessionHref?.(session.path) ?? null;
    const agentLabel = formatSessionCardAgentLabel(metadata.agentName);
    const parentPath = options?.parentPath ?? null;
    const canRemoveFromParent = Boolean(parentPath && onRemoveSessionChild);
    const canShowMenu = Boolean(onDeleteSession || canRemoveFromParent);
    const canDragSession = Boolean(onAddSessionChild);

    return (
      <a
        class={`content-session-card${isNewSessionCard ? ' content-session-card--new' : ''}${
          parentPath ? ' content-session-card--child' : ''
        }`}
        href={sessionHref ?? '#'}
        draggable={canDragSession}
        onClick={(event) => handleSessionCardClick(event, session.path, sessionHref)}
        onDragStart={(event) => {
          if (!canDragSession || !event.dataTransfer) return;
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('application/x-input-session-path', session.path);
          event.dataTransfer.setData('text/plain', session.path);
        }}
        onDragOver={(event) => {
          if (!onAddSessionChild) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          if (!onAddSessionChild || !event.dataTransfer) return;
          const childPath =
            event.dataTransfer.getData('application/x-input-session-path') || event.dataTransfer.getData('text/plain');
          if (!childPath || childPath === session.path) return;
          event.preventDefault();
          event.stopPropagation();
          void onAddSessionChild(session.path, childPath);
        }}
      >
        <span class="content-session-card-main">
          {metadata.firstUserMessage ? (
            <span class="content-session-card-message">{metadata.firstUserMessage}</span>
          ) : null}
          {canShowMenu ? (
            <DropdownMenu.Root onOpenChange={blurOnClose}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  class="content-session-card-menu-trigger"
                  aria-label={`Options for ${metadata.agentName} session`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="content-session-card-menu-content" sideOffset={6} align="end">
                  {parentPath && onRemoveSessionChild ? (
                    <DropdownMenu.Item
                      class="content-session-card-menu-item"
                      onSelect={() => {
                        void onRemoveSessionChild(parentPath, session.path);
                      }}
                    >
                      Remove from parent
                    </DropdownMenu.Item>
                  ) : null}
                  {onDeleteSession ? (
                    <DropdownMenu.Item
                      class="content-session-card-menu-item content-session-card-menu-item--danger"
                      onSelect={() => {
                        void onDeleteSession(session.path);
                      }}
                    >
                      Delete
                    </DropdownMenu.Item>
                  ) : null}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
        </span>
        <span class="content-session-card-meta" title={formatSessionCardDateTitle(metadata.lastMessageDate)}>
          {formatSessionCardDate(metadata.lastMessageDate)}
          {agentLabel ? (
            <>
              <span aria-hidden="true"> &middot; </span>
              <span class="content-session-card-agent">{agentLabel}</span>
            </>
          ) : null}
        </span>
      </a>
    );
  };

  const renderSessionReferenceLinks = (path: string) => {
    const renderLinks = (paths: string[]) => (
      <div class="content-session-reference-list">
        {paths.map((referencePath) => {
          const referenceFile = sessionReferenceFileByPath.get(referencePath);
          if (!referenceFile) return null;
          const metadata =
            sessionMetadataByPath.get(referencePath) ?? parseSessionCardMetadata(referencePath, referenceFile.content);
          const href = onSessionHref?.(referencePath) ?? null;
          const agentLabel = formatSessionCardAgentLabel(metadata.agentName);
          return (
            <a
              key={referencePath}
              class="content-session-reference-link"
              href={href ?? '#'}
              onClick={(event) => handleSessionCardClick(event, referencePath, href)}
            >
              <span class="content-session-reference-title">
                {formatSessionReferenceLabel(referencePath, metadata)}
              </span>
              <span class="content-session-reference-meta">
                {formatSessionCardDate(metadata.lastMessageDate)}
                {agentLabel ? ` · ${agentLabel}` : ''}
              </span>
            </a>
          );
        })}
      </div>
    );
    const parentPaths = getSessionReferenceParents(sessionReferenceIndex, path).filter((parentPath) =>
      sessionReferenceFileByPath.has(parentPath),
    );
    const childPaths = getSessionReferenceChildren(sessionReferenceIndex, path).filter((childPath) =>
      sessionReferenceFileByPath.has(childPath),
    );
    if (parentPaths.length === 0 && childPaths.length === 0) return null;
    return (
      <section class="content-session-references" aria-label="Session references">
        {parentPaths.length > 0 ? (
          <div class="content-session-reference-group">
            <h2>Parents</h2>
            {renderLinks(parentPaths)}
          </div>
        ) : null}
        {childPaths.length > 0 ? (
          <div class="content-session-reference-group">
            <h2>Children</h2>
            {renderLinks(childPaths)}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <div
      ref={contentViewRef}
      class={`content ${
        showSessionList || showSessionFile
          ? 'content--sessions'
          : imagePreview
            ? 'content--image'
            : markdown
              ? 'content--markdown'
              : 'content--plain'
      }${showSessionList ? ' content--session-listing' : ''}`}
      data-markdown-custom-css-content={markdown && markdownCustomCssScope ? markdownCustomCssScope : undefined}
      data-markdown-custom-css-main={markdown && markdownCustomCssScope ? markdownCustomCssScope : undefined}
    >
      {alertMessage ? (
        <ContentAlert>
          <span class="content-alert-caption">{alertMessage}</span>
          {alertDownloadHref ? (
            <a href={alertDownloadHref} download={alertDownloadName ?? undefined} class="content-alert-link">
              Download
            </a>
          ) : null}
        </ContentAlert>
      ) : null}
      {loading || showSessionLoading ? (
        <div class="content-loading-shell" role="status" aria-label="Loading content">
          <span class="content-spinner" aria-hidden="true" />
        </div>
      ) : sessionFile ? (
        <div class="content-session-view">
          {sessionFile.deleted ? (
            <div class="pi-session">
              {onBackFromSession ? (
                <div class="pi-session-toolbar">
                  <div class="pi-session-mode-tabs">
                    <button type="button" class="pi-session-mode-tab" onClick={onBackFromSession}>
                      <ArrowLeft size={14} aria-hidden="true" />
                      Back
                    </button>
                  </div>
                </div>
              ) : null}
              <div class="pi-session-alert">File deleted.</div>
            </div>
          ) : noteMarkdown !== null ? (
            <div class="content-note">
              {onBackFromSession ? (
                <div class="pi-session-toolbar">
                  <div class="pi-session-mode-tabs">
                    <button type="button" class="pi-session-mode-tab" onClick={onBackFromSession}>
                      <ArrowLeft size={14} aria-hidden="true" />
                      Back
                    </button>
                  </div>
                </div>
              ) : null}
              <div class="rendered-markdown content-note-body" dangerouslySetInnerHTML={{ __html: noteHtml }} />
              {renderSessionReferenceLinks(sessionFile.path)}
            </div>
          ) : isPiSessionPath(sessionFile.path) ? (
            <>
              <PiSessionTreeView
                content={sessionFile.content}
                fileName={sessionFile.path}
                onBack={onBackFromSession}
                onContinue={onContinuePiSession}
                piCredentialAvailable={piCredentialAvailable}
              />
              {renderSessionReferenceLinks(sessionFile.path)}
            </>
          ) : isClaudeSessionPath(sessionFile.path) ? (
            <>
              <ClaudeSessionTreeView
                content={sessionFile.content}
                fileName={sessionFile.path}
                onBack={onBackFromSession}
                onContinue={onContinueClaudeSession}
                claudeCredentialAvailable={claudeCredentialAvailable}
              />
              {renderSessionReferenceLinks(sessionFile.path)}
            </>
          ) : (
            <>
              <div class="content-session-view-header">
                <button type="button" class="content-session-back-btn" onClick={onBackFromSession}>
                  <ArrowLeft size={15} aria-hidden="true" />
                  Back
                </button>
                <div class="content-session-view-path">{sessionFile.path}</div>
              </div>
              <TextCodeView
                content={sessionFile.content}
                fileName={sessionFile.path}
                scrollStorageKey={`session:${sessionFile.path}`}
              />
              {renderSessionReferenceLinks(sessionFile.path)}
            </>
          )}
        </div>
      ) : showSessionList ? (
        <div class="content-session-list" role="list" aria-label="Sessions">
          {sessionComposeForm}
          {topLevelSessionFiles.map((session) => {
            const childSessions = childSessionFilesByParentPath.get(session.path) ?? [];
            return (
              <div
                key={session.path}
                class={`content-session-card-group${childSessions.length > 0 ? ' content-session-card-group--with-children' : ''}`}
                role="listitem"
              >
                {renderSessionCard(session)}
                {childSessions.length > 0 ? (
                  <div class="content-session-child-list" role="list" aria-label="Child sessions">
                    {childSessions.map((childSession) => (
                      <div
                        key={`${session.path}:${childSession.path}`}
                        class="content-session-child-list-item"
                        role="listitem"
                      >
                        {renderSessionCard(childSession, { parentPath: session.path })}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : isEmpty ? (
        <p class="content-empty-placeholder">{fileSelected ? 'This file is empty' : 'No file selected'}</p>
      ) : imagePreview ? (
        <div class="content-image-preview">
          <img
            ref={imagePreviewRef}
            class="content-image-preview-image"
            src={imagePreview.src}
            alt={imagePreview.alt}
            data-image-loading={imagePreviewLoading ? 'true' : 'false'}
            onLoad={() => setImagePreviewLoading(false)}
            onError={() => setImagePreviewLoading(false)}
            onClick={(event) => onImageClick?.(event.currentTarget)}
          />
        </div>
      ) : markdown ? (
        <>
          {markdownInlineCss ? (
            <style key={markdownCustomCssScope ?? markdownInlineCss}>{markdownInlineCss}</style>
          ) : null}
          {markdownFontsPending ? (
            <div class="rendered-markdown-font-loading" role="status" aria-live="polite" aria-label="Loading fonts">
              <span class="content-spinner" aria-hidden="true" />
            </div>
          ) : null}
          <div class="content-overlay-controls">
            <Popover.Root open={previewHighlightsPopoverOpen} onOpenChange={handlePreviewHighlightsPopoverOpenChange}>
              <Popover.Anchor asChild>
                <button
                  type="button"
                  class="editor-preview-highlights-toggle"
                  aria-label="Show document highlights"
                  aria-haspopup="dialog"
                  aria-expanded={previewHighlightsPopoverOpen}
                  onMouseEnter={openPreviewHighlightsPopover}
                  onMouseLeave={closePreviewHighlightsPopoverSoon}
                  onClick={togglePreviewHighlightsPopoverPinned}
                >
                  {previewHighlightsPopoverPinned ? (
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
                    if (!previewHighlightsPopoverPinned) return;
                    event.preventDefault();
                  }}
                  onMouseEnter={openPreviewHighlightsPopover}
                  onMouseLeave={closePreviewHighlightsPopoverSoon}
                >
                  <PreviewHighlightsPopoverContent
                    entries={previewHighlightEntries}
                    onSelect={handlePreviewHighlightSelect}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <div
            ref={renderedMarkdownRef}
            class={`rendered-markdown${markdownFontsPending ? ' rendered-markdown--pending-fonts' : ''}`}
            data-markdown-custom-css={markdownCustomCssScope ?? undefined}
            data-toggle-list-storage-key={scrollStorageKey ?? undefined}
            aria-busy={markdownFontsPending ? 'true' : 'false'}
            onClick={onRenderedMarkdownClick}
            onKeyDown={onRenderedMarkdownKeyDown}
            onMouseDown={onRenderedMarkdownMouseDown}
            onMouseUp={onRenderedMarkdownMouseUp}
            onMouseMove={onRenderedMarkdownMouseMove}
            onMouseLeave={hidePreview}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <PromptAnswerCommentComposer
            enabled={markdown}
            resetKey={html}
            rootRef={renderedMarkdownRef}
            currentUserAvatarUrl={currentUserAvatarUrl}
          />
        </>
      ) : plainText !== null ? (
        <TextCodeView
          content={plainText}
          fileName={plainTextFileName}
          scrollStorageKey={scrollStorageKey}
          goToLineRequest={goToLineRequest}
        />
      ) : (
        <pre class="rendered-content" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {preview.visible ? (
        <div
          class={`markdown-link-preview-popover${preview.url ? ' markdown-link-preview-popover--url' : ''}${containScroll ? ' markdown-link-preview-popover--contained' : ''}`}
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
