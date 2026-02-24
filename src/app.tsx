import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseAnsiToHtml } from './ansi';
import { useDialogs } from './components/DialogProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { useToast } from './components/ToastProvider';
import { type ActiveView, Toolbar } from './components/Toolbar';
import { REPO_DOCS_DIR } from './constants';
import {
  createGistDocumentStore,
  createRepoDocumentStore,
  findRepoDocFile,
  type RepoDocFile,
  repoDocRelativePath,
  toRepoDocPath,
} from './document_store';
import { markGistRecentlyCreated } from './gist_consistency';
import {
  createGist,
  type GistDetail,
  type GistFile,
  type GitHubUser,
  getAuthSession,
  getGist,
  logout,
  updateGist,
} from './github';
import {
  clearInstallationId,
  clearPendingInstallationId,
  clearSelectedRepo,
  consumeInstallState,
  createSession,
  disconnectInstallation,
  getInstallationId,
  getPendingInstallationId,
  getRepoContents,
  getSelectedRepo,
  type InstallationRepo,
  isRepoFile,
  listInstallationRepos,
  putRepoFile,
  SessionExpiredError,
  setInstallationId,
  setPendingInstallationId,
  setSelectedRepo as storeSelectedRepo,
} from './github_app';
import { useRoute } from './hooks/useRoute';
import { parseMarkdownToHtml } from './markdown';
import { type Route, routePath } from './routing';
import { decodeBase64ToUtf8, encodeUtf8ToBase64 } from './util';
import { AuthView } from './views/AuthView';
import { ContentView } from './views/ContentView';
import { DocumentsView } from './views/DocumentsView';
import { EditView } from './views/EditView';
import { ErrorView } from './views/ErrorView';
import { GitHubAppView } from './views/GitHubAppView';
import { LoadingView } from './views/LoadingView';

const EDITOR_PREVIEW_VISIBLE_KEY = 'editor_preview_visible';
const DRAFT_TITLE_KEY = 'draft_title';
const DRAFT_CONTENT_KEY = 'draft_content';
const DEFAULT_NEW_FILENAME = 'index.md';
const REPO_NEW_DRAFT_KEY_PREFIX = 'repo_new_draft';
const LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION = [
  '### Input',
  '',
  'Write Markdown and preview it live.',
  '',
  'Sign in to save documents to GitHub Gists, or connect a repo to manage multi-file docs under `.input/documents/`.',
].join('\n');

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

function viewFromRoute(route: Route): ActiveView {
  switch (route.name) {
    case 'auth':
      return 'auth';
    case 'documents':
      return 'documents';
    case 'githubapp':
      return 'githubapp';
    case 'repofile':
    case 'gist':
      return 'content';
    default:
      return 'edit';
  }
}

