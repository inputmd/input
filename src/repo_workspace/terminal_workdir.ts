import type { PublicRepoRef } from '../wiki_links.ts';
import type { RepoAccessMode } from './types.ts';

interface BuildTerminalWorkdirNameArgs {
  currentGistId: string | null;
  repoAccessMode: RepoAccessMode;
  selectedRepo: string | null;
  publicRepoRef: PublicRepoRef | null;
}

function sanitizeTerminalWorkdirName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return sanitized || 'workspace';
}

export function buildTerminalWorkdirName({
  currentGistId,
  repoAccessMode,
  selectedRepo,
  publicRepoRef,
}: BuildTerminalWorkdirNameArgs): string {
  if (currentGistId) return 'gist';
  if ((repoAccessMode === 'installed' || repoAccessMode === 'shared') && selectedRepo) {
    const repoName = selectedRepo.split('/').filter(Boolean).at(-1) ?? selectedRepo;
    return sanitizeTerminalWorkdirName(repoName);
  }
  if (repoAccessMode === 'public' && publicRepoRef) {
    return sanitizeTerminalWorkdirName(publicRepoRef.repo);
  }
  return 'workspace';
}
