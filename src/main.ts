import { parseAnsiToHtml } from './ansi';
import {
  isAuthenticated, setToken, clearToken,
  getUser, listGists, getGist, createGist, updateGist, deleteGist,
  type GistSummary, type GistDetail, type GitHubUser,
} from './github';
import {
  getInstallationId, setInstallationId, clearInstallationId,
  createInstallState, getInstallUrl, listInstallationRepos,
  type InstallationRepoList,
} from './github_app';
import './style.css';

// --- State ---

let currentUser: GitHubUser | null = null;
let currentGistId: string | null = null;
let currentGistContent: string = '';
let renderedHtml = '';
let documentsPage = 1;
let allDocumentsLoaded = false;
let currentInstallationId: string | null = null;

// --- DOM helpers ---

const $ = (id: string) => document.getElementById(id)!;

type View = 'input' | 'auth' | 'documents' | 'loading' | 'error' | 'content' | 'edit';

type ExtendedView = View | 'githubapp';
const ALL_VIEWS: ExtendedView[] = ['input', 'auth', 'documents', 'githubapp', 'loading', 'error', 'content', 'edit'];

function showView(name: ExtendedView) {
  for (const v of ALL_VIEWS) {
    $(`${v}-view`).style.display = v === name ? '' : 'none';
  }

  // Action buttons visibility
  const isOwnedGist = name === 'content' && currentUser !== null && currentGistId !== null;
  $('edit-btn').style.display = isOwnedGist ? '' : 'none';
  $('delete-btn').style.display = isOwnedGist ? '' : 'none';
  $('save-btn').style.display = name === 'edit' ? '' : 'none';
  $('cancel-btn').style.display = name === 'edit' ? '' : 'none';

  // Nav buttons
  $('docs-btn').style.display = currentUser && name !== 'documents' ? '' : 'none';
  $('viewer-btn').style.display = name !== 'input' && name !== 'auth' ? '' : 'none';
  $('githubapp-btn').style.display = currentInstallationId && name !== 'githubapp' ? '' : 'none';
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
    status.textContent = `Connected (installation_id=${currentInstallationId}).`;
    $('githubapp-disconnect-btn').style.display = '';
    $('githubapp-refresh-btn').style.display = '';
  } else {
    status.textContent = 'Not connected.';
    $('githubapp-disconnect-btn').style.display = 'none';
    $('githubapp-refresh-btn').style.display = 'none';
    $('githubapp-repos').innerHTML = '';
  }
}

// --- Gist URL extraction (existing) ---

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
      const raw = await fetch(file.raw_url);
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

async function connectGitHubApp() {
  const state = createInstallState();
  sessionStorage.setItem('github_app_install_state', state);
  const url = await getInstallUrl(state);
  window.location.assign(url);
}

function tryHandleGitHubAppSetupRedirect(): boolean {
  const params = new URLSearchParams(window.location.search);
  const installationId = params.get('installation_id');
  if (!installationId) return false;

  const expectedState = sessionStorage.getItem('github_app_install_state');
  const actualState = params.get('state');
  sessionStorage.removeItem('github_app_install_state');

  if (expectedState && actualState && expectedState !== actualState) {
    $('error-message').textContent = 'GitHub App install state mismatch. Please try again.';
    showView('error');
    return true;
  }

  setInstallationId(installationId);
  currentInstallationId = installationId;
  updateGitHubAppUI();

  // Clean up URL (remove query params).
  const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
  window.history.replaceState({}, '', cleanUrl);

  navigate('githubapp');
  return true;
}

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
    const a = document.createElement('a');
    a.href = repo.html_url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = repo.full_name + (repo.private ? ' (private)' : '');
    li.appendChild(a);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

async function loadGitHubAppRepos(): Promise<void> {
  if (!currentInstallationId) return;
  showView('loading');
  try {
    const repos = await listInstallationRepos(currentInstallationId);
    renderRepoList(repos);
    showView('githubapp');
  } catch (err) {
    $('error-message').textContent = err instanceof Error ? err.message : 'Failed to load repositories';
    showView('error');
  }
}

