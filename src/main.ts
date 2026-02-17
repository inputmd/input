import { parseAnsiToHtml } from './ansi';
import {
  isAuthenticated, setToken, clearToken,
  getUser, listGists, getGist, createGist, updateGist, deleteGist,
  type GistSummary, type GistDetail, type GitHubUser,
} from './github';
import {
  getInstallationId, setInstallationId, clearInstallationId,
  getSelectedRepo, setSelectedRepo, clearSelectedRepo,
  clearSessionToken, createSession, SessionExpiredError,
  createInstallState, getInstallUrl, listInstallationRepos,
  getRepoContents, putRepoFile, deleteRepoFile,
  type InstallationRepoList,
  type RepoContents,
} from './github_app';
import { encodeUtf8ToBase64, decodeBase64ToUtf8 } from './util';
import './style.css';

// --- State ---

let currentUser: GitHubUser | null = null;
let currentGistId: string | null = null;
let currentGistContent: string = '';
let renderedHtml = '';
let documentsPage = 1;
let allDocumentsLoaded = false;
let currentInstallationId: string | null = null;
let selectedRepoFullName: string | null = null;
let currentRepoDocPath: string | null = null;
let currentRepoDocSha: string | null = null;
let editingBackend: 'gist' | 'repo' | null = null;

const REPO_DOCS_DIR = '.input/documents';

// --- DOM helpers ---

const $ = (id: string) => document.getElementById(id)!;

type AppView = 'input' | 'auth' | 'documents' | 'githubapp' | 'repodocuments' | 'loading' | 'error' | 'content' | 'edit';
const ALL_VIEWS: AppView[] = ['input', 'auth', 'documents', 'githubapp', 'repodocuments', 'loading', 'error', 'content', 'edit'];

function showView(name: AppView) {
  for (const v of ALL_VIEWS) {
    $(`${v}-view`).style.display = v === name ? '' : 'none';
  }

  const isRepoFile = name === 'content' && currentRepoDocPath !== null;
  const isOwnedGist = name === 'content' && currentUser !== null && currentGistId !== null;

  const buttons: Record<string, boolean> = {
    'edit-btn': isRepoFile || isOwnedGist,
    'delete-btn': isOwnedGist,
    'save-btn': name === 'edit',
    'cancel-btn': name === 'edit',
    'docs-btn': !!currentUser && name !== 'documents',
    'viewer-btn': true,
    'githubapp-btn': !!currentInstallationId && name !== 'githubapp',
    'repodocs-btn': !!selectedRepoFullName && name !== 'repodocuments',
  };

  for (const [id, visible] of Object.entries(buttons)) {
    $(id).style.display = visible ? '' : 'none';
  }
}

function updateAuthUI() {
  if (currentUser) {
    $('user-info').style.display = '';
    ($('user-avatar') as HTMLImageElement).src = currentUser.avatar_url;
    $('user-name').textContent = currentUser.name ?? currentUser.login;
    $('signin-btn').style.display = 'none';
  } else {
    $('user-info').style.display = 'none';
    $('signin-btn').style.display = '';
  }
}

function updateGitHubAppUI() {
  const status = $('githubapp-status');
  if (currentInstallationId) {
    status.textContent = `Connected (installation_id=${currentInstallationId})${selectedRepoFullName ? `, repo=${selectedRepoFullName}` : ''}.`;
    $('githubapp-disconnect-btn').style.display = '';
    $('githubapp-refresh-btn').style.display = '';
  } else {
    status.textContent = 'Not connected.';
    $('githubapp-disconnect-btn').style.display = 'none';
    $('githubapp-refresh-btn').style.display = 'none';
    $('githubapp-repos').innerHTML = '';
  }
}

// --- Session expiry ---

function handleSessionExpired() {
  clearInstallationId();
  clearSelectedRepo();
  clearSessionToken();
  currentInstallationId = null;
  selectedRepoFullName = null;
  updateGitHubAppUI();
  navigate('auth');
}

// --- Helpers ---

