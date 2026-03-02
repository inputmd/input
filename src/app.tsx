import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseAnsiToHtml } from './ansi';
import { isRateLimitError, rateLimitToastMessage, responseToApiError } from './api_error';
import { useDialogs } from './components/DialogProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ImageLightbox } from './components/ImageLightbox';
import { Sidebar } from './components/Sidebar';
import { useToast } from './components/ToastProvider';
import { type ActiveView, Toolbar } from './components/Toolbar';
import { createGistDocumentStore, createRepoDocumentStore, findRepoDocFile, type RepoDocFile } from './document_store';
import { markGistRecentlyCreated } from './gist_consistency';
import {
  createGist,
  type GistDetail,
  type GistFile,
  type GistSummary,
  type GitHubUser,
  getAuthSession,
  getGist,
  listGists,
  logout,
  updateGist,
} from './github';
import {
  clearInstallationId,
  clearPendingInstallationId,
  clearSelectedRepo,
  consumeInstallState,
  createInstallState,
  createSession,
  disconnectInstallation,
  getInstallationId,
  getInstallUrl,
  getPendingInstallationId,
  getPublicRepoContents,
  getPublicRepoTree,
  getRepoContents,
  getRepoTree,
  getSelectedRepo,
  hasInstallState,
  type InstallationRepo,
  isRepoFile,
  listInstallationRepos,
  publicRepoRawFileUrl,
  putRepoFile,
  rememberInstallState,
  repoRawFileUrl,
  SessionExpiredError,
  setInstallationId,
  setPendingInstallationId,
  setSelectedRepo as storeSelectedRepo,
} from './github_app';
import { useRoute } from './hooks/useRoute';
import { parseMarkdownToHtml } from './markdown';
import { type Route, routePath } from './routing';
import { isSubdomainMode } from './subdomain';
import { decodeBase64ToUtf8, encodeBytesToBase64, encodeUtf8ToBase64 } from './util';
import { ContentView } from './views/ContentView';
import { EditView } from './views/EditView';
import { ErrorView } from './views/ErrorView';
import { LoadingView } from './views/LoadingView';
import { WorkspacesView } from './views/WorkspacesView';

const EDITOR_PREVIEW_VISIBLE_KEY = 'editor_preview_visible';
const SIDEBAR_WIDTH_KEY = 'sidebar_width_px';
const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';
const DRAFT_TITLE_KEY = 'draft_title';
const DRAFT_CONTENT_KEY = 'draft_content';
const DEFAULT_NEW_FILENAME = 'index.md';
const REPO_NEW_DRAFT_KEY_PREFIX = 'repo_new_draft';
const DEFAULT_SIDEBAR_WIDTH_PX = 220;
const MIN_SIDEBAR_WIDTH_PX = 180;
const MAX_SIDEBAR_WIDTH_PX = 420;
const PASTED_IMAGE_RESIZE_THRESHOLD_BYTES = Math.floor(1.5 * 1024 * 1024);
const PASTED_IMAGE_MAX_SIDE_PX = 1600;
const PASTED_IMAGE_QUALITY = 0.82;
const OAUTH_REDIRECT_GUARD_KEY = 'oauth_redirect_guard';
const OAUTH_REDIRECT_GUARD_WINDOW_MS = 15_000;
const LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION = `
### Input

An experimental Markdown editor, where all content is stored on GitHub.

Input supports live preview, multi-document workspaces, and \\[\\[wiki links\\]\\]. Your data is stored in your own repos or gists as files.

Input is privacy preserving. We do not log your data.`;

function repoNewDraftKey(installationId: string, repoFullName: string, field: 'title' | 'content'): string {
  return `${REPO_NEW_DRAFT_KEY_PREFIX}:${installationId}:${repoFullName}:${field}`;
}

function isMarkdownFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\.md(?:own|wn)?$/i.test(name) || /\.markdown$/i.test(name);
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function sanitizeTitleToFileName(title: string): string {
  const trimmed = title
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '.');
  if (!trimmed) return DEFAULT_NEW_FILENAME;
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function fileNameFromPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

function dirName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
}

function splitPathSuffix(path: string): { pathWithoutSuffix: string; suffix: string } {
  const queryIdx = path.indexOf('?');
  const hashIdx = path.indexOf('#');
  const splitIdx =
    queryIdx >= 0 && hashIdx >= 0
      ? Math.min(queryIdx, hashIdx)
      : queryIdx >= 0
        ? queryIdx
        : hashIdx >= 0
          ? hashIdx
          : -1;
  if (splitIdx < 0) return { pathWithoutSuffix: path, suffix: '' };
  return { pathWithoutSuffix: path.slice(0, splitIdx), suffix: path.slice(splitIdx) };
}

function normalizeRepoPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH_PX, Math.min(MAX_SIDEBAR_WIDTH_PX, width));
}

function resolveRepoAssetPath(currentDocPath: string, src: string): string | null {
  const { pathWithoutSuffix, suffix } = splitPathSuffix(src.trim());
  if (!pathWithoutSuffix) return null;
  const pathWithBase = pathWithoutSuffix.startsWith('/')
    ? pathWithoutSuffix.slice(1)
    : `${dirName(currentDocPath)}/${pathWithoutSuffix}`;
  const normalized = normalizeRepoPath(pathWithBase);
  if (!normalized) return null;
  return `${normalized}${suffix}`;
}

function resolveRelativeDocPath(currentDocPath: string, targetPath: string): string | null {
  const { pathWithoutSuffix } = splitPathSuffix(safeDecodeURIComponent(targetPath).trim());
  if (!pathWithoutSuffix) return null;
  const pathWithBase = pathWithoutSuffix.startsWith('/')
    ? pathWithoutSuffix.slice(1)
    : `${dirName(currentDocPath)}/${pathWithoutSuffix}`;
  return normalizeRepoPath(pathWithBase);
}

function encodePathForHref(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

interface WikiLinkResolver {
  exists: boolean;
  resolvedHref?: string;
}

function createWikiLinkResolver(
  currentDocPath: string,
  knownPaths: string[],
): (targetPath: string) => WikiLinkResolver {
  const exactPaths = new Set<string>();
  const canonicalByLowerPath = new Map<string, string>();

  for (const knownPath of knownPaths) {
    const normalized = normalizeRepoPath(safeDecodeURIComponent(knownPath).trim());
    if (!normalized) continue;
    exactPaths.add(normalized);
    const lower = normalized.toLowerCase();
    if (!canonicalByLowerPath.has(lower)) canonicalByLowerPath.set(lower, normalized);
  }

  return (targetPath: string) => {
    const resolvedTarget = resolveRelativeDocPath(currentDocPath, targetPath);
    if (!resolvedTarget) return { exists: false };
    if (exactPaths.has(resolvedTarget)) return { exists: true, resolvedHref: encodePathForHref(resolvedTarget) };

    const canonical = canonicalByLowerPath.get(resolvedTarget.toLowerCase());
    if (!canonical) return { exists: false };
    return { exists: true, resolvedHref: encodePathForHref(canonical) };
  };
}

interface PublicRepoRef {
  owner: string;
  repo: string;
}

interface MarkdownRepoSourceContext {
  mode: 'installed' | 'public';
  installationId?: string | null;
  selectedRepo?: string | null;
  publicRepoRef?: PublicRepoRef | null;
}

interface HistorySelectedRepo {
  full_name: string;
  id: number;
  private: boolean;
}

function historySelectedRepo(state: unknown): HistorySelectedRepo | null {
  if (!state || typeof state !== 'object') return null;
  const selectedRepo = (state as { selectedRepo?: unknown }).selectedRepo;
  if (!selectedRepo || typeof selectedRepo !== 'object') return null;
  const candidate = selectedRepo as Partial<HistorySelectedRepo>;
  if (
    typeof candidate.full_name !== 'string' ||
    typeof candidate.id !== 'number' ||
    typeof candidate.private !== 'boolean'
  ) {
    return null;
  }
  return { full_name: candidate.full_name, id: candidate.id, private: candidate.private };
}

function extensionFromMimeType(mimeType: string): string {
  const mimeExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return mimeExt[mimeType] ?? 'png';
}

function isResizableImageType(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg' || mimeType === 'image/webp';
}

async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

async function maybeResizePastedImage(file: File): Promise<{ bytes: Uint8Array; extension: string; resized: boolean }> {
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const originalExtension = extensionFromMimeType(file.type);

  if (file.size <= PASTED_IMAGE_RESIZE_THRESHOLD_BYTES || !isResizableImageType(file.type)) {
    return { bytes: originalBytes, extension: originalExtension, resized: false };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const scale = longest > PASTED_IMAGE_MAX_SIDE_PX ? PASTED_IMAGE_MAX_SIDE_PX / longest : 1;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return { bytes: originalBytes, extension: originalExtension, resized: false };
    }
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const outputMimeType = file.type === 'image/jpeg' || file.type === 'image/jpg' ? 'image/jpeg' : 'image/webp';
    const resizedBlob = await canvasToBlob(canvas, outputMimeType, PASTED_IMAGE_QUALITY);
    if (!resizedBlob) return { bytes: originalBytes, extension: originalExtension, resized: false };

    const resizedBytes = new Uint8Array(await resizedBlob.arrayBuffer());
    if (resizedBytes.length >= originalBytes.length) {
      return { bytes: originalBytes, extension: originalExtension, resized: false };
    }

    return { bytes: resizedBytes, extension: extensionFromMimeType(outputMimeType), resized: true };
  } catch {
    return { bytes: originalBytes, extension: originalExtension, resized: false };
  }
}

