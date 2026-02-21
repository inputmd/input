import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { parseAnsiToHtml } from './ansi';
import { parseMarkdownToHtml } from './markdown';
import {
  isAuthenticated, clearToken, getUser,
  getGist, updateGist, createGist,
  type GitHubUser, type GistDetail, type GistFile,
} from './github';
import {
  getInstallationId, setInstallationId, clearInstallationId,
  getSelectedRepo, setSelectedRepo as storeSelectedRepo, clearSelectedRepo,
  clearSessionToken, createSession, SessionExpiredError,
  getRepoContents, putRepoFile, isRepoFile,
} from './github_app';
import { encodeUtf8ToBase64, decodeBase64ToUtf8 } from './util';
import { markGistRecentlyCreated } from './gist_consistency';
import { REPO_DOCS_DIR } from './constants';
import {
  createGistDocumentStore,
  createRepoDocumentStore,
  findRepoDocFile,
  toRepoDocPath,
  type RepoDocFile,
} from './document_store';
import { useRoute } from './hooks/useRoute';
import { routePath, type Route } from './routing';
import { Toolbar, type ActiveView } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthView } from './views/AuthView';
import { DocumentsView } from './views/DocumentsView';
import { GitHubAppView } from './views/GitHubAppView';
import { RepoDocumentsView } from './views/RepoDocumentsView';
import { ContentView } from './views/ContentView';
import { EditView } from './views/EditView';
import { LoadingView } from './views/LoadingView';
import { ErrorView } from './views/ErrorView';
import { useDialogs } from './components/DialogProvider';
import { useToast } from './components/ToastProvider';

const DRAFT_TITLE_KEY = 'draft_title';
const DRAFT_CONTENT_KEY = 'draft_content';
const DEFAULT_NEW_FILENAME = 'index.md';

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
  const trimmed = title.trim().replace(/[/\\]/g, '').replace(/\.{2,}/g, '.');
  if (!trimmed) return DEFAULT_NEW_FILENAME;
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
}

