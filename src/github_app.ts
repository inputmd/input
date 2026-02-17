const INSTALLATION_ID_KEY = 'github_app_installation_id';

export function getInstallationId(): string | null {
  return localStorage.getItem(INSTALLATION_ID_KEY);
}

export function setInstallationId(id: string): void {
  localStorage.setItem(INSTALLATION_ID_KEY, id);
}

export function clearInstallationId(): void {
  localStorage.removeItem(INSTALLATION_ID_KEY);
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