function syncRepoState() {
  currentInstallationId = getInstallationId();
  selectedRepoFullName = getSelectedRepo()?.full_name ?? null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

// --- Gist URL extraction ---

function extractGistId(input: string): string | null {
  input = input.trim();
  if (/^[a-f0-9]+$/i.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === 'gist.github.com' || url.hostname === 'gist.githubusercontent.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^[a-f0-9]+$/i.test(parts[i])) return parts[i];
      }
    }
  } catch { /* not a url */ }
  return null;
}

// --- Fetch & display a gist ---

async function fetchGistContent(id: string): Promise<string> {
  const res = await fetch(`https://api.github.com/gists/${id}`);
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
  return contents.join('\n\n');
}

async function loadGistAnonymous(id: string) {
  showView('loading');
  try {
    const content = await fetchGistContent(id);
    renderedHtml = parseAnsiToHtml(content);
    $('rendered-content').innerHTML = renderedHtml;
    currentGistId = null;
    currentRepoDocPath = null;
    currentRepoDocSha = null;
    showView('content');
  } catch (err) {
    $('error-message').textContent = err instanceof Error ? err.message : 'Unknown error';
    showView('error');
  }
}

async function loadGistAuthenticated(id: string) {
  showView('loading');
  try {
    const gist = await getGist(id);
    currentGistId = gist.id;
    currentRepoDocPath = null;
    currentRepoDocSha = null;
    const file = Object.values(gist.files)[0];
    currentGistContent = file?.content ?? '';
    renderedHtml = parseAnsiToHtml(currentGistContent);
    $('rendered-content').innerHTML = renderedHtml;
    showView('content');
  } catch (err) {
    $('error-message').textContent = err instanceof Error ? err.message : 'Unknown error';
    showView('error');
  }
}

// --- Auth ---

async function tryRestoreAuth() {
  if (!isAuthenticated()) return;
  try {
    currentUser = await getUser();
    updateAuthUI();
  } catch {
    clearToken();
    currentUser = null;
    updateAuthUI();
  }
}

async function signIn(token: string) {
  setToken(token);
  try {
    currentUser = await getUser();
    updateAuthUI();
    $('auth-error').style.display = 'none';
    navigate('documents');
  } catch (err) {
    clearToken();
    currentUser = null;
    updateAuthUI();
    const errEl = $('auth-error');
    errEl.textContent = err instanceof Error ? err.message : 'Invalid token';
    errEl.style.display = '';
  }
}

function signOut() {
  clearToken();
  currentUser = null;
  currentGistId = null;
  updateAuthUI();
  navigate('');
}

// --- GitHub App ---

async function connectGitHubApp() {
  const state = createInstallState();
  sessionStorage.setItem('github_app_install_state', state);
  const url = await getInstallUrl(state);
  window.location.assign(url);
}

async function tryHandleGitHubAppSetupRedirect(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const installationId = params.get('installation_id');
  if (!installationId) return false;

  const expectedState = sessionStorage.getItem('github_app_install_state');
  const actualState = params.get('state');
  sessionStorage.removeItem('github_app_install_state');

  if (!expectedState || !actualState || expectedState !== actualState) {
    $('error-message').textContent = 'GitHub App install state mismatch. Please try again.';
    showView('error');
    return true;
  }

  try {
    await createSession(installationId);
  } catch (err) {
    $('error-message').textContent = err instanceof Error ? err.message : 'Failed to create session';
    showView('error');
    return true;
  }

  setInstallationId(installationId);
  currentInstallationId = installationId;
  updateGitHubAppUI();

  const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
  window.history.replaceState({}, '', cleanUrl);

  navigate('githubapp');
  return true;
}

// --- Rendering ---

