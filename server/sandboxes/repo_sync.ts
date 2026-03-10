import { githubFetchWithInstallationToken } from '../github_client';

export async function getRepoDefaultBranch(
  installationId: string,
  owner: string,
  repo: string,
): Promise<{ defaultBranch: string; sizeKb: number }> {
  const res = await githubFetchWithInstallationToken(
    installationId,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  const data = (await res.json()) as { default_branch: string; size: number };
  return { defaultBranch: data.default_branch, sizeKb: data.size };
}

export async function getInstallationTokenForClone(installationId: string): Promise<string> {
  const { createAppJwt } = await import('../github_client');
  const jwt = await createAppJwt();
  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'input-github-app-auth-server',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to mint installation token: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

export function buildCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
}

export async function verifyInstallationRepoAccess(
  installationId: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    await githubFetchWithInstallationToken(
      installationId,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    return true;
  } catch {
    return false;
  }
}
