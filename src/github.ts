const API_BASE = '/api/github';

export interface GistFile {
  filename: string;
  content: string;
  raw_url: string;
  size: number;
  truncated: boolean;
}

export interface GistSummary {
  id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  public: boolean;
  files: Record<string, { filename: string; size: number }>;
}

export interface GistDetail {
  id: string;
  description: string | null;
  public: boolean;
  files: Record<string, GistFile>;
  created_at: string;
  updated_at: string;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

interface AuthSessionResponse {
  authenticated: boolean;
  user?: GitHubUser;
  installationId?: string | null;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...(options.headers as Record<string, string>),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res;
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Failed to fetch auth session: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Failed to logout: ${res.status} ${res.statusText}`);
}

export async function listGists(page = 1, perPage = 30): Promise<GistSummary[]> {
  const res = await apiFetch(`/gists?per_page=${perPage}&page=${page}`);
  return res.json();
}

export async function getGist(id: string): Promise<GistDetail> {
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`);
  return res.json();
}

export async function createGist(content: string, filename = 'untitled.md', description?: string): Promise<GistDetail> {
  const res = await apiFetch('/gists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: description ?? '',
      public: false,
      files: { [filename]: { content } },
    }),
  });
  return res.json();
}

export async function updateGist(
  id: string,
  content: string,
  filename: string,
  description?: string,
): Promise<GistDetail> {
  const body: Record<string, unknown> = {
    files: { [filename]: { content } },
  };
  if (description !== undefined) body.description = description;
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function updateGistDescription(id: string, description: string): Promise<GistDetail> {
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  return res.json();
}

type GistFileUpdate = { content: string } | { filename: string } | null;

export async function updateGistFiles(
  id: string,
  files: Record<string, GistFileUpdate>,
  description?: string,
): Promise<GistDetail> {
  const body: Record<string, unknown> = { files };
  if (description !== undefined) body.description = description;
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function addFileToGist(id: string, filename: string, content: string): Promise<GistDetail> {
  return updateGistFiles(id, { [filename]: { content } });
}

export async function deleteFileFromGist(id: string, filename: string): Promise<GistDetail> {
  return updateGistFiles(id, { [filename]: null });
}

export async function renameFileInGist(id: string, oldName: string, newName: string): Promise<GistDetail> {
  return updateGistFiles(id, { [oldName]: { filename: newName } });
}

export async function deleteGist(id: string): Promise<void> {
  await apiFetch(`/gists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