function renderRepoList(list: InstallationRepoList): void {
  const container = $('githubapp-repos');
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'hint';
  header.textContent = `${list.total_count} repo${list.total_count === 1 ? '' : 's'} accessible via this installation:`;
  container.appendChild(header);

  const ul = document.createElement('ul');
  for (const repo of list.repositories) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = selectedRepoFullName === repo.full_name ? 'Selected' : 'Select';
    btn.disabled = selectedRepoFullName === repo.full_name;
    btn.style.marginRight = '8px';
    btn.addEventListener('click', () => {
      selectedRepoFullName = repo.full_name;
      setSelectedRepo({ full_name: repo.full_name, id: repo.id });
      updateGitHubAppUI();
      navigate('repodocuments');
    });
    li.appendChild(btn);
    const a = document.createElement('a');
    a.href = repo.html_url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = repo.full_name + (repo.private ? ' (private)' : '');
    li.appendChild(a);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

function renderRepoDocumentCard(item: { name: string; path: string; sha: string; size: number }): HTMLElement {
  const card = document.createElement('div');
  card.className = 'document-card';

  const info = document.createElement('div');
  info.className = 'doc-info';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'doc-title';
  titleSpan.textContent = item.name;
  const metaSpan = document.createElement('span');
  metaSpan.className = 'doc-meta';
  metaSpan.textContent = `${item.size} bytes`;
  info.append(titleSpan, metaSpan);

  const actions = document.createElement('div');
  actions.className = 'doc-actions';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => navigate(`repofile/${encodeURIComponent(item.path)}`));
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'doc-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!currentInstallationId || !selectedRepoFullName) return;
    if (!confirm(`Delete "${item.name}" from ${selectedRepoFullName}?`)) return;
    try {
      await deleteRepoFile(currentInstallationId, selectedRepoFullName, item.path, `Delete ${item.name}`, item.sha);
      card.remove();
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  });
  actions.append(openBtn, deleteBtn);

  card.append(info, actions);
  return card;
}

function renderDocumentCard(gist: GistSummary): HTMLElement {
  const card = document.createElement('div');
  card.className = 'document-card';

  const title = gist.description || 'Untitled';
  const fileCount = Object.keys(gist.files).length;
  const updated = formatDate(gist.updated_at);

  const info = document.createElement('div');
  info.className = 'doc-info';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'doc-title';
  titleSpan.textContent = title;
  const metaSpan = document.createElement('span');
  metaSpan.className = 'doc-meta';
  metaSpan.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''} \u00b7 Updated ${updated}`;
  info.append(titleSpan, metaSpan);

  const actions = document.createElement('div');
  actions.className = 'doc-actions';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => navigate(`gist/${gist.id}`));
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'doc-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${title}"?`)) return;
    try {
      await deleteGist(gist.id);
      card.remove();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  });
  actions.append(openBtn, deleteBtn);

  card.append(info, actions);
  return card;
}

// --- Data loaders ---

async function loadGitHubAppRepos(): Promise<void> {
  if (!currentInstallationId) return;
  showView('loading');
  try {
    const repos = await listInstallationRepos(currentInstallationId);
    renderRepoList(repos);
    showView('githubapp');
  } catch (err) {
    if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
    $('error-message').textContent = err instanceof Error ? err.message : 'Failed to load repositories';
    showView('error');
  }
}

async function loadRepoDocuments(): Promise<void> {
  if (!currentInstallationId || !selectedRepoFullName) { navigate('githubapp'); return; }
  showView('loading');
  try {
    const contents = await getRepoContents(currentInstallationId, selectedRepoFullName, REPO_DOCS_DIR);
    const listEl = $('repodocuments-list');
    listEl.innerHTML = '';
    const meta = $('repodocuments-meta');
    meta.textContent = `${selectedRepoFullName}:${REPO_DOCS_DIR}`;

    if (Array.isArray(contents)) {
      const files = contents
        .filter((c) => c.type === 'file' && c.name.toLowerCase().endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of files) listEl.appendChild(renderRepoDocumentCard(f));
    } else {
      const msg = `${REPO_DOCS_DIR} is a file; expected a directory.`;
      $('error-message').textContent = msg;
      showView('error');
      return;
    }
    showView('repodocuments');
  } catch (err) {
    if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
    const msg = err instanceof Error ? err.message : 'Failed to load repo documents';
    if (String(msg).includes('404')) {
      $('repodocuments-list').innerHTML = '';
      $('repodocuments-meta').textContent = `${selectedRepoFullName}:${REPO_DOCS_DIR} (does not exist yet)`;
      showView('repodocuments');
      return;
    }
    $('error-message').textContent = msg;
    showView('error');
  }
}

