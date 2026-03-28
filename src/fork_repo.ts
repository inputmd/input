import type { InstallationRepo, LinkedInstallation } from './github_app';

export function resolveForkTargetInstallationId(
  installations: LinkedInstallation[],
  preferredInstallationId: string | null | undefined,
): string | null {
  if (
    preferredInstallationId &&
    installations.some((installation) => installation.installationId === preferredInstallationId)
  ) {
    return preferredInstallationId;
  }
  return installations[0]?.installationId ?? null;
}

export function resolveForkTargetRepoFullName(
  repos: InstallationRepo[],
  options?: {
    preferredRepoFullName?: string | null;
  },
): string {
  const preferredRepoFullName = options?.preferredRepoFullName?.trim();
  if (preferredRepoFullName) {
    const matchingRepo = repos.find((repo) => repo.full_name.toLowerCase() === preferredRepoFullName.toLowerCase());
    if (matchingRepo) return matchingRepo.full_name;
  }
  return repos[0]?.full_name ?? '';
}