function viewFromRoute(route: Route): ActiveView {
  switch (route.name) {
    case 'workspaces':
      return 'workspaces';
    case 'repofile':
    case 'publicrepofile':
    case 'gist':
      return 'content';
    default:
      return 'edit';
  }
}

export function App() {
  const { route, routeState, navigate } = useRoute();
  const { showAlert, showConfirm } = useDialogs();
  const { showSuccessToast, showFailureToast, showLoadingToast, dismissToast } = useToast();

  // --- Shared state ---
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [installationId, setInstId] = useState<string | null>(getInstallationId());
  const [selectedRepo, setSelectedRepo] = useState<string | null>(getSelectedRepo()?.full_name ?? null);
  const [selectedRepoPrivate, setSelectedRepoPrivate] = useState<boolean | null>(getSelectedRepo()?.private ?? null);
  const [publicRepoRef, setPublicRepoRef] = useState<PublicRepoRef | null>(null);
  const [repoAccessMode, setRepoAccessMode] = useState<'installed' | 'public' | null>(null);
  const [installationRepos, setInstallationRepos] = useState<InstallationRepo[]>([]);
  const [installationReposLoading, setInstallationReposLoading] = useState(false);
  const [loadedReposInstallationId, setLoadedReposInstallationId] = useState<string | null>(null);
  const [menuGists, setMenuGists] = useState<GistSummary[]>([]);
  const [menuGistsLoading, setMenuGistsLoading] = useState(false);
  const [menuGistsLoaded, setMenuGistsLoaded] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);

  // --- View state ---
  const [viewPhase, setViewPhase] = useState<'loading' | 'error' | null>('loading');
  const [renderedHtml, setRenderedHtml] = useState('');
  const [renderMode, setRenderMode] = useState<'ansi' | 'markdown'>('ansi');
  const [errorMessage, setErrorMessage] = useState('');
  const [currentGistId, setCurrentGistId] = useState<string | null>(null);
  const [currentRepoDocPath, setCurrentRepoDocPath] = useState<string | null>(null);
  const [currentRepoDocSha, setCurrentRepoDocSha] = useState<string | null>(null);
  const [editingBackend, setEditingBackend] = useState<'gist' | 'repo' | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [draftMode, setDraftMode] = useState(false);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [gistFiles, setGistFiles] = useState<Record<string, GistFile> | null>(null);
  const [repoFiles, setRepoFiles] = useState<RepoDocFile[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [sidebarVisibilityOverride, setSidebarVisibilityOverride] = useState<boolean | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH_PX;
    try {
      const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      if (Number.isFinite(raw)) return clampSidebarWidth(raw);
    } catch {}
    return DEFAULT_SIDEBAR_WIDTH_PX;
  });
  const [previewVisible, setPreviewVisible] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && !window.matchMedia(DESKTOP_MEDIA_QUERY).matches) {
      return false;
    }
    try {
      return localStorage.getItem(EDITOR_PREVIEW_VISIBLE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [isDesktopWidth, setIsDesktopWidth] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
  });
  const defaultPreviewVisible = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
  }, []);

  // Track initialization
  const initialized = useRef(false);
  const activeView = viewPhase ?? viewFromRoute(route);

  // --- Helpers ---
  const syncRepoState = useCallback(() => {
    const storedRepo = getSelectedRepo();
    setInstId(getInstallationId());
    setSelectedRepo(storedRepo?.full_name ?? null);
    setSelectedRepoPrivate(storedRepo?.private ?? null);
  }, []);

  const syncRepoStateFromHistory = useCallback(() => {
    const selectedRepoState = historySelectedRepo(routeState);
    if (!selectedRepoState) return;
    storeSelectedRepo(selectedRepoState);
    setSelectedRepo(selectedRepoState.full_name);
    setSelectedRepoPrivate(selectedRepoState.private);
  }, [routeState]);

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg);
    setViewPhase('error');
  }, []);
  const showRateLimitToastIfNeeded = useCallback(
    (err: unknown) => {
      if (isRateLimitError(err)) {
        showFailureToast(rateLimitToastMessage(err));
      }
    },
    [showFailureToast],
  );

  const clearOAuthRedirectGuard = useCallback(() => {
    try {
      sessionStorage.removeItem(OAUTH_REDIRECT_GUARD_KEY);
    } catch {}
  }, []);

  const startGitHubSignIn = useCallback(
    (returnTo: string) => {
      const normalizedReturnTo = returnTo.startsWith('/') ? returnTo : `/${returnTo}`;
      const currentPath = `${window.location.pathname}${window.location.search}`;
      try {
        const raw = sessionStorage.getItem(OAUTH_REDIRECT_GUARD_KEY);
        if (raw) {
          const guard = JSON.parse(raw) as { at?: unknown; fromPath?: unknown; returnTo?: unknown };
          if (
            typeof guard.at === 'number' &&
            typeof guard.fromPath === 'string' &&
            typeof guard.returnTo === 'string' &&
            guard.fromPath === currentPath &&
            guard.returnTo === normalizedReturnTo &&
            Date.now() - guard.at < OAUTH_REDIRECT_GUARD_WINDOW_MS
          ) {
            showError('Sign-in redirect loop detected. Please refresh and try again.');
            return false;
          }
        }
        sessionStorage.setItem(
          OAUTH_REDIRECT_GUARD_KEY,
          JSON.stringify({
            at: Date.now(),
            fromPath: currentPath,
            returnTo: normalizedReturnTo,
          }),
        );
      } catch {
        // Best effort only; continue with OAuth redirect.
      }
      window.location.assign(`/api/auth/github/start?return_to=${encodeURIComponent(normalizedReturnTo)}`);
      return true;
    },
    [showError],
  );

  const handleSessionExpired = useCallback(() => {
    clearInstallationId();
    clearSelectedRepo();
    setUser(null);
    setInstId(null);
    setSelectedRepo(null);
    setSelectedRepoPrivate(null);
    setRepoAccessMode(null);
    setPublicRepoRef(null);
    setErrorMessage('Your session expired. Sign in with GitHub from the header to continue.');
    setViewPhase('error');
  }, []);

  const focusEditorSoon = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('.doc-editor')?.focus();
      });
    });
  }, []);

  const resolveMarkdownImageSrc = useCallback(
    (src: string, repoDocPath: string | null, repoSource?: MarkdownRepoSourceContext): string | null => {
      const normalizedSrc = src.trim();
      if (!normalizedSrc) return null;
      if (!repoDocPath) return normalizedSrc;
      if (normalizedSrc.startsWith('#') || normalizedSrc.startsWith('?')) return normalizedSrc;

      const protocolMatch = normalizedSrc.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
      if (protocolMatch) return normalizedSrc;

      const resolvedPath = resolveRepoAssetPath(repoDocPath, normalizedSrc);
      if (!resolvedPath) return normalizedSrc;
      const effectiveMode = repoSource?.mode ?? repoAccessMode;
      if (effectiveMode === 'installed') {
        const effectiveSelectedRepo = repoSource?.selectedRepo ?? selectedRepo;
        const effectiveInstallationId = repoSource?.installationId ?? installationId;
        if (effectiveSelectedRepo && effectiveInstallationId) {
          return repoRawFileUrl(effectiveInstallationId, effectiveSelectedRepo, resolvedPath);
        }
      }
      if (effectiveMode === 'public') {
        const effectivePublicRepoRef = repoSource?.publicRepoRef ?? publicRepoRef;
        if (effectivePublicRepoRef) {
          return publicRepoRawFileUrl(effectivePublicRepoRef.owner, effectivePublicRepoRef.repo, resolvedPath);
        }
      }
      return normalizedSrc;
    },
    [installationId, publicRepoRef, repoAccessMode, selectedRepo],
  );

  const renderDocumentContent = useCallback(
    (
      content: string,
      fileName: string | null | undefined,
      repoDocPath: string | null = null,
      repoSource?: MarkdownRepoSourceContext,
      wikiLinkContext?: { currentDocPath: string; knownMarkdownPaths: string[] },
    ) => {
      if (isMarkdownFileName(fileName)) {
        const wikiLinkResolver =
          wikiLinkContext && wikiLinkContext.knownMarkdownPaths.length > 0
            ? createWikiLinkResolver(wikiLinkContext.currentDocPath, wikiLinkContext.knownMarkdownPaths)
            : undefined;

        setRenderedHtml(
          parseMarkdownToHtml(content, {
            resolveImageSrc: (src) => resolveMarkdownImageSrc(src, repoDocPath, repoSource),
            resolveWikiLinkMeta: wikiLinkResolver,
          }),
        );
        setRenderMode('markdown');
        return;
      }
      setRenderedHtml(parseAnsiToHtml(content));
      setRenderMode('ansi');
    },
    [resolveMarkdownImageSrc],
  );

  const handleEditorPaste = useCallback(
    async (event: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => {
      const editor = event.currentTarget;
      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const imageItem = clipboardItems.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
      if (!imageItem) return;

      event.preventDefault();

      if (editingBackend !== 'repo' || !currentRepoDocPath || !selectedRepo || !installationId) {
        showFailureToast('Save your document before uploading images');
        return;
      }

      const file = imageItem.getAsFile();
      if (!file) {
        showFailureToast('Failed to read pasted image.');
        return;
      }

      const uploadToastId = showLoadingToast('Uploading image...');
      try {
        const processed = await maybeResizePastedImage(file);
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const imageName = `pasted-${stamp}-${Math.random().toString(36).slice(2, 8)}.${processed.extension}`;
        const docDir = dirName(currentRepoDocPath);
        const assetDir = docDir ? `${docDir}/.assets` : '.assets';
        const imageRepoPath = `${assetDir}/${imageName}`;

        const contentB64 = encodeBytesToBase64(processed.bytes);
        await putRepoFile(installationId, selectedRepo, imageRepoPath, `Add image ${imageName}`, contentB64);

        const currentValue = editor.value;
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const insertion = `![${imageName}](./.assets/${imageName})`;
        const next = `${currentValue.slice(0, start)}${insertion}${currentValue.slice(end)}`;
        setEditContent(next);
        setHasUnsavedChanges(true);
        dismissToast(uploadToastId);
        showSuccessToast(processed.resized ? 'Image resized and uploaded' : 'Image uploaded');
      } catch (err) {
        dismissToast(uploadToastId);
        if (isRateLimitError(err)) {
          showFailureToast(rateLimitToastMessage(err));
          return;
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        showFailureToast(`Image upload failed: ${message}`);
      }
    },
    [
      currentRepoDocPath,
      dismissToast,
      editingBackend,
      installationId,
      selectedRepo,
      showFailureToast,
      showLoadingToast,
      showSuccessToast,
    ],
  );

  // --- Auth ---
  // Returns whether auth is present and whether it navigated away from the current route.
  const tryRestoreAuth = useCallback(async (): Promise<{ authenticated: boolean; navigated: boolean }> => {
    try {
      const session = await getAuthSession();
      if (!session.authenticated || !session.user) {
        setUser(null);
        clearInstallationId();
        clearSelectedRepo();
        setInstId(null);
        setSelectedRepo(null);
        setSelectedRepoPrivate(null);
        return { authenticated: false, navigated: false };
      }
      clearOAuthRedirectGuard();
      setUser(session.user);
      const pendingInstallationId = getPendingInstallationId();
      if (pendingInstallationId) {
        try {
          await createSession(pendingInstallationId);
          setInstallationId(pendingInstallationId);
          setInstId(pendingInstallationId);
          clearPendingInstallationId();
          setWorkspaceNotice('GitHub App installation connected. Review your installation details below.');
        } catch (err) {
          if (!(err instanceof Error && err.message === 'Unauthorized')) {
            clearPendingInstallationId();
          }
        }
      }
      if (session.installationId) {
        setInstallationId(session.installationId);
        setInstId(session.installationId);
      } else {
        clearInstallationId();
        setInstId(null);
        setInstallationRepos([]);
        setLoadedReposInstallationId(null);
      }
      return { authenticated: true, navigated: false };
    } catch {
      setUser(null);
      return { authenticated: false, navigated: false };
    }
  }, [clearOAuthRedirectGuard]);

  // --- GitHub App redirect ---
  const tryHandleGitHubAppSetupRedirect = useCallback(async (): Promise<boolean> => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('installation_id');
    if (!id) return false;

    const actualState = params.get('state');
    if (!hasInstallState(actualState)) {
      showError('GitHub App install state mismatch. Please try again.');
      return true;
    }

    try {
      const session = await getAuthSession();
      if (!session.authenticated) {
        setPendingInstallationId(id);
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        startGitHubSignIn(`/${routePath.workspaces()}`);
        return true;
      }
      await createSession(id);
    } catch (err) {
      showRateLimitToastIfNeeded(err);
      if (err instanceof Error && err.message === 'Unauthorized') {
        setPendingInstallationId(id);
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        startGitHubSignIn(`/${routePath.workspaces()}`);
        return true;
      }
      showError(err instanceof Error ? err.message : 'Failed to create session');
      return true;
    }

    consumeInstallState(actualState);
    setInstallationId(id);
    setInstId(id);
    setWorkspaceNotice('GitHub App installation setup complete. Review your installation details below.');

    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    navigate(routePath.workspaces());
    return true;
  }, [navigate, showError, showRateLimitToastIfNeeded, startGitHubSignIn]);

  const onConnectInstallation = useCallback(async () => {
    try {
      const state = createInstallState();
      rememberInstallState(state);
      const url = await getInstallUrl(state);
      window.location.assign(url);
    } catch (err) {
      showRateLimitToastIfNeeded(err);
      void showAlert(err instanceof Error ? err.message : 'Failed to start GitHub App install');
    }
  }, [showAlert, showRateLimitToastIfNeeded]);

  // --- Helpers ---
  const loadRepoMarkdownFiles = useCallback(async (instId: string, repoName: string): Promise<RepoDocFile[]> => {
    const result = await getRepoTree(instId, repoName);
    return result.files;
  }, []);

  const loadPublicRepoMarkdownFiles = useCallback(async (owner: string, repo: string): Promise<RepoDocFile[]> => {
    const result = await getPublicRepoTree(owner, repo);
    return result.files;
  }, []);

  // --- Data loaders ---
  const loadGist = useCallback(
    async (id: string, filename: string | undefined, anonymous: boolean) => {
      // Serve from cache if available. Anonymous mode skips truncated files with null content.
      const cached = currentGistId === id ? gistFiles : null;
      if (cached) {
        const cacheKeys = Object.keys(cached);
        const cacheName = filename ? safeDecodeURIComponent(filename) : cacheKeys[0];
        const cacheFile = cacheName ? cached[cacheName] : null;
        if (cacheFile && (!anonymous || cacheFile.content != null)) {
          setCurrentFileName(cacheFile.filename);
          renderDocumentContent(cacheFile.content ?? '', cacheFile.filename, null, undefined, {
            currentDocPath: cacheFile.filename,
            knownMarkdownPaths: cacheKeys,
          });
          setCurrentGistId(id);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setRepoFiles([]);
          setViewPhase(null);
          return;
        }
      }

      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        if (anonymous) {
          let res = await fetch(`https://api.github.com/gists/${encodeURIComponent(id)}`);
          if (!res.ok) {
            console.warn(`GitHub API failed (${res.status}), falling back to gist proxy`);
            res = await fetch(`/api/gists/${encodeURIComponent(id)}`);
          }
          if (!res.ok) throw await responseToApiError(res);
          const data = await res.json();
          const files = data.files as Record<string, GistFile>;
          setGistFiles(files);

          const fileKeys = Object.keys(files);
          const targetName = filename ? safeDecodeURIComponent(filename) : fileKeys[0];
          const file = targetName ? files[targetName] : null;
          if (!file) {
            showError('File not found in gist');
            return;
          }

          let content = file.content;
          if (content == null && file.raw_url && new URL(file.raw_url).hostname === 'gist.githubusercontent.com') {
            const raw = await fetch(file.raw_url, { redirect: 'error' });
            if (raw.ok) content = await raw.text();
            if (content != null) {
              const updated = { ...files, [file.filename]: { ...file, content } };
              setGistFiles(updated);
            }
          }

          setCurrentFileName(file.filename);
          renderDocumentContent(content ?? '', file.filename, null, undefined, {
            currentDocPath: file.filename,
            knownMarkdownPaths: fileKeys,
          });
          setCurrentGistId(id);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setRepoFiles([]);
          setViewPhase(null);
          return;
        }

        const gist = await getGist(id);
        setGistFiles(gist.files);

        const fileKeys = Object.keys(gist.files);
        const targetName = filename ? safeDecodeURIComponent(filename) : fileKeys[0];
        const file = targetName ? gist.files[targetName] : null;
        if (!file) {
          showError('File not found in gist');
          return;
        }

        setCurrentFileName(file.filename);
        setCurrentGistId(gist.id);
        setRepoAccessMode(null);
        setPublicRepoRef(null);
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setRepoFiles([]);
        renderDocumentContent(file.content ?? '', file.filename, null, undefined, {
          currentDocPath: file.filename,
          knownMarkdownPaths: fileKeys,
        });
        setViewPhase(null);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Unknown error');
      }
    },
    [
      showError,
      currentGistId,
      gistFiles,
      renderDocumentContent,
      activeView,
      currentFileName,
      showRateLimitToastIfNeeded,
    ],
  );

  const loadRepoFile = useCallback(
    async (path: string, forEdit: boolean) => {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name ?? null;
      if (!instId || !repoName) {
        navigate(routePath.workspaces());
        return;
      }
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        const contents = await getRepoContents(instId, repoName, path);
        if (!isRepoFile(contents)) throw new Error('Expected a file');
        const decoded = contents.content ? decodeBase64ToUtf8(contents.content) : '';
        setRepoAccessMode('installed');
        setPublicRepoRef(null);
        setCurrentRepoDocPath(contents.path);
        setCurrentRepoDocSha(contents.sha);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(contents.path);
        let knownMarkdownPaths = repoFiles.map((file) => file.path);
        if (knownMarkdownPaths.length === 0) {
          try {
            const mdFiles = await loadRepoMarkdownFiles(instId, repoName);
            setRepoFiles(mdFiles);
            knownMarkdownPaths = mdFiles.map((file) => file.path);
          } catch {
            /* sidebar index is best-effort */
          }
        }
        if (forEdit) {
          setEditingBackend('repo');
          setEditTitle(contents.name.replace(/\.md$/i, ''));
          setEditContent(decoded);
        } else {
          const wikiPaths = knownMarkdownPaths.includes(contents.path)
            ? knownMarkdownPaths
            : [...knownMarkdownPaths, contents.path];
          renderDocumentContent(
            decoded,
            contents.name,
            contents.path,
            {
              mode: 'installed',
              installationId: instId,
              selectedRepo: repoName,
            },
            {
              currentDocPath: contents.path,
              knownMarkdownPaths: wikiPaths,
            },
          );
        }
        setViewPhase(null);
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Failed to load file');
      }
    },
    [
      navigate,
      handleSessionExpired,
      showError,
      repoFiles,
      loadRepoMarkdownFiles,
      renderDocumentContent,
      activeView,
      currentFileName,
      showRateLimitToastIfNeeded,
    ],
  );

  const loadPublicRepoFile = useCallback(
    async (owner: string, repo: string, path: string) => {
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        const contents = await getPublicRepoContents(owner, repo, path);
        if (!isRepoFile(contents)) throw new Error('Expected a file');
        const decoded = contents.content ? decodeBase64ToUtf8(contents.content) : '';
        const mdFiles = await loadPublicRepoMarkdownFiles(owner, repo);
        const knownMarkdownPaths = mdFiles.map((file) => file.path);
        setRepoFiles(mdFiles);
        setRepoAccessMode('public');
        setPublicRepoRef({ owner, repo });
        setCurrentRepoDocPath(contents.path);
        setCurrentRepoDocSha(null);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(contents.path);
        setEditingBackend(null);
        renderDocumentContent(
          decoded,
          contents.name,
          contents.path,
          {
            mode: 'public',
            publicRepoRef: { owner, repo },
          },
          {
            currentDocPath: contents.path,
            knownMarkdownPaths: knownMarkdownPaths.includes(contents.path)
              ? knownMarkdownPaths
              : [...knownMarkdownPaths, contents.path],
          },
        );
        setViewPhase(null);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Failed to load file');
      }
    },
    [
      activeView,
      currentFileName,
      loadPublicRepoMarkdownFiles,
      renderDocumentContent,
      showError,
      showRateLimitToastIfNeeded,
    ],
  );

  // --- Route handler ---
  const handleRoute = useCallback(
    async (r: Route, authenticatedOverride?: boolean) => {
      const isAuthenticated = authenticatedOverride ?? Boolean(user);
      const enteringDocumentRoute =
        r.name === 'repofile' ||
        r.name === 'repoedit' ||
        r.name === 'edit' ||
        r.name === 'gist' ||
        r.name === 'publicrepofile';
      if (enteringDocumentRoute && activeView !== 'content' && activeView !== 'edit') {
        // Reentering an existing repo/gist should reset manual sidebar overrides.
        setSidebarVisibilityOverride(null);
      }

      switch (r.name) {
        case 'workspaces':
          if (!isAuthenticated) {
            startGitHubSignIn(`/${routePath.workspaces()}`);
            return;
          }
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setGistFiles(null);
          setCurrentFileName(null);
          setRepoFiles([]);
          setViewPhase(null);
          return;
        case 'publicrepodocuments': {
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          setViewPhase('loading');
          try {
            const mdFiles = await loadPublicRepoMarkdownFiles(owner, repo);
            if (mdFiles.length === 0) {
              showError('No markdown files found in this repository');
              return;
            }
            setRepoAccessMode('public');
            setPublicRepoRef({ owner, repo });
            setRepoFiles(mdFiles);
            const indexFile = mdFiles.find((f) => f.path.toLowerCase() === 'index.md');
            const target = indexFile ?? mdFiles[0];
            if (isSubdomainMode() && indexFile && target.path === indexFile.path) {
              await loadPublicRepoFile(owner, repo, target.path);
              return;
            }
            navigate(routePath.publicRepoFile(owner, repo, target.path), { replace: true });
          } catch (err) {
            showRateLimitToastIfNeeded(err);
            showError(err instanceof Error ? err.message : 'Failed to load public repo documents');
          }
          return;
        }
        case 'publicrepofile': {
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const decodedPath = safeDecodeURIComponent(r.params.path).replace(/^\/+/, '');
          await loadPublicRepoFile(owner, repo, decodedPath);
          return;
        }
        case 'repodocuments': {
          syncRepoStateFromHistory();
          syncRepoState();
          const instId = getInstallationId();
          const repoName = getSelectedRepo()?.full_name ?? null;
          if (!instId || !repoName) {
            navigate(routePath.workspaces());
            return;
          }
          setViewPhase('loading');
          try {
            const mdFiles = await loadRepoMarkdownFiles(instId, repoName);
            if (mdFiles.length > 0) {
              setRepoAccessMode('installed');
              setPublicRepoRef(null);
              setRepoFiles(mdFiles);
              const indexFile = mdFiles.find((f) => f.path.toLowerCase() === 'index.md');
              const target = indexFile ?? mdFiles[0];
              navigate(routePath.repoFile(target.path), { replace: true });
              return;
            }
          } catch (err) {
            if (err instanceof SessionExpiredError) {
              handleSessionExpired();
              return;
            }
            // 404 means directory doesn't exist yet — fall through to repoNew
            const msg = err instanceof Error ? err.message : '';
            if (!msg.includes('404')) {
              showRateLimitToastIfNeeded(err);
              showError(msg || 'Failed to load repo documents');
              return;
            }
          }
          navigate(routePath.repoNew(), { replace: true });
          return;
        }
        case 'repofile':
          syncRepoStateFromHistory();
          syncRepoState();
          await loadRepoFile(safeDecodeURIComponent(r.params.path), false);
          return;
        case 'reponew': {
          syncRepoStateFromHistory();
          syncRepoState();
          const instId = getInstallationId();
          const repoName = getSelectedRepo()?.full_name ?? null;
          if (!instId || !repoName) {
            navigate(routePath.workspaces());
            return;
          }
          setDraftMode(false);
          setRepoAccessMode('installed');
          setPublicRepoRef(null);
          setEditingBackend('repo');
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setCurrentGistId(null);
          setCurrentFileName(null);
          setGistFiles(null);
          setRepoFiles([]);
          setPreviewVisible(defaultPreviewVisible());
          setEditTitle(localStorage.getItem(repoNewDraftKey(instId, repoName, 'title')) || DEFAULT_NEW_FILENAME);
          setEditContent(localStorage.getItem(repoNewDraftKey(instId, repoName, 'content')) ?? '');
          setViewPhase(null);
          return;
        }
        case 'repoedit':
          setDraftMode(false);
          syncRepoStateFromHistory();
          syncRepoState();
          await loadRepoFile(safeDecodeURIComponent(r.params.path), true);
          return;
        case 'new':
          if (activeView === 'edit') {
            localStorage.removeItem(DRAFT_TITLE_KEY);
            localStorage.removeItem(DRAFT_CONTENT_KEY);
            setHasUnsavedChanges(false);
          }
          setDraftMode(true);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setEditingBackend('gist');
          setCurrentGistId(null);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setCurrentFileName(null);
          setGistFiles(null);
          setRepoFiles([]);
          setPreviewVisible(defaultPreviewVisible());
          setEditTitle(localStorage.getItem(DRAFT_TITLE_KEY) || DEFAULT_NEW_FILENAME);
          setEditContent(localStorage.getItem(DRAFT_CONTENT_KEY) ?? '');
          setViewPhase(null);
          if (activeView === 'edit') focusEditorSoon();
          return;
        case 'edit': {
          if (!isAuthenticated) {
            startGitHubSignIn(`/${routePath.gistEdit(r.params.id, r.params.filename)}`);
            return;
          }
          setDraftMode(false);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          // Serve from cache if we already have this gist's files
          const cachedFiles = currentGistId === r.params.id ? gistFiles : null;
          if (cachedFiles) {
            const cacheKeys = Object.keys(cachedFiles);
            const cacheName = r.params.filename ? safeDecodeURIComponent(r.params.filename) : cacheKeys[0];
            const cacheFile = cacheName ? cachedFiles[cacheName] : null;
            if (cacheFile) {
              setEditingBackend('gist');
              setCurrentGistId(r.params.id);
              setCurrentFileName(cacheFile.filename);
              setCurrentRepoDocPath(null);
              setCurrentRepoDocSha(null);
              setRepoFiles([]);
              setEditTitle(cacheFile.filename.replace(/\.md$/i, ''));
              setEditContent(cacheFile.content ?? '');
              setHasUnsavedChanges(false);
              setViewPhase(null);
              return;
            }
          }
          setViewPhase('loading');
          try {
            const gist = await getGist(r.params.id);
            setGistFiles(gist.files);

            const fileKeys = Object.keys(gist.files);
            const targetName = r.params.filename ? safeDecodeURIComponent(r.params.filename) : fileKeys[0];
            const file = targetName ? gist.files[targetName] : null;
            if (!file) {
              showError('File not found in gist');
              return;
            }

            setEditingBackend('gist');
            setCurrentGistId(gist.id);
            setCurrentFileName(file.filename);
            setCurrentRepoDocPath(null);
            setCurrentRepoDocSha(null);
            setRepoFiles([]);
            setEditTitle(file.filename.replace(/\.md$/i, ''));
            setEditContent(file.content ?? '');
            setViewPhase(null);
          } catch (err) {
            showRateLimitToastIfNeeded(err);
            showError(err instanceof Error ? err.message : 'Failed to load gist');
          }
          return;
        }
        case 'gist': {
          const id = r.params.id;
          const filename = r.params.filename;
          await loadGist(id, filename, !isAuthenticated);
          return;
        }
        case 'home':
          if (isAuthenticated) navigate(routePath.workspaces(), { replace: true });
          else navigate(routePath.freshDraft(), { replace: true });
          return;
        default:
          setDraftMode(false);
          setViewPhase(null);
      }
    },
    [
      navigate,
      syncRepoStateFromHistory,
      syncRepoState,
      loadRepoFile,
      loadPublicRepoFile,
      loadRepoMarkdownFiles,
      loadPublicRepoMarkdownFiles,
      loadGist,
      showError,
      focusEditorSoon,
      activeView,
      user,
      currentGistId,
      gistFiles,
      startGitHubSignIn,
      handleSessionExpired,
      showRateLimitToastIfNeeded,
      defaultPreviewVisible,
    ],
  );

  // --- Init ---
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    (async () => {
      const handledSetup = await tryHandleGitHubAppSetupRedirect();
      const auth = await tryRestoreAuth();
      if (!handledSetup && !auth.navigated) {
        await handleRoute(route, auth.authenticated);
      }
      document.getElementById('app')!.classList.add('ready');
    })();
  }, [handleRoute, route, tryHandleGitHubAppSetupRedirect, tryRestoreAuth]);

  // --- Route changes ---
  const prevRoute = useRef(route);
  useEffect(() => {
    if (!initialized.current) return;
    if (route === prevRoute.current) return;
    prevRoute.current = route;
    handleRoute(route);
  }, [route, handleRoute]);

  // --- Draft persistence ---
  useEffect(() => {
    if (!draftMode) return;
    localStorage.setItem(DRAFT_TITLE_KEY, editTitle);
    localStorage.setItem(DRAFT_CONTENT_KEY, editContent);
  }, [draftMode, editTitle, editContent]);

  useEffect(() => {
    if (route.name !== 'reponew') return;
    if (editingBackend !== 'repo' || currentRepoDocPath) return;
    const instId = installationId ?? getInstallationId();
    const repoName = selectedRepo ?? getSelectedRepo()?.full_name ?? null;
    if (!instId || !repoName) return;
    localStorage.setItem(repoNewDraftKey(instId, repoName, 'title'), editTitle);
    localStorage.setItem(repoNewDraftKey(instId, repoName, 'content'), editContent);
  }, [route.name, editingBackend, currentRepoDocPath, installationId, selectedRepo, editTitle, editContent]);

  useEffect(() => {
    void installationId;
    void user?.login;
    setInstallationRepos([]);
    setInstallationReposLoading(false);
    setLoadedReposInstallationId(null);
  }, [installationId, user?.login]);

  // --- Theme toggle ---
  const toggleTheme = useCallback(() => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {}
  }, []);

  // --- Preview state ---
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsDesktopWidth(event.matches);
    setIsDesktopWidth(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(EDITOR_PREVIEW_VISIBLE_KEY, previewVisible ? 'true' : 'false');
    } catch {}
  }, [previewVisible]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  const onTogglePreview = useCallback(() => {
    setPreviewVisible((v) => !v);
  }, []);

  // --- Sign out ---
  const signOut = useCallback(() => {
    void logout().catch(() => {});
    clearInstallationId();
    clearSelectedRepo();
    setUser(null);
    setInstId(null);
    setSelectedRepo(null);
    setSelectedRepoPrivate(null);
    setRepoAccessMode(null);
    setPublicRepoRef(null);
    setCurrentGistId(null);
    navigate(routePath.home());
  }, [navigate]);

  const onEdit = useCallback(() => {
    if (repoAccessMode === 'installed' && currentRepoDocPath) navigate(routePath.repoEdit(currentRepoDocPath));
    else if (currentGistId && currentFileName) navigate(routePath.gistEdit(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistEdit(currentGistId));
  }, [repoAccessMode, currentRepoDocPath, currentGistId, currentFileName, navigate]);

  const onCancel = useCallback(() => {
    if (currentRepoDocPath) navigate(routePath.repoFile(currentRepoDocPath));
    else if (currentGistId && currentFileName) navigate(routePath.gistView(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistView(currentGistId));
    else if (selectedRepo) navigate(routePath.repoDocuments());
    else navigate(routePath.workspaces());
  }, [currentRepoDocPath, currentGistId, currentFileName, selectedRepo, navigate]);

  const onSharePublicLink = useCallback(async () => {
    if (
      repoAccessMode !== 'installed' ||
      route.name !== 'repoedit' ||
      selectedRepoPrivate !== false ||
      !selectedRepo ||
      !currentRepoDocPath
    ) {
      showFailureToast('Public sharing is not available for this file');
      return;
    }

    const [owner, repo] = selectedRepo.split('/');
    if (!owner || !repo) {
      showFailureToast('Failed to build public link');
      return;
    }
    const publicPath = routePath.publicRepoFile(owner, repo, currentRepoDocPath);
    const url = `${window.location.origin}/${publicPath}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement('textarea');
        input.value = url;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      showSuccessToast('Copied public read-only link');
    } catch {
      showFailureToast('Failed to copy public link');
    }
  }, [
    repoAccessMode,
    route.name,
    selectedRepoPrivate,
    selectedRepo,
    currentRepoDocPath,
    showFailureToast,
    showSuccessToast,
  ]);

  const onSave = useCallback(async () => {
    const title = editTitle.trim() || DEFAULT_NEW_FILENAME;
    const content = editContent;
    setSaving(true);

    try {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name ?? null;

      if (editingBackend === 'repo' && currentRepoDocPath && instId && repoName) {
        const contentB64 = encodeUtf8ToBase64(content);
        await putRepoFile(
          instId,
          repoName,
          currentRepoDocPath,
          `Update ${currentRepoDocPath}`,
          contentB64,
          currentRepoDocSha ?? undefined,
        );

        const knownMarkdownPaths = repoFiles.map((file) => file.path);
        renderDocumentContent(content, currentRepoDocPath.split('/').pop() ?? null, currentRepoDocPath, undefined, {
          currentDocPath: currentRepoDocPath,
          knownMarkdownPaths: knownMarkdownPaths.includes(currentRepoDocPath)
            ? knownMarkdownPaths
            : [...knownMarkdownPaths, currentRepoDocPath],
        });
        navigate(routePath.repoFile(currentRepoDocPath));
      } else if (editingBackend === 'repo' && repoName && instId) {
        const filename = sanitizeTitleToFileName(title);
        const path = filename;
        const contentB64 = encodeUtf8ToBase64(content);
        await putRepoFile(instId, repoName, path, `Create ${filename}`, contentB64);
        localStorage.removeItem(repoNewDraftKey(instId, repoName, 'title'));
        localStorage.removeItem(repoNewDraftKey(instId, repoName, 'content'));
        setCurrentRepoDocPath(path);
        setCurrentRepoDocSha(null);

        const knownMarkdownPaths = repoFiles.map((file) => file.path);
        renderDocumentContent(content, filename, path, undefined, {
          currentDocPath: filename,
          knownMarkdownPaths: knownMarkdownPaths.includes(filename)
            ? knownMarkdownPaths
            : [...knownMarkdownPaths, filename],
        });
        navigate(routePath.repoFile(path));
      } else {
        let gist: GistDetail;
        const filename = currentFileName ?? sanitizeTitleToFileName(title);
        if (currentGistId) {
          gist = await updateGist(currentGistId, content, filename);
        } else {
          gist = await createGist(content, filename, title);
          markGistRecentlyCreated(user?.login ?? null, gist);
        }
        setCurrentGistId(gist.id);
        setCurrentFileName(filename);
        setGistFiles(gist.files);
        if (draftMode) {
          localStorage.removeItem(DRAFT_TITLE_KEY);
          localStorage.removeItem(DRAFT_CONTENT_KEY);
          setDraftMode(false);
        }

        renderDocumentContent(content, filename, null, undefined, {
          currentDocPath: filename,
          knownMarkdownPaths: Object.keys(gist.files),
        });
        navigate(routePath.gistView(gist.id, filename));
      }
      showSuccessToast('Saved');
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
        return;
      }
      showRateLimitToastIfNeeded(err);
      void showAlert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
      setHasUnsavedChanges(false);
    }
  }, [
    editTitle,
    editContent,
    editingBackend,
    currentRepoDocPath,
    currentRepoDocSha,
    currentGistId,
    currentFileName,
    draftMode,
    navigate,
    handleSessionExpired,
    user,
    showAlert,
    showRateLimitToastIfNeeded,
    showSuccessToast,
    renderDocumentContent,
    repoFiles,
  ]);

  const getActiveDocumentStore = useCallback(() => {
    if (currentGistId) {
      return createGistDocumentStore(currentGistId);
    }

    if (repoAccessMode === 'installed' && selectedRepo) {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name;
      if (!instId || !repoName) return null;
      return createRepoDocumentStore(instId, repoName);
    }

    return null;
  }, [currentGistId, repoAccessMode, selectedRepo]);

  // --- Sidebar actions ---
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      const doNavigate = () => {
        setHasUnsavedChanges(false);
        if (currentGistId) {
          navigate(routePath.gistView(currentGistId, filePath));
        } else if (repoAccessMode === 'installed' && selectedRepo) {
          navigate(routePath.repoFile(filePath));
        } else if (repoAccessMode === 'public' && publicRepoRef) {
          navigate(routePath.publicRepoFile(publicRepoRef.owner, publicRepoRef.repo, filePath));
        }
      };

      if (activeView === 'edit' && hasUnsavedChanges) {
        const action = await showConfirm('You have unsaved changes. Discard and switch files?');
        if (action) doNavigate();
        return;
      }
      doNavigate();
    },
    [currentGistId, repoAccessMode, selectedRepo, publicRepoRef, activeView, hasUnsavedChanges, navigate, showConfirm],
  );

  const handleCreateFile = useCallback(
    async (filePath: string) => {
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        if (store.kind === 'gist') {
          if (!currentGistId) return;
          const gist = await store.createFile(filePath);
          setGistFiles(gist.files);
          setHasUnsavedChanges(false);
          navigate(routePath.gistEdit(currentGistId, filePath));
        } else {
          const result = await store.createFile(filePath);
          setRepoFiles((prev) =>
            [...prev, { name: fileNameFromPath(filePath), path: result.content.path, sha: result.content.sha }].sort(
              (a, b) => a.path.localeCompare(b.path),
            ),
          );
          setHasUnsavedChanges(false);
          navigate(routePath.repoEdit(result.content.path));
        }
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to create file');
      }
    },
    [getActiveDocumentStore, currentGistId, navigate, showAlert, showRateLimitToastIfNeeded],
  );

  const handleEditFile = useCallback(
    async (filePath: string) => {
      if (activeView === 'edit' && currentFileName === filePath) return;

      const target = currentGistId
        ? routePath.gistEdit(currentGistId, filePath)
        : repoAccessMode === 'installed' && selectedRepo
          ? routePath.repoEdit(filePath)
          : null;
      if (!target) return;

      if (activeView === 'edit' && hasUnsavedChanges) {
        const saveFirst = await showConfirm('You have unsaved changes. Save before editing another file?');
        if (saveFirst) {
          await onSave();
        } else {
          const discard = await showConfirm('Discard unsaved changes and continue editing another file?');
          if (!discard) return;
          setHasUnsavedChanges(false);
        }
      }

      navigate(target);
    },
    [
      currentGistId,
      repoAccessMode,
      selectedRepo,
      activeView,
      currentFileName,
      hasUnsavedChanges,
      onSave,
      navigate,
      showConfirm,
    ],
  );

  const handleViewOnGitHub = useCallback(
    (filePath: string) => {
      if (currentGistId) {
        window.open(`https://gist.github.com/${currentGistId}`, '_blank', 'noopener,noreferrer');
        return;
      }
      const repoFullName =
        repoAccessMode === 'installed'
          ? selectedRepo
          : repoAccessMode === 'public' && publicRepoRef
            ? `${publicRepoRef.owner}/${publicRepoRef.repo}`
            : null;
      if (!repoFullName) return;
      const repoPath = filePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      window.open(`https://github.com/${repoFullName}/blob/HEAD/${repoPath}`, '_blank', 'noopener,noreferrer');
    },
    [currentGistId, repoAccessMode, selectedRepo, publicRepoRef],
  );

  const handleDeleteFile = useCallback(
    async (filePath: string) => {
      if (!(await showConfirm(`Delete "${filePath}"?`))) return;
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        if (store.kind === 'gist') {
          if (!currentGistId) return;
          const gist = await store.deleteFile({ name: filePath });
          setGistFiles(gist.files);
          const deletedCurrent = currentFileName === filePath;
          if (deletedCurrent) {
            const remaining = Object.keys(gist.files);
            if (remaining.length > 0) {
              navigate(routePath.gistView(currentGistId, remaining[0]));
            } else {
              navigate(routePath.workspaces());
            }
          }
        } else {
          const repoFile = findRepoDocFile(repoFiles, filePath);
          if (!repoFile) return;
          await store.deleteFile(repoFile);
          const remaining = repoFiles.filter((f) => f.path !== filePath);
          setRepoFiles(remaining);
          const deletedCurrent = currentRepoDocPath === repoFile.path;
          if (deletedCurrent) {
            if (remaining.length > 0) {
              navigate(routePath.repoFile(remaining[0].path));
            } else {
              navigate(routePath.repoDocuments());
            }
          }
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to delete file');
      }
    },
    [
      getActiveDocumentStore,
      currentFileName,
      repoFiles,
      currentRepoDocPath,
      navigate,
      handleSessionExpired,
      showConfirm,
      showAlert,
      showRateLimitToastIfNeeded,
      currentGistId,
    ],
  );

  const handleRenameFile = useCallback(
    async (oldPath: string, newPath: string) => {
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        if (store.kind === 'gist') {
          if (!currentGistId) return;
          const gist = await store.renameFile({ name: oldPath }, newPath);
          setGistFiles(gist.files);
          if (currentFileName === oldPath) {
            setCurrentFileName(newPath);
            navigate(routePath.gistView(currentGistId, newPath));
          }
        } else {
          const oldFile = findRepoDocFile(repoFiles, oldPath);
          if (!oldFile) return;
          const created = await store.renameFile(oldFile, newPath);
          const updatedFiles = repoFiles
            .map((f) =>
              f.path === oldPath
                ? {
                    name: fileNameFromPath(newPath),
                    path: created.content.path,
                    sha: created.content.sha,
                  }
                : f,
            )
            .sort((a, b) => a.path.localeCompare(b.path));
          setRepoFiles(updatedFiles);
          if (currentFileName === oldPath) {
            navigate(routePath.repoFile(created.content.path));
          }
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to rename file');
      }
    },
    [
      getActiveDocumentStore,
      currentGistId,
      currentFileName,
      repoFiles,
      navigate,
      handleSessionExpired,
      showAlert,
      showRateLimitToastIfNeeded,
    ],
  );

  // --- GitHub App callbacks ---
  const onSelectRepo = useCallback((fullName: string, id: number, isPrivate: boolean) => {
    setSelectedRepo(fullName);
    setSelectedRepoPrivate(isPrivate);
    storeSelectedRepo({ full_name: fullName, id, private: isPrivate });
  }, []);

  const onOpenRepoFromWorkspaces = useCallback(
    (fullName: string, id: number, isPrivate: boolean) => {
      onSelectRepo(fullName, id, isPrivate);
      navigate(routePath.repoDocuments(), {
        state: {
          selectedRepo: {
            full_name: fullName,
            id,
            private: isPrivate,
          },
        },
      });
    },
    [navigate, onSelectRepo],
  );

  const onOpenRepoMenu = useCallback(() => {
    if (!user) return;

    const shouldLoadRepos =
      Boolean(installationId) && !installationReposLoading && loadedReposInstallationId !== installationId;
    const shouldLoadGists = !menuGistsLoading && !menuGistsLoaded;
    if (!shouldLoadRepos && !shouldLoadGists) return;

    if (shouldLoadRepos) setInstallationReposLoading(true);
    if (shouldLoadGists) setMenuGistsLoading(true);

    void (async () => {
      const tasks: Promise<void>[] = [];

      if (shouldLoadRepos && installationId) {
        tasks.push(
          (async () => {
            try {
              const repos = await listInstallationRepos(installationId);
              setInstallationRepos(repos.repositories);
              setLoadedReposInstallationId(installationId);
            } catch (err) {
              if (err instanceof SessionExpiredError) {
                handleSessionExpired();
                return;
              }
              showRateLimitToastIfNeeded(err);
              setInstallationRepos([]);
            } finally {
              setInstallationReposLoading(false);
            }
          })(),
        );
      }

      if (shouldLoadGists) {
        tasks.push(
          (async () => {
            try {
              const gists = await listGists(1, 30);
              setMenuGists(gists);
              setMenuGistsLoaded(true);
            } catch (err) {
              showRateLimitToastIfNeeded(err);
              setMenuGists([]);
            } finally {
              setMenuGistsLoading(false);
            }
          })(),
        );
      }

      await Promise.all(tasks);
    })();
  }, [
    user,
    installationId,
    installationReposLoading,
    loadedReposInstallationId,
    handleSessionExpired,
    menuGistsLoading,
    menuGistsLoaded,
    showRateLimitToastIfNeeded,
  ]);

  const onDisconnect = useCallback(async () => {
    const confirmed = await showConfirm('Disconnect all repos?');
    if (!confirmed) return;

    try {
      await disconnectInstallation();
    } catch {
      /* still clear local state below */
    } finally {
      clearInstallationId();
      clearSelectedRepo();
      setInstId(null);
      setSelectedRepo(null);
      setSelectedRepoPrivate(null);
      setInstallationRepos([]);
      setLoadedReposInstallationId(null);
      navigate(routePath.workspaces());
    }
  }, [navigate, showConfirm]);

  // --- Render active view ---
  const renderView = () => {
    switch (activeView) {
      case 'workspaces': {
        const reposInitialLoaded = !installationId || loadedReposInstallationId === installationId;
        const gistsInitialLoaded = menuGistsLoaded;
        return user ? (
          <WorkspacesView
            installationId={installationId}
            availableRepos={installationRepos}
            repoListLoading={installationReposLoading}
            onLoadRepos={onOpenRepoMenu}
            onConnect={onConnectInstallation}
            onDisconnect={onDisconnect}
            onOpenRepo={onOpenRepoFromWorkspaces}
            reposInitialLoaded={reposInitialLoaded}
            gistsInitialLoaded={gistsInitialLoaded}
            initialGists={menuGists}
            navigate={navigate}
            userLogin={user.login}
            workspaceNotice={workspaceNotice}
            onDismissWorkspaceNotice={() => setWorkspaceNotice(null)}
          />
        ) : null;
      }
      case 'content':
        return (
          <ContentView
            html={renderedHtml}
            markdown={renderMode === 'markdown'}
            onImageClick={onOpenLightbox}
            onInternalLinkNavigate={(rawRoute) => {
              const routePathname = rawRoute.replace(/^\/+/, '');
              navigate(routePathname);
            }}
          />
        );
      case 'edit':
        return (
          <EditView
            content={editContent}
            previewHtml={editPreviewHtml}
            previewVisible={previewVisible}
            canRenderPreview={canRenderPreview}
            onTogglePreview={onTogglePreview}
            onContentChange={onEditContentChange}
            onPreviewImageClick={onOpenLightbox}
            onEditorPaste={handleEditorPaste}
            saving={saving}
            canSave={hasUnsavedChanges}
            onSave={onSave}
          />
        );
      case 'loading':
        return <LoadingView />;
      case 'error':
        return (
          <ErrorView
            message={errorMessage}
            onRetry={() => {
              void handleRoute(route);
            }}
          />
        );
      default:
        return null;
    }
  };

  const sidebarFiles = useMemo(() => {
    if (gistFiles) {
      return Object.keys(gistFiles).map((path) => ({
        path,
        active: path === currentFileName,
      }));
    }
    if (repoFiles.length > 0 && currentRepoDocPath) {
      const currentPath = currentRepoDocPath;
      return repoFiles.map((f) => ({
        path: f.path,
        active: f.path === currentPath,
      }));
    }
    return [];
  }, [gistFiles, currentFileName, repoFiles, currentRepoDocPath]);

  const sidebarEligible = activeView === 'content' || activeView === 'edit';
  const sidebarDisabled = activeView === 'edit' && draftMode;
  const defaultShowSidebar = isDesktopWidth && !sidebarDisabled && (!!user || repoAccessMode === 'public');
  const showSidebar = sidebarEligible && (sidebarVisibilityOverride ?? defaultShowSidebar);
  const editingFileName = currentFileName ?? editTitle;
  const editPreviewEnabled = isMarkdownFileName(editingFileName);
  const canRenderPreview = editPreviewEnabled && isDesktopWidth;
  const showLoggedOutNewDocPreviewDescription =
    route.name === 'new' && activeView === 'edit' && !user && editContent.trim().length === 0;
  const showEditorCancel = activeView === 'edit' && !draftMode && repoAccessMode !== 'public';
  const showEditorSave = activeView === 'edit' && !(draftMode && !user) && repoAccessMode !== 'public';
  const editPreviewHtml = useMemo(
    () =>
      editPreviewEnabled
        ? parseMarkdownToHtml(
            showLoggedOutNewDocPreviewDescription ? LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION : editContent,
            {
              resolveImageSrc: (src) =>
                resolveMarkdownImageSrc(src, editingBackend === 'repo' ? currentRepoDocPath : null),
            },
          )
        : '',
    [
      currentRepoDocPath,
      editPreviewEnabled,
      editContent,
      editingBackend,
      resolveMarkdownImageSrc,
      showLoggedOutNewDocPreviewDescription,
    ],
  );
  const onToggleSidebar = useCallback(() => {
    setSidebarVisibilityOverride((prev) => {
      const current = prev ?? defaultShowSidebar;
      return !current;
    });
  }, [defaultShowSidebar]);
  const onSidebarSplitPointerDown = useCallback(
    (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (!isDesktopWidth) return;
      const onMove = (moveEvent: globalThis.PointerEvent) => {
        setSidebarWidth(clampSidebarWidth(moveEvent.clientX));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      event.preventDefault();
    },
    [isDesktopWidth],
  );
  const onOpenLightbox = useCallback((src: string, alt: string) => {
    setLightboxImage({ src, alt });
  }, []);
  const onCloseLightbox = useCallback(() => {
    setLightboxImage(null);
  }, []);
  const onEditContentChange = useCallback((content: string) => {
    setEditContent(content);
    setHasUnsavedChanges(true);
  }, []);
  const handleSignInWithGitHub = useCallback(() => {
    if (isSubdomainMode()) {
      const { protocol, hostname, port } = window.location;
      const apexHost = hostname.endsWith('.input.md')
        ? 'input.md'
        : hostname.endsWith('.localhost')
          ? port
            ? `localhost:${port}`
            : 'localhost'
          : 'input.md';
      window.location.assign(`${protocol}//${apexHost}/input.md`);
      return;
    }
    startGitHubSignIn(`/${routePath.workspaces()}`);
  }, [startGitHubSignIn]);
  const showHeaderEdit =
    activeView === 'content' &&
    (currentGistId !== null || (currentRepoDocPath !== null && repoAccessMode === 'installed'));
  const showHeaderShare =
    activeView === 'edit' &&
    route.name === 'repoedit' &&
    repoAccessMode === 'installed' &&
    selectedRepoPrivate === false &&
    currentRepoDocPath !== null;
  const inRepoContext =
    (activeView === 'content' || activeView === 'edit') &&
    repoAccessMode === 'installed' &&
    (currentRepoDocPath !== null || (editingBackend === 'repo' && selectedRepo !== null));
  const showHeaderLeftLoading = activeView === 'loading' && Boolean(user);

  return (
    <>
      <Toolbar
        view={activeView}
        user={user}
        selectedRepo={selectedRepo}
        selectedRepoPrivate={selectedRepoPrivate}
        inRepoContext={inRepoContext}
        availableRepos={installationRepos}
        repoListLoading={installationReposLoading}
        menuGists={menuGists.slice(0, 6)}
        menuGistsLoading={menuGistsLoading}
        draftMode={draftMode}
        sidebarVisible={showSidebar}
        showShare={showHeaderShare}
        onShare={() => {
          void onSharePublicLink();
        }}
        showEdit={showHeaderEdit}
        editUrl={null}
        navigate={navigate}
        onOpenRepoMenu={onOpenRepoMenu}
        onSelectRepo={onSelectRepo}
        onSignOut={signOut}
        onToggleTheme={toggleTheme}
        onToggleSidebar={onToggleSidebar}
        onEdit={onEdit}
        showLeftLoading={showHeaderLeftLoading}
        showPreviewToggle={activeView === 'edit' && editPreviewEnabled}
        previewVisible={previewVisible}
        onTogglePreview={onTogglePreview}
        showCancel={showEditorCancel}
        onCancel={onCancel}
        showSave={showEditorSave}
        saving={saving}
        canSave={hasUnsavedChanges}
        onSave={onSave}
        onSignInWithGitHub={handleSignInWithGitHub}
      />
      <div
        class={showSidebar ? 'app-body app-body--with-sidebar' : 'app-body app-body--no-sidebar'}
        style={showSidebar ? ({ '--sidebar-width': `${sidebarWidth}px` } as JSX.CSSProperties) : undefined}
      >
        {showSidebar && (
          <>
            <div class="sidebar-backdrop" onClick={onToggleSidebar} />
            <Sidebar
              files={sidebarFiles}
              onSelectFile={handleSelectFile}
              onEditFile={handleEditFile}
              onViewOnGitHub={handleViewOnGitHub}
              canViewOnGitHub={currentGistId !== null || selectedRepo !== null || publicRepoRef !== null}
              disabled={sidebarDisabled}
              readOnly={repoAccessMode === 'public'}
              onCreateFile={handleCreateFile}
              onDeleteFile={handleDeleteFile}
              onRenameFile={handleRenameFile}
            />
            <div
              class="sidebar-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSidebarSplitPointerDown}
            />
          </>
        )}
        <ErrorBoundary
          fallbackMessage="This screen crashed while rendering."
          resetKey={route.name}
          onReset={() => {
            void handleRoute(route);
          }}
        >
          <main>{renderView()}</main>
        </ErrorBoundary>
      </div>
      {lightboxImage && <ImageLightbox src={lightboxImage.src} alt={lightboxImage.alt} onClose={onCloseLightbox} />}
    </>
  );
}