async function loadRepoFile(path: string): Promise<void> {
  if (!currentInstallationId || !selectedRepoFullName) { navigate('githubapp'); return; }
  showView('loading');
  try {
    const contents = await getRepoContents(currentInstallationId, selectedRepoFullName, path) as RepoContents;
    if (Array.isArray(contents) || (contents as any).type !== 'file') {
      throw new Error('Expected a file');
    }
    const file = contents as Extract<RepoContents, { type: 'file' }>;
    const decoded = file.content ? decodeBase64ToUtf8(file.content) : '';
    currentRepoDocPath = file.path;
    currentRepoDocSha = file.sha;
    currentGistId = null;
    currentGistContent = decoded;
    renderedHtml = parseAnsiToHtml(decoded);
    $('rendered-content').innerHTML = renderedHtml;
    showView('content');
  } catch (err) {
    if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
    $('error-message').textContent = err instanceof Error ? err.message : 'Failed to load file';
    showView('error');
  }
}

async function loadDocuments(reset = false) {
  if (reset) {
    documentsPage = 1;
    allDocumentsLoaded = false;
    $('documents-list').innerHTML = '';
  }

  showView('documents');

  try {
    const gists = await listGists(documentsPage);
    const list = $('documents-list');

    for (const gist of gists) {
      list.appendChild(renderDocumentCard(gist));
    }

    if (gists.length < 30) {
      allDocumentsLoaded = true;
    } else {
      documentsPage++;
    }

    $('load-more-btn').style.display = allDocumentsLoaded ? 'none' : '';
  } catch (err) {
    $('error-message').textContent = err instanceof Error ? err.message : 'Failed to load documents';
    showView('error');
  }
}

// --- Editor ---

function enterEditMode(gistId: string | null, title: string, content: string) {
  currentGistId = gistId;
  ($('doc-title') as HTMLInputElement).value = title;
  ($('doc-editor') as HTMLTextAreaElement).value = content;
  showView('edit');
  ($('doc-editor') as HTMLTextAreaElement).focus();
}

function startGistEdit(gistId: string | null, title: string, content: string) {
  editingBackend = 'gist';
  currentRepoDocPath = null;
  currentRepoDocSha = null;
  enterEditMode(gistId, title, content);
}

function startRepoEdit(path: string | null, sha: string | null, title: string, content: string) {
  editingBackend = 'repo';
  currentRepoDocPath = path;
  currentRepoDocSha = sha;
  enterEditMode(null, title, content);
}

