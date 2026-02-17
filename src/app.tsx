import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { parseAnsiToHtml } from './ansi';
import {
  isAuthenticated, clearToken, getUser,
  getGist, updateGist, createGist, deleteGist,
  addFileToGist, deleteFileFromGist, renameFileInGist,
  type GitHubUser, type GistDetail, type GistFile,
} from './github';
import {
  getInstallationId, setInstallationId, clearInstallationId,
  getSelectedRepo, setSelectedRepo as storeSelectedRepo, clearSelectedRepo,
  clearSessionToken, createSession, SessionExpiredError,
  getRepoContents, putRepoFile, deleteRepoFile, isRepoFile,
} from './github_app';
import { encodeUtf8ToBase64, decodeBase64ToUtf8 } from './util';
import { REPO_DOCS_DIR } from './constants';
import { useRoute, type Route } from './hooks/useRoute';
import { Toolbar, type ActiveView } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { AuthView } from './views/AuthView';
import { DocumentsView } from './views/DocumentsView';
import { GitHubAppView } from './views/GitHubAppView';
import { RepoDocumentsView } from './views/RepoDocumentsView';
import { ContentView } from './views/ContentView';
import { EditView } from './views/EditView';
import { LoadingView } from './views/LoadingView';
import { ErrorView } from './views/ErrorView';

const DRAFT_TITLE_KEY = 'draft_title';
const DRAFT_CONTENT_KEY = 'draft_content';

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function sanitizeTitleToFileName(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return (base || 'untitled') + '.md';
}