export function App() {
  const { route, navigate } = useRoute();
  const { showAlert, showConfirm } = useDialogs();
  const { showToast } = useToast();

  // --- Shared state ---
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [installationId, setInstId] = useState<string | null>(getInstallationId());
  const [selectedRepo, setSelectedRepo] = useState<string | null>(getSelectedRepo()?.full_name ?? null);
  const [selectedRepoPrivate, setSelectedRepoPrivate] = useState<boolean | null>(getSelectedRepo()?.private ?? null);
  const [installationRepos, setInstallationRepos] = useState<InstallationRepo[]>([]);
  const [installationReposLoading, setInstallationReposLoading] = useState(false);
  const [loadedReposInstallationId, setLoadedReposInstallationId] = useState<string | null>(null);

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
  const [previewVisible, setPreviewVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(EDITOR_PREVIEW_VISIBLE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [isDesktopWidth, setIsDesktopWidth] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(min-width: 1024px)').matches;
  });

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

  const handleSessionExpired = useCallback(() => {
    clearInstallationId();
    clearSelectedRepo();
    setInstId(null);
    setSelectedRepo(null);
    setSelectedRepoPrivate(null);
    navigate(routePath.auth());
  }, [navigate]);

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg);
    setViewPhase('error');
  }, []);

  const focusEditorSoon = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('.doc-editor')?.focus();
      });
    });
  }, []);

  const renderDocumentContent = useCallback((content: string, fileName: string | null | undefined) => {
    if (isMarkdownFileName(fileName)) {
      setRenderedHtml(parseMarkdownToHtml(content));
      setRenderMode('markdown');
      return;
    }
    setRenderedHtml(parseAnsiToHtml(content));
    setRenderMode('ansi');
  }, []);

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
      setUser(session.user);
      const pendingInstallationId = getPendingInstallationId();
      if (pendingInstallationId) {
        try {
          await createSession(pendingInstallationId);
          setInstallationId(pendingInstallationId);
          setInstId(pendingInstallationId);
          clearPendingInstallationId();
          if (route.name === 'auth') {
            navigate(routePath.githubApp());
            return { authenticated: true, navigated: true };
          }
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
      }
      // Navigate away from auth page after successful session restore.
      if (route.name === 'auth') {
        navigate(session.installationId ? routePath.githubApp() : routePath.documents());
        return { authenticated: true, navigated: true };
      }
      return { authenticated: true, navigated: false };
    } catch {
      setUser(null);
      return { authenticated: false, navigated: false };
    }
  }, [navigate, route.name]);

  // --- GitHub App redirect ---
  const tryHandleGitHubAppSetupRedirect = useCallback(async (): Promise<boolean> => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('installation_id');
    if (!id) return false;

    const actualState = params.get('state');
    if (!consumeInstallState(actualState)) {
      showError('GitHub App install state mismatch. Please try again.');
      return true;
    }

    try {
      const session = await getAuthSession();
      if (!session.authenticated) {
        setPendingInstallationId(id);
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        navigate(routePath.auth());
        return true;
      }
      await createSession(id);
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        setPendingInstallationId(id);
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        navigate(routePath.auth());
        return true;
      }
      showError(err instanceof Error ? err.message : 'Failed to create session');
      return true;
    }

    setInstallationId(id);
    setInstId(id);

    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    navigate(routePath.githubApp());
    return true;
  }, [navigate, showError]);

  // --- Helpers ---
  const loadRepoMarkdownFiles = useCallback(async (instId: string, repoName: string): Promise<RepoDocFile[]> => {
    const queue = [REPO_DOCS_DIR];
    const files: RepoDocFile[] = [];

    while (queue.length > 0) {
      const dirPath = queue.shift();
      if (!dirPath) break;
      const contents = await getRepoContents(instId, repoName, dirPath);
      if (!Array.isArray(contents)) continue;

      for (const item of contents) {
        if (item.type === 'dir') {
          queue.push(item.path);
          continue;
        }
        if (item.type !== 'file' || !item.name.toLowerCase().endsWith('.md')) continue;
        const relativePath = repoDocRelativePath(REPO_DOCS_DIR, item.path);
        if (!relativePath) continue;
        files.push({
          name: item.name,
          relativePath,
          path: item.path,
          sha: item.sha,
        });
      }
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return files;
  }, []);

  const fetchRepoSidebarFiles = useCallback(
    async (instId: string, repoName: string) => {
      if (repoFiles.length > 0) return;
      try {
        setRepoFiles(await loadRepoMarkdownFiles(instId, repoName));
      } catch {
        /* directory listing is optional for sidebar */
      }
    },
    [repoFiles.length, loadRepoMarkdownFiles],
  );

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
          renderDocumentContent(cacheFile.content ?? '', cacheFile.filename);
          setCurrentGistId(id);
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
          if (!res.ok) throw new Error(`Failed to fetch gist: ${res.status} ${res.statusText}`);
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
          renderDocumentContent(content ?? '', file.filename);
          setCurrentGistId(id);
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
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setRepoFiles([]);
        renderDocumentContent(file.content ?? '', file.filename);
        setViewPhase(null);
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Unknown error');
      }
    },
    [showError, currentGistId, gistFiles, renderDocumentContent, activeView, currentFileName],
  );

  const loadRepoFile = useCallback(
    async (path: string, forEdit: boolean) => {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name ?? null;
      if (!instId || !repoName) {
        navigate(routePath.githubApp());
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
        const relativePath = repoDocRelativePath(REPO_DOCS_DIR, contents.path) ?? contents.name;
        setCurrentRepoDocPath(contents.path);
        setCurrentRepoDocSha(contents.sha);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(relativePath);
        if (forEdit) {
          setEditingBackend('repo');
          setEditTitle(contents.name.replace(/\.md$/i, ''));
          setEditContent(decoded);
        } else {
          renderDocumentContent(decoded, contents.name);
        }
        await fetchRepoSidebarFiles(instId, repoName);
        setViewPhase(null);
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showError(err instanceof Error ? err.message : 'Failed to load file');
      }
    },
    [
      navigate,
      handleSessionExpired,
      showError,
      fetchRepoSidebarFiles,
      renderDocumentContent,
      activeView,
      currentFileName,
    ],
  );

  // --- Route handler ---
  const handleRoute = useCallback(
    async (r: Route, authenticatedOverride?: boolean) => {
      const isAuthenticated = authenticatedOverride ?? Boolean(user);
      switch (r.name) {
        case 'auth':
          setViewPhase(null);
          return;
        case 'githubapp':
          syncRepoState();
          setViewPhase(null);
          return;
        case 'repodocuments': {
          syncRepoState();
          const instId = getInstallationId();
          const repoName = getSelectedRepo()?.full_name ?? null;
          if (!instId || !repoName) {
            navigate(routePath.githubApp());
            return;
          }
          setViewPhase('loading');
          try {
            const mdFiles = await loadRepoMarkdownFiles(instId, repoName);
            if (mdFiles.length > 0) {
              setRepoFiles(mdFiles);
              const indexFile = mdFiles.find((f) => f.relativePath.toLowerCase() === 'index.md');
              const target = indexFile ?? mdFiles[0];
              navigate(routePath.repoFile(target.path));
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
              showError(msg || 'Failed to load repo documents');
              return;
            }
          }
          navigate(routePath.repoNew());
          return;
        }
        case 'repofile':
          syncRepoState();
          await loadRepoFile(safeDecodeURIComponent(r.params.path), false);
          return;
        case 'reponew': {
          syncRepoState();
          const instId = getInstallationId();
          const repoName = getSelectedRepo()?.full_name ?? null;
          if (!instId || !repoName) {
            navigate(routePath.githubApp());
            return;
          }
          setDraftMode(false);
          setEditingBackend('repo');
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setCurrentGistId(null);
          setCurrentFileName(null);
          setGistFiles(null);
          setRepoFiles([]);
          setPreviewVisible(true);
          setEditTitle(localStorage.getItem(repoNewDraftKey(instId, repoName, 'title')) || DEFAULT_NEW_FILENAME);
          setEditContent(localStorage.getItem(repoNewDraftKey(instId, repoName, 'content')) ?? '');
          setViewPhase(null);
          return;
        }
        case 'repoedit':
          setDraftMode(false);
          syncRepoState();
          await loadRepoFile(safeDecodeURIComponent(r.params.path), true);
          return;
        case 'documents':
          if (!isAuthenticated) {
            navigate(routePath.auth());
            return;
          }
          setGistFiles(null);
          setCurrentFileName(null);
          setRepoFiles([]);
          setViewPhase(null);
          return;
        case 'new':
          if (activeView === 'edit') {
            localStorage.removeItem(DRAFT_TITLE_KEY);
            localStorage.removeItem(DRAFT_CONTENT_KEY);
            setHasUnsavedChanges(false);
          }
          setDraftMode(true);
          setEditingBackend('gist');
          setCurrentGistId(null);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setCurrentFileName(null);
          setGistFiles(null);
          setRepoFiles([]);
          setPreviewVisible(true);
          setEditTitle(localStorage.getItem(DRAFT_TITLE_KEY) || DEFAULT_NEW_FILENAME);
          setEditContent(localStorage.getItem(DRAFT_CONTENT_KEY) ?? '');
          setViewPhase(null);
          if (activeView === 'edit') focusEditorSoon();
          return;
        case 'edit': {
          if (!isAuthenticated) {
            navigate(routePath.auth(), { replace: true });
            return;
          }
          setDraftMode(false);
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
          if (isAuthenticated) navigate(routePath.documents(), { replace: true });
          else navigate(routePath.freshDraft(), { replace: true });
          return;
        default:
          setDraftMode(false);
          setViewPhase(null);
      }
    },
    [
      navigate,
      syncRepoState,
      loadRepoFile,
      loadRepoMarkdownFiles,
      loadGist,
      showError,
      focusEditorSoon,
      activeView,
      user,
      currentGistId,
      gistFiles,
      handleSessionExpired,
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
    const media = window.matchMedia('(min-width: 1024px)');
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
    setCurrentGistId(null);
    navigate(routePath.home());
  }, [navigate]);

  const onEdit = useCallback(() => {
    if (currentRepoDocPath) navigate(routePath.repoEdit(currentRepoDocPath));
    else if (currentGistId && currentFileName) navigate(routePath.gistEdit(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistEdit(currentGistId));
  }, [currentRepoDocPath, currentGistId, currentFileName, navigate]);

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

        renderDocumentContent(content, currentRepoDocPath.split('/').pop() ?? null);
        navigate(routePath.repoFile(currentRepoDocPath));
      } else if (editingBackend === 'repo' && repoName && instId) {
        const filename = sanitizeTitleToFileName(title);
        const path = `${REPO_DOCS_DIR}/${filename}`;
        const contentB64 = encodeUtf8ToBase64(content);
        await putRepoFile(instId, repoName, path, `Create ${filename}`, contentB64);
        localStorage.removeItem(repoNewDraftKey(instId, repoName, 'title'));
        localStorage.removeItem(repoNewDraftKey(instId, repoName, 'content'));
        setCurrentRepoDocPath(path);
        setCurrentRepoDocSha(null);

        renderDocumentContent(content, filename);
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

        renderDocumentContent(content, filename);
        navigate(routePath.gistView(gist.id, filename));
      }
      showToast('Saved');
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
        return;
      }
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
    showToast,
    renderDocumentContent,
  ]);

  const onCancel = useCallback(() => {
    if (currentRepoDocPath) navigate(routePath.repoFile(currentRepoDocPath));
    else if (currentGistId && currentFileName) navigate(routePath.gistView(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistView(currentGistId));
    else if (selectedRepo) navigate(routePath.repoDocuments());
    else navigate(routePath.documents());
  }, [currentRepoDocPath, currentGistId, currentFileName, selectedRepo, navigate]);

  const getActiveDocumentStore = useCallback(() => {
    if (currentGistId) {
      return createGistDocumentStore(currentGistId);
    }

    if (selectedRepo) {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name;
      if (!instId || !repoName) return null;
      return createRepoDocumentStore(instId, repoName, REPO_DOCS_DIR);
    }

    return null;
  }, [currentGistId, selectedRepo]);

  // --- Sidebar actions ---
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      const doNavigate = () => {
        setHasUnsavedChanges(false);
        if (currentGistId) {
          navigate(routePath.gistView(currentGistId, filePath));
        } else if (selectedRepo) {
          navigate(routePath.repoFile(toRepoDocPath(REPO_DOCS_DIR, filePath)));
        }
      };

      if (activeView === 'edit' && hasUnsavedChanges) {
        const action = await showConfirm('You have unsaved changes. Discard and switch files?');
        if (action) doNavigate();
        return;
      }
      doNavigate();
    },
    [currentGistId, selectedRepo, activeView, hasUnsavedChanges, navigate, showConfirm],
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
          const path = toRepoDocPath(REPO_DOCS_DIR, filePath);
          setRepoFiles((prev) =>
            [...prev, { name: fileNameFromPath(filePath), relativePath: filePath, path, sha: result.content.sha }].sort(
              (a, b) => a.relativePath.localeCompare(b.relativePath),
            ),
          );
          setHasUnsavedChanges(false);
          navigate(routePath.repoEdit(path));
        }
      } catch (err) {
        void showAlert(err instanceof Error ? err.message : 'Failed to create file');
      }
    },
    [getActiveDocumentStore, currentGistId, navigate, showAlert],
  );

  const handleEditFile = useCallback(
    async (filePath: string) => {
      if (activeView === 'edit' && currentFileName === filePath) return;

      const target = currentGistId
        ? routePath.gistEdit(currentGistId, filePath)
        : selectedRepo
          ? routePath.repoEdit(toRepoDocPath(REPO_DOCS_DIR, filePath))
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
    [currentGistId, selectedRepo, activeView, currentFileName, hasUnsavedChanges, onSave, navigate, showConfirm],
  );

  const handleViewOnGitHub = useCallback(
    (filePath: string) => {
      if (currentGistId) {
        window.open(`https://gist.github.com/${currentGistId}`, '_blank', 'noopener,noreferrer');
        return;
      }
      if (!selectedRepo) return;
      const repoPath = toRepoDocPath(REPO_DOCS_DIR, filePath)
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      window.open(`https://github.com/${selectedRepo}/blob/HEAD/${repoPath}`, '_blank', 'noopener,noreferrer');
    },
    [currentGistId, selectedRepo],
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
              navigate(routePath.documents());
            }
          }
        } else {
          const repoFile = findRepoDocFile(repoFiles, filePath);
          if (!repoFile) return;
          await store.deleteFile(repoFile);
          const remaining = repoFiles.filter((f) => f.relativePath !== filePath);
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
          const repoPath = toRepoDocPath(REPO_DOCS_DIR, newPath);
          const updatedFiles = repoFiles
            .map((f) =>
              f.relativePath === oldPath
                ? {
                    name: fileNameFromPath(newPath),
                    relativePath: newPath,
                    path: created.content.path,
                    sha: created.content.sha,
                  }
                : f,
            )
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
          setRepoFiles(updatedFiles);
          if (currentFileName === oldPath) {
            navigate(routePath.repoFile(repoPath));
          }
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        void showAlert(err instanceof Error ? err.message : 'Failed to rename file');
      }
    },
    [getActiveDocumentStore, currentGistId, currentFileName, repoFiles, navigate, handleSessionExpired, showAlert],
  );

  // --- GitHub App callbacks ---
  const onSelectRepo = useCallback((fullName: string, id: number, isPrivate: boolean) => {
    setSelectedRepo(fullName);
    setSelectedRepoPrivate(isPrivate);
    storeSelectedRepo({ full_name: fullName, id, private: isPrivate });
  }, []);

  const onOpenRepoMenu = useCallback(() => {
    if (!user || !installationId || installationReposLoading) return;
    if (loadedReposInstallationId === installationId) return;

    setInstallationReposLoading(true);
    void (async () => {
      try {
        const repos = await listInstallationRepos(installationId);
        setInstallationRepos(repos.repositories);
        setLoadedReposInstallationId(installationId);
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        setInstallationRepos([]);
      } finally {
        setInstallationReposLoading(false);
      }
    })();
  }, [user, installationId, installationReposLoading, loadedReposInstallationId, handleSessionExpired]);

  const onDisconnect = useCallback(async () => {
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
      navigate(routePath.auth());
    }
  }, [navigate]);

  // --- Render active view ---
  const renderView = () => {
    switch (activeView) {
      case 'auth':
        return <AuthView isAuthenticated={Boolean(user)} />;
      case 'documents':
        return <DocumentsView navigate={navigate} userLogin={user?.login ?? null} />;
      case 'githubapp':
        return installationId ? (
          <GitHubAppView
            installationId={installationId}
            selectedRepo={selectedRepo}
            availableRepos={installationRepos}
            repoListLoading={installationReposLoading}
            onSelectRepo={onSelectRepo}
            onLoadRepos={onOpenRepoMenu}
            onDisconnect={onDisconnect}
            navigate={navigate}
          />
        ) : (
          <AuthView isAuthenticated={Boolean(user)} />
        );
      case 'content':
        return (
          <ContentView html={renderedHtml} markdown={renderMode === 'markdown'} onInternalLinkNavigate={navigate} />
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
      const currentPath = repoDocRelativePath(REPO_DOCS_DIR, currentRepoDocPath) ?? '';
      return repoFiles.map((f) => ({
        path: f.relativePath,
        active: f.relativePath === currentPath,
      }));
    }
    return [];
  }, [gistFiles, currentFileName, repoFiles, currentRepoDocPath]);

  const sidebarEligible = activeView === 'content' || activeView === 'edit';
  const defaultShowSidebar = sidebarEligible && !!user && sidebarFiles.length > 0;
  const showSidebar = sidebarEligible && (sidebarVisibilityOverride ?? defaultShowSidebar) && sidebarFiles.length > 0;
  const canToggleSidebar = sidebarEligible && sidebarFiles.length > 0 && currentFileName !== null;
  const editingFileName = currentFileName ?? editTitle;
  const editPreviewEnabled = isMarkdownFileName(editingFileName);
  const canRenderPreview = editPreviewEnabled && isDesktopWidth;
  const showLoggedOutNewDocPreviewDescription =
    route.name === 'new' && activeView === 'edit' && !user && editContent.trim().length === 0;
  const showEditorCancel = activeView === 'edit' && !draftMode;
  const showEditorSave = activeView === 'edit' && !(draftMode && !user);
  const editPreviewHtml = useMemo(
    () =>
      editPreviewEnabled
        ? parseMarkdownToHtml(
            showLoggedOutNewDocPreviewDescription ? LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION : editContent,
          )
        : '',
    [editPreviewEnabled, editContent, showLoggedOutNewDocPreviewDescription],
  );
  const onToggleSidebar = useCallback(() => {
    setSidebarVisibilityOverride((prev) => {
      const current = prev ?? defaultShowSidebar;
      return !current;
    });
  }, [defaultShowSidebar]);
  const onEditContentChange = useCallback((content: string) => {
    setEditContent(content);
    setHasUnsavedChanges(true);
  }, []);
  const showHeaderEdit = activeView === 'content' && (currentRepoDocPath !== null || currentGistId !== null);
  const inRepoContext =
    (activeView === 'content' || activeView === 'edit') &&
    (currentRepoDocPath !== null || (editingBackend === 'repo' && selectedRepo !== null));

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
        draftMode={draftMode}
        canToggleSidebar={canToggleSidebar}
        sidebarVisible={showSidebar}
        showEdit={showHeaderEdit}
        navigate={navigate}
        onOpenRepoMenu={onOpenRepoMenu}
        onSelectRepo={onSelectRepo}
        onSignOut={signOut}
        onToggleTheme={toggleTheme}
        onToggleSidebar={onToggleSidebar}
        onEdit={onEdit}
        showPreviewToggle={activeView === 'edit' && editPreviewEnabled}
        previewVisible={previewVisible}
        onTogglePreview={onTogglePreview}
        showCancel={showEditorCancel}
        onCancel={onCancel}
        showSave={showEditorSave}
        saving={saving}
        canSave={hasUnsavedChanges}
        onSave={onSave}
      />
      <div class={showSidebar ? 'app-body app-body--with-sidebar' : 'app-body app-body--no-sidebar'}>
        {showSidebar && (
          <>
            <div class="sidebar-backdrop" onClick={onToggleSidebar} />
            <Sidebar
              files={sidebarFiles}
              onSelectFile={handleSelectFile}
              onEditFile={handleEditFile}
              onViewOnGitHub={handleViewOnGitHub}
              canViewOnGitHub={currentGistId !== null || selectedRepo !== null}
              onCreateFile={handleCreateFile}
              onDeleteFile={handleDeleteFile}
              onRenameFile={handleRenameFile}
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
    </>
  );
}