async function saveDocument() {
  const title = ($('doc-title') as HTMLInputElement).value.trim() || 'Untitled';
  const content = ($('doc-editor') as HTMLTextAreaElement).value;

  $('save-btn').textContent = 'Saving...';
  ($('save-btn') as HTMLButtonElement).disabled = true;

  try {
    let gist: GistDetail;
    if (editingBackend === 'repo' && currentRepoDocPath && currentInstallationId && selectedRepoFullName) {
      const contentB64 = encodeUtf8ToBase64(content);
      await putRepoFile(currentInstallationId, selectedRepoFullName, currentRepoDocPath, `Update ${currentRepoDocPath}`, contentB64, currentRepoDocSha ?? undefined);
      currentGistContent = content;
      renderedHtml = parseAnsiToHtml(content);
      $('rendered-content').innerHTML = renderedHtml;
      navigate(`repofile/${encodeURIComponent(currentRepoDocPath)}`);
    } else if (editingBackend === 'repo' && selectedRepoFullName && currentInstallationId) {
      const filename = sanitizeTitleToFileName(title);
      const path = `${REPO_DOCS_DIR}/${filename}`;
      const contentB64 = encodeUtf8ToBase64(content);
      await putRepoFile(currentInstallationId, selectedRepoFullName, path, `Create ${filename}`, contentB64);
      currentRepoDocPath = path;
      currentRepoDocSha = null;
      currentGistContent = content;
      renderedHtml = parseAnsiToHtml(content);
      $('rendered-content').innerHTML = renderedHtml;
      navigate(`repofile/${encodeURIComponent(path)}`);
    } else {
      if (currentGistId) {
        gist = await updateGist(currentGistId, title, content);
      } else {
        gist = await createGist(title, content);
      }

      currentGistId = gist.id;
      currentGistContent = content;
      renderedHtml = parseAnsiToHtml(content);
      $('rendered-content').innerHTML = renderedHtml;
      navigate(`gist/${gist.id}`);
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
    alert(err instanceof Error ? err.message : 'Failed to save');
  } finally {
    $('save-btn').textContent = 'Save';
    ($('save-btn') as HTMLButtonElement).disabled = false;
  }
}

// --- Routing ---

function navigate(route: string) {
  window.location.hash = route;
}

interface Route {
  pattern: RegExp;
  handler: (match: RegExpMatchArray) => void | Promise<void>;
}

const routes: Route[] = [
  { pattern: /^auth$/, handler: () => {
    showView('auth');
    ($('pat-input') as HTMLInputElement).focus();
  }},
  { pattern: /^githubapp$/, handler: () => {
    syncRepoState();
    updateGitHubAppUI();
    showView('githubapp');
  }},
  { pattern: /^repodocuments$/, handler: async () => {
    syncRepoState();
    await loadRepoDocuments();
  }},
  { pattern: /^repofile\/(.+)$/, handler: async (m) => {
    syncRepoState();
    await loadRepoFile(decodeURIComponent(m[1]));
  }},
  { pattern: /^reponew$/, handler: () => {
    syncRepoState();
    if (!currentInstallationId || !selectedRepoFullName) { navigate('githubapp'); return; }
    startRepoEdit(null, null, '', '');
  }},
  { pattern: /^repoedit\/(.+)$/, handler: async (m) => {
    const path = decodeURIComponent(m[1]);
    syncRepoState();
    if (!currentInstallationId || !selectedRepoFullName) { navigate('githubapp'); return; }
    showView('loading');
    try {
      const contents = await getRepoContents(currentInstallationId, selectedRepoFullName, path) as RepoContents;
      if (Array.isArray(contents) || (contents as any).type !== 'file') throw new Error('Expected a file');
      const file = contents as Extract<RepoContents, { type: 'file' }>;
      const decoded = file.content ? decodeBase64ToUtf8(file.content) : '';
      startRepoEdit(file.path, file.sha, file.name.replace(/\.md$/i, ''), decoded);
    } catch (err) {
      if (err instanceof SessionExpiredError) { handleSessionExpired(); return; }
      $('error-message').textContent = err instanceof Error ? err.message : 'Failed to load file';
      showView('error');
    }
  }},
  { pattern: /^documents$/, handler: async () => {
    if (!currentUser) { navigate('auth'); return; }
    await loadDocuments(true);
  }},
  { pattern: /^new$/, handler: () => {
    if (!currentUser) { navigate('auth'); return; }
    startGistEdit(null, '', '');
  }},
  { pattern: /^edit\/(.+)$/, handler: async (m) => {
    const id = m[1];
    if (!currentUser) { navigate('auth'); return; }
    showView('loading');
    try {
      const gist = await getGist(id);
      const file = Object.values(gist.files)[0];
      startGistEdit(gist.id, gist.description ?? '', file?.content ?? '');
    } catch (err) {
      $('error-message').textContent = err instanceof Error ? err.message : 'Failed to load gist';
      showView('error');
    }
  }},
  { pattern: /^gist\/(.+)$/, handler: async (m) => {
    const id = m[1];
    if (currentUser) await loadGistAuthenticated(id);
    else await loadGistAnonymous(id);
  }},
  // Legacy: bare gist ID in hash
  { pattern: /^[a-f0-9]+$/i, handler: async (m) => {
    const id = m[0];
    if (currentUser) await loadGistAuthenticated(id);
    else await loadGistAnonymous(id);
  }},
];

async function handleRoute() {
  const hash = window.location.hash.slice(1);
  for (const route of routes) {
    const match = hash.match(route.pattern);
    if (match) { await route.handler(match); return; }
  }
  showView('input');
}

// --- Theme ---

function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') !== 'light';
  root.setAttribute('data-theme', isDark ? 'light' : 'dark');
  $('theme-icon').textContent = isDark ? '\u263D' : '\u2600';
}

