const INSTALLATION_ID_KEY = 'github_app_installation_id';
const SELECTED_REPO_KEY = 'github_app_selected_repo';
const SESSION_TOKEN_KEY = 'github_app_session_token';

export function getInstallationId(): string | null {
  return localStorage.getItem(INSTALLATION_ID_KEY);
}

export function setInstallationId(id: string): void {
  localStorage.setItem(INSTALLATION_ID_KEY, id);
}

export function clearInstallationId(): void {
  localStorage.removeItem(INSTALLATION_ID_KEY);
}

export interface SelectedRepo {
  full_name: string; // owner/name
  id?: number;
}

export function getSelectedRepo(): SelectedRepo | null {
  const raw = localStorage.getItem(SELECTED_REPO_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SelectedRepo;
    if (!parsed?.full_name) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setSelectedRepo(repo: SelectedRepo): void {
  localStorage.setItem(SELECTED_REPO_KEY, JSON.stringify(repo));
}

export function clearSelectedRepo(): void {
  localStorage.removeItem(SELECTED_REPO_KEY);
}

export function getSessionToken(): string | null {
  return sessionStorage.getItem(SESSION_TOKEN_KEY);
}

export function setSessionToken(token: string): void {
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
}

export function clearSessionToken(): void {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

// --- Error types ---

export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

// --- Fetch helpers ---

function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string>) },
  });
  if (res.status === 401) {
    clearSessionToken();
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res;
}

// --- Public endpoints (no auth) ---

export async function createSession(installationId: string): Promise<string> {
  const res = await fetch('/api/github-app/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { token: string; installationId: string };
  setSessionToken(data.token);
  return data.token;
}

export function createInstallState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getInstallUrl(state: string): Promise<string> {
  const res = await fetch(`/api/github-app/install-url?state=${encodeURIComponent(state)}`);
  if (!res.ok) throw new Error(`Failed to get install URL: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { url: string };
  return data.url;
}

// --- Types ---

export interface InstallationRepoList {
  total_count: number;
  repositories: Array<{
    id: number;
    full_name: string;
    private: boolean;
    html_url: string;
    permissions?: Record<string, boolean>;
  }>;
}

export interface RepoFile {
  type: 'file';
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: 'base64';
}

export function isRepoFile(contents: RepoContents): contents is RepoFile {
  return !Array.isArray(contents) && contents.type === 'file';
}

export type RepoContents =
  | RepoFile
  | Array<{
      type: 'file' | 'dir' | 'symlink' | 'submodule';
      name: string;
      path: string;
      sha: string;
      size: number;
      url: string;
      html_url: string;
      download_url: string | null;
    }>;

export interface PutFileResult {
  content: { path: string; sha: string };
  commit: { sha: string; html_url: string };
}

// --- Authenticated API functions ---

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo: ${fullName}`);
  return { owner, repo };
}

function installationUrl(installationId: string, ...segments: string[]): string {
  const base = `/api/github-app/installations/${encodeURIComponent(installationId)}`;
  return segments.length ? `${base}/${segments.map(encodeURIComponent).join('/')}` : base;
}

export async function listInstallationRepos(installationId: string): Promise<InstallationRepoList> {
  const res = await authFetch(`${installationUrl(installationId)}/repositories`);
  return res.json();
}

export async function getRepoContents(
  installationId: string,
  repoFullName: string,
  path: string,
  ref?: string,
): Promise<RepoContents> {
  const { owner, repo } = splitFullName(repoFullName);
  const qs = new URLSearchParams({ path });
  if (ref) qs.set('ref', ref);
  const res = await authFetch(`${installationUrl(installationId, 'repos', owner, repo)}/contents?${qs.toString()}`);
  return res.json();
}

export async function putRepoFile(
  installationId: string,
  repoFullName: string,
  path: string,
  message: string,
  contentBase64: string,
  sha?: string,
): Promise<PutFileResult> {
  const { owner, repo } = splitFullName(repoFullName);
  const res = await authFetch(`${installationUrl(installationId, 'repos', owner, repo)}/contents`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, message, content: contentBase64, sha }),
  });
  return res.json();
}

export async function deleteRepoFile(
  installationId: string,
  repoFullName: string,
  path: string,
  message: string,
  sha: string,
): Promise<void> {
  const { owner, repo } = splitFullName(repoFullName);
  await authFetch(`${installationUrl(installationId, 'repos', owner, repo)}/contents`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, message, sha }),
  });
}
