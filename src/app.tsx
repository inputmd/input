import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { parseAnsiToHtml } from './ansi';
import {
  isAuthenticated, clearToken, getUser,
  getGist, updateGist, createGist, deleteGist,
  type GitHubUser, type GistDetail,
} from './github';
import {
  getInstallationId, setInstallationId, clearInstallationId,
  getSelectedRepo, setSelectedRepo as storeSelectedRepo, clearSelectedRepo,
  clearSessionToken, createSession, SessionExpiredError,
  getRepoContents, putRepoFile, isRepoFile,
} from './github_app';
import { encodeUtf8ToBase64, decodeBase64ToUtf8 } from './util';
import { REPO_DOCS_DIR } from './constants';
import { useRoute, type Route } from './hooks/useRoute';
import { Toolbar, type ActiveView } from './components/Toolbar';
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

  // Track initialization
  const initialized = useRef(false);

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
      setUser(u);
    } catch {
      clearToken();
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

    const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
    window.history.replaceState({}, '', cleanUrl);

    navigate('githubapp');
    return true;
  }, [navigate, showError]);

  // --- Data loaders ---
  const loadGistAnonymous = useCallback(async (id: string) => {
    setActiveView('loading');
    try {
      let res = await fetch(`/api/gists/${encodeURIComponent(id)}`);
      if (!res.ok) {
        console.warn(`Gist proxy failed (${res.status}), falling back to GitHub API directly`);
        res = await fetch(`https://api.github.com/gists/${encodeURIComponent(id)}`);
      }
      if (!res.ok) throw new Error(`Failed to fetch gist: ${res.status} ${res.statusText}`);
      const data = await res.json();
      const files = Object.values(data.files) as Array<{ content: string | null; raw_url: string }>;
      const contents: string[] = [];
      for (const file of files) {
        if (file.content != null) {
          contents.push(file.content);
        } else if (new URL(file.raw_url).hostname === 'gist.githubusercontent.com') {
          const raw = await fetch(file.raw_url, { redirect: 'error' });
          if (raw.ok) contents.push(await raw.text());
        }
      }
      const content = contents.join('\n\n');
      setRenderedHtml(parseAnsiToHtml(content));
      setCurrentGistId(null);
      setCurrentRepoDocPath(null);
      setCurrentRepoDocSha(null);
      setActiveView('content');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [showError]);

  const loadGistAuthenticated = useCallback(async (id: string) => {
    setActiveView('loading');
    try {
      const gist = await getGist(id);
      setCurrentGistId(gist.id);
      setCurrentRepoDocPath(null);
      setCurrentRepoDocSha(null);
      const file = Object.values(gist.files)[0];
      const content = file?.content ?? '';

      setRenderedHtml(parseAnsiToHtml(content));
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
      setRenderedHtml(parseAnsiToHtml(decoded));
      setActiveView('content');
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      showError(err instanceof Error ? err.message : 'Failed to load file');
    }
  }, [navigate, handleSessionExpired, showError]);

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
      setEditTitle(contents.name.replace(/\.md$/i, ''));
      setEditContent(decoded);
      setActiveView('edit');
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      showError(err instanceof Error ? err.message : 'Failed to load file');
    }
  }, [navigate, handleSessionExpired, showError]);

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
        await loadRepoFile(decodeURIComponent(r.params.path));
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
        setEditTitle('');
        setEditContent('');
        setActiveView('edit');
        return;
      }
      case 'repoedit':
        setDraftMode(false);
        syncRepoState();
        await loadRepoFileForEdit(decodeURIComponent(r.params.path));
        return;
      case 'documents':
        if (!user) { navigate('auth'); return; }
        setActiveView('documents');
        return;
      case 'new':
        navigate('');
        return;
      case 'edit': {
        if (!user) { navigate('auth'); return; }
        setDraftMode(false);
        setActiveView('loading');
        try {
          const gist = await getGist(r.params.id);
          const file = Object.values(gist.files)[0];
          setEditingBackend('gist');
          setCurrentGistId(gist.id);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setEditTitle(gist.description ?? '');
          setEditContent(file?.content ?? '');
          setActiveView('edit');
        } catch (err) {
          showError(err instanceof Error ? err.message : 'Failed to load gist');
        }
        return;
      }
      case 'gist': {
        const id = r.params.id;
        if (user) await loadGistAuthenticated(id);
        else await loadGistAnonymous(id);
        return;
      }
      case 'home':
        setDraftMode(true);
        setEditingBackend('gist');
        setCurrentGistId(null);
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setEditTitle(localStorage.getItem(DRAFT_TITLE_KEY) ?? '');
        setEditContent(localStorage.getItem(DRAFT_CONTENT_KEY) ?? '');
        setActiveView('edit');
        return;
      default:
        setDraftMode(false);
        setActiveView('edit');
    }
  }, [user, navigate, syncRepoState, loadRepoFile, loadRepoFileForEdit, loadGistAuthenticated, loadGistAnonymous, showError]);

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
    else if (currentGistId) navigate(`edit/${currentGistId}`);
  }, [currentRepoDocPath, currentGistId, navigate]);

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
        if (currentGistId) {
          gist = await updateGist(currentGistId, title, content);
        } else {
          gist = await createGist(title, content);
        }
        setCurrentGistId(gist.id);
        if (draftMode) {
          localStorage.removeItem(DRAFT_TITLE_KEY);
          localStorage.removeItem(DRAFT_CONTENT_KEY);
          setDraftMode(false);
        }

        setRenderedHtml(parseAnsiToHtml(content));
        navigate(`gist/${gist.id}`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      alert(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [editTitle, editContent, editingBackend, currentRepoDocPath, currentRepoDocSha, currentGistId, draftMode, navigate, handleSessionExpired]);

  const onCancel = useCallback(() => {
    if (currentRepoDocPath) navigate(`repofile/${encodeURIComponent(currentRepoDocPath)}`);
    else if (currentGistId) navigate(`gist/${currentGistId}`);
    else if (selectedRepo) navigate('repodocuments');
    else navigate('documents');
  }, [currentRepoDocPath, currentGistId, selectedRepo, navigate]);

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
            onTitleChange={setEditTitle}
            onContentChange={setEditContent}
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

  return (
    <>
      <Toolbar
        view={activeView}
        user={user}
        installationId={installationId}
        selectedRepo={selectedRepo}
        currentGistId={currentGistId}
        currentRepoDocPath={currentRepoDocPath}
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
      <main>{renderView()}</main>
    </>
  );
}