// --- Init ---

function init() {
  currentInstallationId = getInstallationId();
  selectedRepoFullName = getSelectedRepo()?.full_name ?? null;
  updateAuthUI();
  updateGitHubAppUI();

  // Theme
  $('theme-toggle').addEventListener('click', toggleTheme);

  // Sign in/out
  $('signin-btn').addEventListener('click', () => navigate('auth'));
  $('signout-btn').addEventListener('click', signOut);

  // Auth form
  $('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const token = ($('pat-input') as HTMLInputElement).value.trim();
    if (token) signIn(token);
  });

  // GitHub App connect (repo-scoped)
  $('githubapp-connect-btn').addEventListener('click', () => {
    connectGitHubApp().catch((err) => {
      const errEl = $('auth-error');
      errEl.textContent = err instanceof Error ? err.message : 'Failed to connect GitHub App';
      errEl.style.display = '';
    });
  });

  // Gist URL form (existing viewer)
  $('gist-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = ($('gist-url') as HTMLInputElement).value;
    const id = extractGistId(input);
    if (id) navigate(`gist/${id}`);
  });

  // Navigation buttons
  $('docs-btn').addEventListener('click', () => navigate('documents'));
  $('viewer-btn').addEventListener('click', () => navigate(''));
  $('githubapp-btn').addEventListener('click', () => navigate('githubapp'));
  $('repodocs-btn').addEventListener('click', () => navigate('repodocuments'));

  // Edit/Save/Cancel for content view
  $('edit-btn').addEventListener('click', () => {
    if (currentRepoDocPath) navigate(`repoedit/${encodeURIComponent(currentRepoDocPath)}`);
    else if (currentGistId) navigate(`edit/${currentGistId}`);
  });
  $('save-btn').addEventListener('click', saveDocument);
  $('cancel-btn').addEventListener('click', () => {
    if (currentRepoDocPath) navigate(`repofile/${encodeURIComponent(currentRepoDocPath)}`);
    else if (currentGistId) navigate(`gist/${currentGistId}`);
    else if (selectedRepoFullName) navigate('repodocuments');
    else navigate('documents');
  });

  // Delete
  $('delete-btn').addEventListener('click', async () => {
    if (!currentGistId) return;
    if (!confirm('Delete this document?')) return;
    try {
      await deleteGist(currentGistId);
      currentGistId = null;
      navigate('documents');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  });

  // New document
  $('new-doc-btn').addEventListener('click', () => navigate('new'));

  // Load more documents
  $('load-more-btn').addEventListener('click', () => loadDocuments());

  // Retry
  $('retry-btn').addEventListener('click', handleRoute);

  // Hash-based routing
  window.addEventListener('hashchange', handleRoute);

  // GitHub App setup redirect (runs before routing), then restore auth + route
  tryHandleGitHubAppSetupRedirect().then((handledSetup) =>
    tryRestoreAuth().then(() => handledSetup ? undefined : handleRoute())
  ).then(() => {
    $('app').classList.add('ready');
  });

  // GitHub App view actions
  $('githubapp-refresh-btn').addEventListener('click', () => {
    loadGitHubAppRepos();
  });
  $('githubapp-disconnect-btn').addEventListener('click', () => {
    clearInstallationId();
    clearSelectedRepo();
    clearSessionToken();
    currentInstallationId = null;
    selectedRepoFullName = null;
    updateGitHubAppUI();
    navigate('auth');
  });

  $('repo-new-doc-btn').addEventListener('click', () => navigate('reponew'));
}

init();
