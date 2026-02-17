const INSTALLATION_ID_KEY = 'github_app_installation_id';
const SELECTED_REPO_KEY = 'github_app_selected_repo';

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

export function createInstallState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getInstallUrl(state: string): Promise<string> {
  const res = await fetch(`/api/github-app/install-url?state=${encodeURIComponent(state)}`);
  if (!res.ok) throw new Error(`Failed to get install URL: ${res.status} ${res.statusText}`);
  const data = await res.json() as { url: string };
  return data.url;
}

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

export async function listInstallationRepos(installationId: string): Promise<InstallationRepoList> {
  const res = await fetch(`/api/github-app/installations/${encodeURIComponent(installationId)}/repositories`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return res.json();
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo: ${fullName}`);
  return { owner, repo };
}

export type RepoContents =
  | {
    type: 'file';
    name: string;
    path: string;
    sha: string;
    size: number;
    content?: string;
    encoding?: 'base64';
  }
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

export async function getRepoContents(installationId: string, repoFullName: string, path: string, ref?: string): Promise<RepoContents> {
  const { owner, repo } = splitFullName(repoFullName);
  const qs = new URLSearchParams({ path });
  if (ref) qs.set('ref', ref);
  const res = await fetch(`/api/github-app/installations/${encodeURIComponent(installationId)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?${qs.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return res.json();
}

export interface PutFileResult {
  content: { path: string; sha: string };
  commit: { sha: string; html_url: string };
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
  const res = await fetch(`/api/github-app/installations/${encodeURIComponent(installationId)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, message, content: contentBase64, sha }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
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
  const res = await fetch(`/api/github-app/installations/${encodeURIComponent(installationId)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, message, sha }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
}
