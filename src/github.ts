const STORAGE_KEY = 'github_pat';
const API_BASE = 'https://api.github.com';

// --- Types ---

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

// --- Token management ---

export function getToken(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

// --- API helpers ---

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    ...options.headers as Record<string, string>,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return res;
}

// --- API calls ---

export async function getUser(): Promise<GitHubUser> {
  const res = await apiFetch('/user');
  return res.json();
}

export async function listGists(page = 1, perPage = 30): Promise<GistSummary[]> {
  const res = await apiFetch(`/gists?per_page=${perPage}&page=${page}`);
  return res.json();
}

export async function getGist(id: string): Promise<GistDetail> {
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`);
  return res.json();
}

export async function createGist(title: string, content: string): Promise<GistDetail> {
  const res = await apiFetch('/gists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: title,
      public: false,
      files: { 'document.md': { content } },
    }),
  });
  return res.json();
}

export async function updateGist(id: string, title: string, content: string): Promise<GistDetail> {
  const res = await apiFetch(`/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: title,
      files: { 'document.md': { content } },
    }),
  });
  return res.json();
}

export async function deleteGist(id: string): Promise<void> {
  await apiFetch(`/gists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