export function App() {
  const { route, navigate } = useRoute();

  // --- Shared state ---
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [installationId, setInstId] = useState<string | null>(getInstallationId());
  const [selectedRepo, setSelectedRepo] = useState<string | null>(getSelectedRepo()?.full_name ?? null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // --- View state ---
  const [activeView, setActiveView] = useState<ActiveView>('loading');
  const [renderedHtml, setRenderedHtml] = useState('');
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
  const [repoFiles, setRepoFiles] = useState<Array<{ name: string; path: string; sha: string }>>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Track initialization
  const initialized = useRef(false);
  // Cache refs: synced on render, eagerly updated before navigate() to avoid redundant API calls
  const userRef = useRef<GitHubUser | null>(null);
  userRef.current = user;
  const gistFilesRef = useRef<Record<string, GistFile> | null>(null);
  gistFilesRef.current = gistFiles;
  const currentGistIdRef = useRef<string | null>(null);
  currentGistIdRef.current = currentGistId;
  const repoFilesRef = useRef<Array<{ name: string; path: string; sha: string }>>([]);
  repoFilesRef.current = repoFiles;

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
    navigate('auth');
  }, [navigate]);

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg);
    setActiveView('error');
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

    navigate('githubapp');
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
        setRenderedHtml(parseAnsiToHtml(cacheFile.content));
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
      setRenderedHtml(parseAnsiToHtml(content ?? ''));
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
        setRenderedHtml(parseAnsiToHtml(cacheFile.content ?? ''));
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
      setRenderedHtml(parseAnsiToHtml(file.content ?? ''));
      setActiveView('content');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [showError]);

  const loadRepoFile = useCallback(async (path: string) => {
    const instId = getInstallationId();
    const repoName = getSelectedRepo()?.full_name ?? null;
    if (!instId || !repoName) { navigate('githubapp'); return; }
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
      setRenderedHtml(parseAnsiToHtml(decoded));
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
    if (!instId || !repoName) { navigate('githubapp'); return; }
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
        if (!instId || !repoName) { navigate('githubapp'); return; }
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
        if (!instId || !repoName) { navigate('githubapp'); return; }
        setDraftMode(false);
        setEditingBackend('repo');
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setCurrentGistId(null);
        setCurrentFileName(null);
        setGistFiles(null);
        setRepoFiles([]);
        setEditTitle('');
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
        if (!userRef.current) { navigate('auth'); return; }
        setGistFiles(null);
        setCurrentFileName(null);
        setRepoFiles([]);
        setActiveView('documents');
        return;
      case 'new':
        navigate('');
        return;
      case 'edit': {
        if (!userRef.current) { navigate('auth'); return; }
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
        setEditTitle(localStorage.getItem(DRAFT_TITLE_KEY) ?? '');
        setEditContent(localStorage.getItem(DRAFT_CONTENT_KEY) ?? '');
        setActiveView('edit');
        return;
      default:
        setDraftMode(false);
        setActiveView('edit');
    }
  }, [navigate, syncRepoState, loadRepoFile, loadRepoFileForEdit, loadGistAuthenticated, loadGistAnonymous, showError]);

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
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      return next;
    });
  }, []);

  // --- Sign out ---
  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
    setCurrentGistId(null);
    navigate('');
  }, [navigate]);

  // --- Edit actions ---
  const onEdit = useCallback(() => {
    if (currentRepoDocPath) navigate(`repoedit/${encodeURIComponent(currentRepoDocPath)}`);
    else if (currentGistId && currentFileName) navigate(`edit/${currentGistId}/${encodeURIComponent(currentFileName)}`);
    else if (currentGistId) navigate(`edit/${currentGistId}`);
  }, [currentRepoDocPath, currentGistId, currentFileName, navigate]);

  const onSave = useCallback(async () => {
    const title = editTitle.trim() || 'Untitled';
    const content = editContent;
    setSaving(true);

    try {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name ?? null;

      if (editingBackend === 'repo' && currentRepoDocPath && instId && repoName) {
        const contentB64 = encodeUtf8ToBase64(content);
        await putRepoFile(instId, repoName, currentRepoDocPath, `Update ${currentRepoDocPath}`, contentB64, currentRepoDocSha ?? undefined);
  
        setRenderedHtml(parseAnsiToHtml(content));
        navigate(`repofile/${encodeURIComponent(currentRepoDocPath)}`);
      } else if (editingBackend === 'repo' && repoName && instId) {
        const filename = sanitizeTitleToFileName(title);
        const path = `${REPO_DOCS_DIR}/${filename}`;
        const contentB64 = encodeUtf8ToBase64(content);
        await putRepoFile(instId, repoName, path, `Create ${filename}`, contentB64);
        setCurrentRepoDocPath(path);
        setCurrentRepoDocSha(null);
  
        setRenderedHtml(parseAnsiToHtml(content));
        navigate(`repofile/${encodeURIComponent(path)}`);
      } else {
        let gist: GistDetail;
        const filename = currentFileName ?? sanitizeTitleToFileName(title);
        if (currentGistId) {
          gist = await updateGist(currentGistId, content, filename);
        } else {
          gist = await createGist(content, filename, title);
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

        setRenderedHtml(parseAnsiToHtml(content));
        navigate(`gist/${gist.id}/${encodeURIComponent(filename)}`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      alert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
      setHasUnsavedChanges(false);
    }
  }, [editTitle, editContent, editingBackend, currentRepoDocPath, currentRepoDocSha, currentGistId, currentFileName, draftMode, navigate, handleSessionExpired]);

  const onCancel = useCallback(() => {
    if (currentRepoDocPath) navigate(`repofile/${encodeURIComponent(currentRepoDocPath)}`);
    else if (currentGistId && currentFileName) navigate(`gist/${currentGistId}/${encodeURIComponent(currentFileName)}`);
    else if (currentGistId) navigate(`gist/${currentGistId}`);
    else if (selectedRepo) navigate('repodocuments');
    else navigate('documents');
  }, [currentRepoDocPath, currentGistId, currentFileName, selectedRepo, navigate]);

  const onDelete = useCallback(async () => {
    if (!currentGistId) return;
    if (!confirm('Delete this document?')) return;
    try {
      await deleteGist(currentGistId);
      setCurrentGistId(null);
      navigate('documents');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  }, [currentGistId, navigate]);

  // --- Sidebar actions ---
  const handleSelectFile = useCallback((filename: string) => {
    const doNavigate = () => {
      setHasUnsavedChanges(false);
      if (currentGistId) {
        navigate(`gist/${currentGistId}/${encodeURIComponent(filename)}`);
      } else if (selectedRepo) {
        navigate(`repofile/${encodeURIComponent(REPO_DOCS_DIR + '/' + filename)}`);
      }
    };

    if (activeView === 'edit' && hasUnsavedChanges) {
      const action = confirm('You have unsaved changes. Discard and switch files?');
      if (action) doNavigate();
      return;
    }
    doNavigate();
  }, [currentGistId, selectedRepo, activeView, hasUnsavedChanges, currentFileName, navigate]);

  const handleCreateFile = useCallback(async (filename: string) => {
    try {
      if (currentGistId) {
        const gist = await addFileToGist(currentGistId, filename, '');
        setGistFiles(gist.files);
        gistFilesRef.current = gist.files;
        setHasUnsavedChanges(false);
        navigate(`edit/${currentGistId}/${encodeURIComponent(filename)}`);
      } else if (selectedRepo) {
        const instId = getInstallationId();
        const repoName = getSelectedRepo()?.full_name;
        if (!instId || !repoName) return;
        const path = `${REPO_DOCS_DIR}/${filename}`;
        const result = await putRepoFile(instId, repoName, path, `Create ${filename}`, encodeUtf8ToBase64(''));
        const updated = [...repoFilesRef.current, { name: filename, path, sha: result.content.sha }]
          .sort((a, b) => a.name.localeCompare(b.name));
        setRepoFiles(updated);
        repoFilesRef.current = updated;
        setHasUnsavedChanges(false);
        navigate(`repoedit/${encodeURIComponent(path)}`);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create file');
    }
  }, [currentGistId, selectedRepo, navigate]);

  const handleDeleteFile = useCallback(async (filename: string) => {
    if (!confirm(`Delete "${filename}"?`)) return;
    try {
      if (currentGistId) {
        const gist = await deleteFileFromGist(currentGistId, filename);
        setGistFiles(gist.files);
        gistFilesRef.current = gist.files;
        const remaining = Object.keys(gist.files);
        if (remaining.length > 0) {
          navigate(`gist/${currentGistId}/${encodeURIComponent(remaining[0])}`);
        } else {
          navigate('documents');
        }
      } else if (selectedRepo) {
        const instId = getInstallationId();
        const repoName = getSelectedRepo()?.full_name;
        if (!instId || !repoName) return;
        const repoFile = repoFiles.find(f => f.name === filename);
        if (!repoFile) return;
        await deleteRepoFile(instId, repoName, repoFile.path, `Delete ${filename}`, repoFile.sha);
        const remaining = repoFiles.filter(f => f.name !== filename);
        setRepoFiles(remaining);
        repoFilesRef.current = remaining;
        if (remaining.length > 0) {
          navigate(`repofile/${encodeURIComponent(remaining[0].path)}`);
        } else {
          navigate('repodocuments');
        }
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      alert(err instanceof Error ? err.message : 'Failed to delete file');
    }
  }, [currentGistId, selectedRepo, repoFiles, navigate, handleSessionExpired]);

  const handleRenameFile = useCallback(async (oldName: string, newName: string) => {
    try {
      if (currentGistId) {
        const gist = await renameFileInGist(currentGistId, oldName, newName);
        setGistFiles(gist.files);
        gistFilesRef.current = gist.files;
        if (currentFileName === oldName) {
          setCurrentFileName(newName);
          navigate(`gist/${currentGistId}/${encodeURIComponent(newName)}`);
        }
      } else if (selectedRepo) {
        const instId = getInstallationId();
        const repoName = getSelectedRepo()?.full_name;
        if (!instId || !repoName) return;
        const oldFile = repoFiles.find(f => f.name === oldName);
        if (!oldFile) return;
        // Repo rename: read content, create new, delete old
        const contents = await getRepoContents(instId, repoName, oldFile.path);
        if (!isRepoFile(contents)) return;
        const newPath = `${REPO_DOCS_DIR}/${newName}`;
        const created = await putRepoFile(instId, repoName, newPath, `Rename ${oldName} to ${newName}`, contents.content ?? '');
        await deleteRepoFile(instId, repoName, oldFile.path, `Delete ${oldName} (renamed)`, oldFile.sha);
        const updatedFiles = repoFiles.map(f =>
          f.name === oldName ? { name: newName, path: created.content.path, sha: created.content.sha } : f
        ).sort((a, b) => a.name.localeCompare(b.name));
        setRepoFiles(updatedFiles);
        repoFilesRef.current = updatedFiles;
        if (currentFileName === oldName) {
          navigate(`repofile/${encodeURIComponent(newPath)}`);
        }
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      alert(err instanceof Error ? err.message : 'Failed to rename file');
    }
  }, [currentGistId, selectedRepo, currentFileName, repoFiles, navigate, handleSessionExpired]);

  // --- GitHub App callbacks ---
  const onSelectRepo = useCallback((fullName: string, id: number) => {
    setSelectedRepo(fullName);
    storeSelectedRepo({ full_name: fullName, id });
  }, []);

  const onDisconnect = useCallback(() => {
    setInstId(null);
    setSelectedRepo(null);
    navigate('auth');
  }, [navigate]);

  // --- Render active view ---
  const renderView = () => {
    switch (activeView) {
      case 'auth':
        return <AuthView onUserChange={setUser} navigate={navigate} />;
      case 'documents':
        return <DocumentsView navigate={navigate} />;
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
        return <ContentView html={renderedHtml} />;
      case 'edit':
        return (
          <EditView
            title={editTitle}
            content={editContent}
            showTitle={draftMode || !currentFileName}
            onTitleChange={(t: string) => { setEditTitle(t); setHasUnsavedChanges(true); }}
            onContentChange={(c: string) => { setEditContent(c); setHasUnsavedChanges(true); }}
          />
        );
      case 'loading':
        return <LoadingView />;
      case 'error':
        return <ErrorView message={errorMessage} onRetry={() => handleRoute(route)} />;
      default:
        return null;
    }
  };

  const showSidebar = activeView === 'content' || activeView === 'edit';

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

  return (
    <>
      <Toolbar
        view={activeView}
        user={user}
        installationId={installationId}
        selectedRepo={selectedRepo}
        currentGistId={currentGistId}
        currentRepoDocPath={currentRepoDocPath}
        currentFileName={currentFileName}
        theme={theme}
        saving={saving}
        navigate={navigate}
        onSignOut={signOut}
        onToggleTheme={toggleTheme}
        onEdit={onEdit}
        onSave={onSave}
        onCancel={onCancel}
        onDelete={onDelete}
      />
      <div class={showSidebar ? 'app-body' : 'app-body app-body--no-sidebar'}>
        {showSidebar && (
          <Sidebar
            files={sidebarFiles}
            onSelectFile={handleSelectFile}
            onCreateFile={handleCreateFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
          />
        )}
        <main>{renderView()}</main>
      </div>
    </>
  );
}