export function App() {
  const { route, navigate } = useRoute();
  const { showAlert, showConfirm } = useDialogs();
  const { showToast } = useToast();

  // --- Shared state ---
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [installationId, setInstId] = useState<string | null>(getInstallationId());
  const [selectedRepo, setSelectedRepo] = useState<string | null>(getSelectedRepo()?.full_name ?? null);

  // --- View state ---
  const [activeView, setActiveView] = useState<ActiveView>('loading');
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

  // Track initialization
  const initialized = useRef(false);
  // Cache refs: synced on render, eagerly updated before navigate() to avoid redundant API calls
  const userRef = useRef<GitHubUser | null>(null);
  userRef.current = user;
  const gistFilesRef = useRef<Record<string, GistFile> | null>(null);
  gistFilesRef.current = gistFiles;
  const currentGistIdRef = useRef<string | null>(null);
  currentGistIdRef.current = currentGistId;
  const repoFilesRef = useRef<RepoDocFile[]>([]);
  repoFilesRef.current = repoFiles;
  const activeViewRef = useRef<ActiveView>('loading');
  activeViewRef.current = activeView;

  // --- Helpers ---
  const syncRepoState = useCallback(() => {
    setInstId(getInstallationId());
    setSelectedRepo(getSelectedRepo()?.full_name ?? null);
  }, []);

  const handleSessionExpired = useCallback(() => {
    clearInstallationId();
    clearSelectedRepo();
    clearSessionToken();
    setInstId(null);
    setSelectedRepo(null);
    navigate(routePath.auth());
  }, [navigate]);

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg);
    setActiveView('error');
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
  const tryRestoreAuth = useCallback(async () => {
    if (!isAuthenticated()) return;
    try {
      const u = await getUser();
      userRef.current = u;
      setUser(u);
    } catch {
      clearToken();
      userRef.current = null;
      setUser(null);
    }
  }, []);

  // --- GitHub App redirect ---
  const tryHandleGitHubAppSetupRedirect = useCallback(async (): Promise<boolean> => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('installation_id');
    if (!id) return false;

    const expectedState = sessionStorage.getItem('github_app_install_state');
    const actualState = params.get('state');
    sessionStorage.removeItem('github_app_install_state');

    if (!expectedState || !actualState || expectedState !== actualState) {
      showError('GitHub App install state mismatch. Please try again.');
      return true;
    }

    try {
      await createSession(id);
    } catch (err) {
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
  const fetchRepoSidebarFiles = useCallback(async (instId: string, repoName: string) => {
    if (repoFilesRef.current.length > 0) return;
    try {
      const dirContents = await getRepoContents(instId, repoName, REPO_DOCS_DIR);
      if (Array.isArray(dirContents)) {
        const mdFiles = dirContents
          .filter((c: { type: string; name: string }) => c.type === 'file' && c.name.toLowerCase().endsWith('.md'))
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
        setRepoFiles(mdFiles);
      }
    } catch { /* directory listing is optional for sidebar */ }
  }, []);

  // --- Data loaders ---
  const loadGistAnonymous = useCallback(async (id: string, filename?: string) => {
    // Serve from cache if available (skip for truncated files with null content)
    const cached = currentGistIdRef.current === id ? gistFilesRef.current : null;
    if (cached) {
      const cacheKeys = Object.keys(cached);
      const cacheName = filename ? safeDecodeURIComponent(filename) : cacheKeys[0];
      const cacheFile = cacheName ? cached[cacheName] : null;
      if (cacheFile && cacheFile.content != null) {
        setCurrentFileName(cacheFile.filename);
        renderDocumentContent(cacheFile.content, cacheFile.filename);
        setCurrentGistId(id);
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setRepoFiles([]);
        setActiveView('content');
        return;
      }
    }

    setActiveView('loading');
    try {
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
      if (!file) { showError('File not found in gist'); return; }

      let content = file.content;
      if (content == null && file.raw_url && new URL(file.raw_url).hostname === 'gist.githubusercontent.com') {
        const raw = await fetch(file.raw_url, { redirect: 'error' });
        if (raw.ok) content = await raw.text();
        // Store fetched content in cache for subsequent file switches
        if (content != null) {
          const updated = { ...files, [file.filename]: { ...file, content } };
          gistFilesRef.current = updated;
          setGistFiles(updated);
        }
      }

      setCurrentFileName(file.filename);
      renderDocumentContent(content ?? '', file.filename);
      setCurrentGistId(id);
      setCurrentRepoDocPath(null);
      setCurrentRepoDocSha(null);
      setRepoFiles([]);
      setActiveView('content');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [showError]);

  const loadGistAuthenticated = useCallback(async (id: string, filename?: string) => {
    // Serve from cache if we already have this gist's files
    const cached = currentGistIdRef.current === id ? gistFilesRef.current : null;
    if (cached) {
      const cacheKeys = Object.keys(cached);
      const cacheName = filename ? safeDecodeURIComponent(filename) : cacheKeys[0];
      const cacheFile = cacheName ? cached[cacheName] : null;
      if (cacheFile) {
        setCurrentFileName(cacheFile.filename);
        setCurrentGistId(id);
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setRepoFiles([]);
        renderDocumentContent(cacheFile.content ?? '', cacheFile.filename);
        setActiveView('content');
        return;
      }
    }

    setActiveView('loading');
    try {
      const gist = await getGist(id);
      setGistFiles(gist.files);

      const fileKeys = Object.keys(gist.files);
      const targetName = filename ? safeDecodeURIComponent(filename) : fileKeys[0];
      const file = targetName ? gist.files[targetName] : null;
      if (!file) { showError('File not found in gist'); return; }

      setCurrentFileName(file.filename);
      setCurrentGistId(gist.id);
      setCurrentRepoDocPath(null);
      setCurrentRepoDocSha(null);
      setRepoFiles([]);
      renderDocumentContent(file.content ?? '', file.filename);
      setActiveView('content');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [showError]);

  const loadRepoFile = useCallback(async (path: string) => {
    const instId = getInstallationId();
    const repoName = getSelectedRepo()?.full_name ?? null;
    if (!instId || !repoName) { navigate(routePath.githubApp()); return; }
    setActiveView('loading');
    try {
      const contents = await getRepoContents(instId, repoName, path);
      if (!isRepoFile(contents)) throw new Error('Expected a file');
      const decoded = contents.content ? decodeBase64ToUtf8(contents.content) : '';
      setCurrentRepoDocPath(contents.path);
      setCurrentRepoDocSha(contents.sha);
      setCurrentGistId(null);
      setGistFiles(null);
      setCurrentFileName(contents.name);
      renderDocumentContent(decoded, contents.name);
      await fetchRepoSidebarFiles(instId, repoName);
      setActiveView('content');
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      showError(err instanceof Error ? err.message : 'Failed to load file');
    }
  }, [navigate, handleSessionExpired, showError, fetchRepoSidebarFiles]);

  const loadRepoFileForEdit = useCallback(async (path: string) => {
    const instId = getInstallationId();
    const repoName = getSelectedRepo()?.full_name ?? null;
    if (!instId || !repoName) { navigate(routePath.githubApp()); return; }
    setActiveView('loading');
    try {
      const contents = await getRepoContents(instId, repoName, path);
      if (!isRepoFile(contents)) throw new Error('Expected a file');
      const decoded = contents.content ? decodeBase64ToUtf8(contents.content) : '';
      setEditingBackend('repo');
      setCurrentRepoDocPath(contents.path);
      setCurrentRepoDocSha(contents.sha);
      setCurrentGistId(null);
      setGistFiles(null);
      setCurrentFileName(contents.name);
      setEditTitle(contents.name.replace(/\.md$/i, ''));
      setEditContent(decoded);
      await fetchRepoSidebarFiles(instId, repoName);
      setActiveView('edit');
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      showError(err instanceof Error ? err.message : 'Failed to load file');
    }
  }, [navigate, handleSessionExpired, showError, fetchRepoSidebarFiles]);

  // --- Route handler ---
  const handleRoute = useCallback(async (r: Route) => {
    switch (r.name) {
      case 'auth':
        setActiveView('auth');
        return;
      case 'githubapp':
        syncRepoState();
        setActiveView('githubapp');
        return;
      case 'repodocuments': {
        syncRepoState();
        const instId = getInstallationId();
        const repoName = getSelectedRepo()?.full_name ?? null;
        if (!instId || !repoName) { navigate(routePath.githubApp()); return; }
        setActiveView('repodocuments');
        return;
      }
      case 'repofile':
        syncRepoState();
        await loadRepoFile(safeDecodeURIComponent(r.params.path));
        return;
      case 'reponew': {
        syncRepoState();
        const instId = getInstallationId();
        const repoName = getSelectedRepo()?.full_name ?? null;
        if (!instId || !repoName) { navigate(routePath.githubApp()); return; }
        setDraftMode(false);
        setEditingBackend('repo');
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setCurrentGistId(null);
        setCurrentFileName(null);
        setGistFiles(null);
        setRepoFiles([]);
        setEditTitle(DEFAULT_NEW_FILENAME);
        setEditContent('');
        setActiveView('edit');
        return;
      }
      case 'repoedit':
        setDraftMode(false);
        syncRepoState();
        await loadRepoFileForEdit(safeDecodeURIComponent(r.params.path));
        return;
      case 'documents':
        if (!userRef.current) { navigate(routePath.auth()); return; }
        setGistFiles(null);
        setCurrentFileName(null);
        setRepoFiles([]);
        setActiveView('documents');
        return;
      case 'new':
        if (activeViewRef.current === 'edit') {
          localStorage.removeItem(DRAFT_TITLE_KEY);
          localStorage.removeItem(DRAFT_CONTENT_KEY);
          setHasUnsavedChanges(false);
        }
        navigate(routePath.home(), { replace: true });
        if (activeViewRef.current === 'edit') {
          focusEditorSoon();
        }
        return;
      case 'edit': {
        if (!userRef.current) { navigate(routePath.auth(), { replace: true }); return; }
        setDraftMode(false);
        // Serve from cache if we already have this gist's files
        const cachedFiles = currentGistIdRef.current === r.params.id ? gistFilesRef.current : null;
        if (cachedFiles) {
          const cacheKeys = Object.keys(cachedFiles);
          const cacheName = r.params.filename
            ? safeDecodeURIComponent(r.params.filename)
            : cacheKeys[0];
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
            setActiveView('edit');
            return;
          }
        }
        setActiveView('loading');
        try {
          const gist = await getGist(r.params.id);
          setGistFiles(gist.files);

          const fileKeys = Object.keys(gist.files);
          const targetName = r.params.filename
            ? safeDecodeURIComponent(r.params.filename)
            : fileKeys[0];
          const file = targetName ? gist.files[targetName] : null;
          if (!file) { showError('File not found in gist'); return; }

          setEditingBackend('gist');
          setCurrentGistId(gist.id);
          setCurrentFileName(file.filename);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setRepoFiles([]);
          setEditTitle(file.filename.replace(/\.md$/i, ''));
          setEditContent(file.content ?? '');
          setActiveView('edit');
        } catch (err) {
          showError(err instanceof Error ? err.message : 'Failed to load gist');
        }
        return;
      }
      case 'gist': {
        const id = r.params.id;
        const filename = r.params.filename;
        if (userRef.current) await loadGistAuthenticated(id, filename);
        else await loadGistAnonymous(id, filename);
        return;
      }
      case 'home':
        if (window.location.pathname !== '/') {
          window.history.replaceState(null, '', '/');
        }
        setDraftMode(true);
        setEditingBackend('gist');
        setCurrentGistId(null);
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setCurrentFileName(null);
        setGistFiles(null);
        setRepoFiles([]);
        setEditTitle(localStorage.getItem(DRAFT_TITLE_KEY) || DEFAULT_NEW_FILENAME);
        setEditContent(localStorage.getItem(DRAFT_CONTENT_KEY) ?? '');
        setActiveView('edit');
        return;
      default:
        setDraftMode(false);
        setActiveView('edit');
    }
  }, [navigate, syncRepoState, loadRepoFile, loadRepoFileForEdit, loadGistAuthenticated, loadGistAnonymous, showError, focusEditorSoon]);

  // --- Init ---
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    (async () => {
      const handledSetup = await tryHandleGitHubAppSetupRedirect();
      await tryRestoreAuth();
      if (!handledSetup) {
        await handleRoute(route);
      }
      document.getElementById('app')!.classList.add('ready');
    })();
  }, []);

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

  // --- Theme toggle ---
  const toggleTheme = useCallback(() => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch {}
  }, []);

  // --- Sign out ---
  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
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
        await putRepoFile(instId, repoName, currentRepoDocPath, `Update ${currentRepoDocPath}`, contentB64, currentRepoDocSha ?? undefined);
  
        renderDocumentContent(content, currentRepoDocPath.split('/').pop() ?? null);
        navigate(routePath.repoFile(currentRepoDocPath));
      } else if (editingBackend === 'repo' && repoName && instId) {
        const filename = sanitizeTitleToFileName(title);
        const path = `${REPO_DOCS_DIR}/${filename}`;
        const contentB64 = encodeUtf8ToBase64(content);
        await putRepoFile(instId, repoName, path, `Create ${filename}`, contentB64);
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
        currentGistIdRef.current = gist.id;
        setCurrentFileName(filename);
        setGistFiles(gist.files);
        gistFilesRef.current = gist.files;
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
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      void showAlert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
      setHasUnsavedChanges(false);
    }
  }, [editTitle, editContent, editingBackend, currentRepoDocPath, currentRepoDocSha, currentGistId, currentFileName, draftMode, navigate, handleSessionExpired, user, showAlert, showToast]);

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
  const handleSelectFile = useCallback(async (filename: string) => {
    const doNavigate = () => {
      setHasUnsavedChanges(false);
      if (currentGistId) {
        navigate(routePath.gistView(currentGistId, filename));
      } else if (selectedRepo) {
        navigate(routePath.repoFile(toRepoDocPath(REPO_DOCS_DIR, filename)));
      }
    };

    if (activeView === 'edit' && hasUnsavedChanges) {
      const action = await showConfirm('You have unsaved changes. Discard and switch files?');
      if (action) doNavigate();
      return;
    }
    doNavigate();
  }, [currentGistId, selectedRepo, activeView, hasUnsavedChanges, navigate, showConfirm]);

  const handleCreateFile = useCallback(async (filename: string) => {
    try {
      const store = getActiveDocumentStore();
      if (!store) return;

      if (store.kind === 'gist') {
        if (!currentGistId) return;
        const gist = await store.createFile(filename);
        setGistFiles(gist.files);
        gistFilesRef.current = gist.files;
        setHasUnsavedChanges(false);
        navigate(routePath.gistEdit(currentGistId, filename));
      } else {
        const result = await store.createFile(filename);
        const path = toRepoDocPath(REPO_DOCS_DIR, filename);
        const updated = [...repoFilesRef.current, { name: filename, path, sha: result.content.sha }]
          .sort((a, b) => a.name.localeCompare(b.name));
        setRepoFiles(updated);
        repoFilesRef.current = updated;
        setHasUnsavedChanges(false);
        navigate(routePath.repoEdit(path));
      }
    } catch (err) {
      void showAlert(err instanceof Error ? err.message : 'Failed to create file');
    }
  }, [getActiveDocumentStore, currentGistId, navigate, showAlert]);

  const handleEditFile = useCallback(async (filename: string) => {
    if (activeView === 'edit' && currentFileName === filename) return;

    const target = currentGistId
      ? routePath.gistEdit(currentGistId, filename)
      : selectedRepo
        ? routePath.repoEdit(toRepoDocPath(REPO_DOCS_DIR, filename))
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
  }, [currentGistId, selectedRepo, activeView, currentFileName, hasUnsavedChanges, onSave, navigate, showConfirm]);

  const handleViewOnGitHub = useCallback(() => {
    if (!currentGistId) return;
    window.open(`https://gist.github.com/${currentGistId}`, '_blank', 'noopener,noreferrer');
  }, [currentGistId]);

  const handleDeleteFile = useCallback(async (filename: string) => {
    if (!await showConfirm(`Delete "${filename}"?`)) return;
    try {
      const store = getActiveDocumentStore();
      if (!store) return;

      if (store.kind === 'gist') {
        if (!currentGistId) return;
        const gist = await store.deleteFile({ name: filename });
        setGistFiles(gist.files);
        gistFilesRef.current = gist.files;
        const deletedCurrent = currentFileName === filename;
        if (deletedCurrent) {
          const remaining = Object.keys(gist.files);
          if (remaining.length > 0) {
            navigate(routePath.gistView(currentGistId, remaining[0]));
          } else {
            navigate(routePath.documents());
          }
        }
      } else {
        const repoFile = findRepoDocFile(repoFiles, filename);
        if (!repoFile) return;
        await store.deleteFile(repoFile);
        const remaining = repoFiles.filter(f => f.name !== filename);
        setRepoFiles(remaining);
        repoFilesRef.current = remaining;
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
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      void showAlert(err instanceof Error ? err.message : 'Failed to delete file');
    }
  }, [getActiveDocumentStore, currentFileName, repoFiles, currentRepoDocPath, navigate, handleSessionExpired, showConfirm, showAlert]);

  const handleRenameFile = useCallback(async (oldName: string, newName: string) => {
    try {
      const store = getActiveDocumentStore();
      if (!store) return;

      if (store.kind === 'gist') {
        if (!currentGistId) return;
        const gist = await store.renameFile({ name: oldName }, newName);
        setGistFiles(gist.files);
        gistFilesRef.current = gist.files;
        if (currentFileName === oldName) {
          setCurrentFileName(newName);
          navigate(routePath.gistView(currentGistId, newName));
        }
      } else {
        const oldFile = findRepoDocFile(repoFiles, oldName);
        if (!oldFile) return;
        const created = await store.renameFile(oldFile, newName);
        const newPath = toRepoDocPath(REPO_DOCS_DIR, newName);
        const updatedFiles = repoFiles.map(f =>
          f.name === oldName ? { name: newName, path: created.content.path, sha: created.content.sha } : f
        ).sort((a, b) => a.name.localeCompare(b.name));
        setRepoFiles(updatedFiles);
        repoFilesRef.current = updatedFiles;
        if (currentFileName === oldName) {
          navigate(routePath.repoFile(newPath));
        }
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      void showAlert(err instanceof Error ? err.message : 'Failed to rename file');
    }
  }, [getActiveDocumentStore, currentGistId, currentFileName, repoFiles, navigate, handleSessionExpired, showAlert]);

  // --- GitHub App callbacks ---
  const onSelectRepo = useCallback((fullName: string, id: number) => {
    setSelectedRepo(fullName);
    storeSelectedRepo({ full_name: fullName, id });
  }, []);

  const onDisconnect = useCallback(() => {
    setInstId(null);
    setSelectedRepo(null);
    navigate(routePath.auth());
  }, [navigate]);

  // --- Render active view ---
  const renderView = () => {
    switch (activeView) {
      case 'auth':
        return <AuthView onUserChange={setUser} navigate={navigate} />;
      case 'documents':
        return <DocumentsView navigate={navigate} userLogin={user?.login ?? null} />;
      case 'githubapp':
        return installationId ? (
          <GitHubAppView
            installationId={installationId}
            selectedRepo={selectedRepo}
            onSelectRepo={onSelectRepo}
            onDisconnect={onDisconnect}
            navigate={navigate}
          />
        ) : (
          <AuthView onUserChange={setUser} navigate={navigate} />
        );
      case 'repodocuments':
        return installationId && selectedRepo ? (
          <RepoDocumentsView
            installationId={installationId}
            selectedRepo={selectedRepo}
            navigate={navigate}
            onSessionExpired={handleSessionExpired}
          />
        ) : null;
      case 'content':
        return (
          <ContentView
            html={renderedHtml}
            markdown={renderMode === 'markdown'}
            onInternalLinkNavigate={navigate}
          />
        );
      case 'edit':
        return (
          <EditView
            content={editContent}
            previewHtml={editPreviewHtml}
            previewEnabled={editPreviewEnabled}
            onContentChange={onEditContentChange}
            showCancel={!(activeView === 'edit' && draftMode)}
            showSave={!(activeView === 'edit' && draftMode && !user)}
            saving={saving}
            canSave={hasUnsavedChanges}
            onSave={onSave}
            onCancel={onCancel}
          />
        );
      case 'loading':
        return <LoadingView />;
      case 'error':
        return <ErrorView message={errorMessage} onRetry={() => { void handleRoute(route); }} />;
      default:
        return null;
    }
  };

  const sidebarFiles = useMemo(() => {
    if (gistFiles) {
      return Object.keys(gistFiles).map(name => ({
        name,
        active: name === currentFileName,
      }));
    }
    if (repoFiles.length > 0 && currentRepoDocPath) {
      const currentName = currentRepoDocPath.split('/').pop() ?? '';
      return repoFiles.map(f => ({
        name: f.name,
        active: f.name === currentName,
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
  const editPreviewHtml = useMemo(
    () => (editPreviewEnabled ? parseMarkdownToHtml(editContent) : ''),
    [editPreviewEnabled, editContent],
  );
  const onToggleSidebar = useCallback(() => {
    setSidebarVisibilityOverride(prev => {
      const current = prev ?? defaultShowSidebar;
      return !current;
    });
  }, [defaultShowSidebar]);
  const onEditContentChange = useCallback((content: string) => {
    setEditContent(content);
    setHasUnsavedChanges(true);
  }, []);
  const showHeaderEdit = activeView === 'content' && (currentRepoDocPath !== null || currentGistId !== null);

  return (
    <>
      <Toolbar
        view={activeView}
        user={user}
        installationId={installationId}
        selectedRepo={selectedRepo}
        draftMode={draftMode}
        canToggleSidebar={canToggleSidebar}
        sidebarVisible={showSidebar}
        showEdit={showHeaderEdit}
        navigate={navigate}
        onSignOut={signOut}
        onToggleTheme={toggleTheme}
        onToggleSidebar={onToggleSidebar}
        onEdit={onEdit}
      />
      <div class={showSidebar ? 'app-body' : 'app-body app-body--no-sidebar'}>
        {showSidebar && (
          <Sidebar
            files={sidebarFiles}
            onSelectFile={handleSelectFile}
            onEditFile={handleEditFile}
            onViewOnGitHub={handleViewOnGitHub}
            canViewOnGitHub={currentGistId !== null}
            onCreateFile={handleCreateFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
          />
        )}
        <ErrorBoundary
          fallbackMessage="This screen crashed while rendering."
          resetKey={`${route.name}:${JSON.stringify(route.params)}`}
          onReset={() => { void handleRoute(route); }}
        >
          <main>{renderView()}</main>
        </ErrorBoundary>
      </div>
    </>
  );
}