// --- Document list ---

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderDocumentCard(gist: GistSummary): HTMLElement {
  const card = document.createElement('div');
  card.className = 'document-card';

  const title = gist.description || 'Untitled';
  const fileCount = Object.keys(gist.files).length;
  const updated = formatDate(gist.updated_at);

  card.innerHTML = `
    <div class="doc-info">
      <span class="doc-title">${escapeHtml(title)}</span>
      <span class="doc-meta">${fileCount} file${fileCount !== 1 ? 's' : ''} &middot; Updated ${updated}</span>
    </div>
    <div class="doc-actions">
      <button class="doc-open-btn" type="button">Open</button>
      <button class="doc-delete-btn" type="button">Delete</button>
    </div>
  `;

  card.querySelector('.doc-open-btn')!.addEventListener('click', () => {
    navigate(`gist/${gist.id}`);
  });

  card.querySelector('.doc-delete-btn')!.addEventListener('click', async () => {
    if (!confirm(`Delete "${title}"?`)) return;
    try {
      await deleteGist(gist.id);
      card.remove();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  });

  return card;
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

async function saveDocument() {
  const title = ($('doc-title') as HTMLInputElement).value.trim() || 'Untitled';
  const content = ($('doc-editor') as HTMLTextAreaElement).value;

  $('save-btn').textContent = 'Saving...';
  ($('save-btn') as HTMLButtonElement).disabled = true;

  try {
    let gist: GistDetail;
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
  } catch (err) {
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

async function handleRoute() {
  const hash = window.location.hash.slice(1);

  if (hash === 'auth') {
    showView('auth');
    ($('pat-input') as HTMLInputElement).focus();
    return;
  }

  if (hash === 'githubapp') {
    currentInstallationId = getInstallationId();
    updateGitHubAppUI();
    showView('githubapp');
    return;
  }

  if (hash === 'documents') {
    if (!currentUser) { navigate('auth'); return; }
    await loadDocuments(true);
    return;
  }

  if (hash === 'new') {
    if (!currentUser) { navigate('auth'); return; }
    enterEditMode(null, '', '');
    return;
  }

  if (hash.startsWith('edit/')) {
    const id = hash.slice(5);
    if (!currentUser) { navigate('auth'); return; }
    showView('loading');
    try {
      const gist = await getGist(id);
      const file = Object.values(gist.files)[0];
      enterEditMode(gist.id, gist.description ?? '', file?.content ?? '');
    } catch (err) {
      $('error-message').textContent = err instanceof Error ? err.message : 'Failed to load gist';
      showView('error');
    }
    return;
  }

  if (hash.startsWith('gist/')) {
    const id = hash.slice(5);
    if (currentUser) {
      await loadGistAuthenticated(id);
    } else {
      await loadGistAnonymous(id);
    }
    return;
  }

  // Legacy: bare gist ID in hash (existing behavior)
  if (hash && /^[a-f0-9]+$/i.test(hash)) {
    if (currentUser) {
      await loadGistAuthenticated(hash);
    } else {
      await loadGistAnonymous(hash);
    }
    return;
  }

  // Default: show input view
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

  // Edit/Save/Cancel for content view
  $('edit-btn').addEventListener('click', () => {
    if (currentGistId) navigate(`edit/${currentGistId}`);
  });
  $('save-btn').addEventListener('click', saveDocument);
  $('cancel-btn').addEventListener('click', () => {
    if (currentGistId) {
      navigate(`gist/${currentGistId}`);
    } else {
      navigate('documents');
    }
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

  // GitHub App setup redirect (runs before routing)
  const handledSetup = tryHandleGitHubAppSetupRedirect();

  // Restore auth, then handle initial route, then reveal
  tryRestoreAuth().then(() => handledSetup ? undefined : handleRoute()).then(() => {
    $('app').classList.add('ready');
  });

  // GitHub App view actions
  $('githubapp-refresh-btn').addEventListener('click', () => {
    loadGitHubAppRepos();
  });
  $('githubapp-disconnect-btn').addEventListener('click', () => {
    clearInstallationId();
    currentInstallationId = null;
    updateGitHubAppUI();
    navigate('auth');
  });
}

init();
