import type { LinkedInstallation } from '../github_app';
import type { PublicRepoRef } from '../wiki_links';
import type { RepoAccessMode } from './types';

export type PersistedHomeMode = 'include' | 'exclude';

export type PersistedHomeTrustTarget = 'gist' | 'repo' | 'workspace';

export interface PersistedHomeTrustPrompt {
  storageKey: string;
  target: PersistedHomeTrustTarget;
  title: string;
  message: string;
  note: string | null;
  defaultMode: PersistedHomeMode;
  trustResolved: boolean;
}

export interface PersistedHomeTrustAccess {
  canConfigure: boolean;
  prompt: PersistedHomeTrustPrompt | null;
}

export interface PersistedHomeSessionTransition {
  captureActiveSessionState: boolean;
  includePersistedHomeSync: boolean;
  enableNetworkingBridge: boolean;
  nextSessionMode: PersistedHomeMode;
}

export type PersistedHomeTransitionReason = 'reconfigure' | 'standard';

const PERSISTED_HOME_TRUST_DECISION_KEY_PREFIX = 'input:terminal-persisted-home-trust:';

function buildPersistedHomeTrustStorageKey(args: {
  currentGistId: string | null;
  repoRef: PublicRepoRef | null;
  userLogin: string | null;
  workspaceKey: string;
}): string {
  const normalizedUserLogin = args.userLogin?.trim().toLowerCase();
  const storageScope = normalizedUserLogin ? `user:${normalizedUserLogin}` : 'anon:session';
  if (args.repoRef) {
    return `${storageScope}:repo:${args.repoRef.owner.toLowerCase()}/${args.repoRef.repo.toLowerCase()}`;
  }
  if (args.currentGistId !== null) {
    return `${storageScope}:gist:${args.currentGistId}`;
  }
  return `${storageScope}:workspace:${args.workspaceKey}`;
}

function buildPersistedHomeTrustMessage(target: 'gist' | 'repo' | 'workspace'): string {
  if (target === 'repo') {
    return 'Sync your coding agent credentials with those stored in the browser? Only do this with trusted repos.';
  }
  if (target === 'gist') {
    return 'Trust this gist to sync your credentials and stage workspace home files in this terminal.';
  }
  return 'Trust this workspace to sync your credentials and stage workspace home files in this terminal.';
}

export function readPersistedHomeTrustDecision(storageKey: string): PersistedHomeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const storedValue = window.localStorage.getItem(`${PERSISTED_HOME_TRUST_DECISION_KEY_PREFIX}${storageKey}`);
    return storedValue === 'include' || storedValue === 'exclude' ? storedValue : null;
  } catch {
    return null;
  }
}

export function writePersistedHomeTrustDecision(storageKey: string, decision: PersistedHomeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${PERSISTED_HOME_TRUST_DECISION_KEY_PREFIX}${storageKey}`, decision);
  } catch {
    // ignore storage failures
  }
}

export function resolvePersistedHomeSessionTransition(args: {
  activeSessionMode: PersistedHomeMode | null;
  configuredMode: PersistedHomeMode;
  reason?: PersistedHomeTransitionReason;
}): PersistedHomeSessionTransition {
  const captureActiveSessionState =
    args.activeSessionMode === 'include' && !(args.reason === 'reconfigure' && args.configuredMode === 'exclude');
  return {
    captureActiveSessionState,
    includePersistedHomeSync: args.configuredMode === 'include',
    enableNetworkingBridge: true,
    nextSessionMode: args.configuredMode,
  };
}

export function resolvePersistedHomeTrustAccess(args: {
  currentGistId: string | null;
  currentGistOwnerLogin: string | null;
  currentRouteRepoRef: PublicRepoRef | null;
  linkedInstallations: LinkedInstallation[];
  linkedInstallationsLoaded: boolean;
  publicRepoRef: PublicRepoRef | null;
  repoAccessMode: RepoAccessMode;
  selectedRepo: string | null;
  userLogin: string | null;
  workspaceKey: string;
}): PersistedHomeTrustAccess {
  const trustedOwners = new Set<string>();
  const normalizedUserLogin = args.userLogin?.trim().toLowerCase() ?? null;
  if (normalizedUserLogin) trustedOwners.add(normalizedUserLogin);
  for (const installation of args.linkedInstallations) {
    const installationLogin = installation.accountLogin?.trim().toLowerCase();
    if (installationLogin) trustedOwners.add(installationLogin);
  }

  const normalizedGistOwnerLogin = args.currentGistOwnerLogin?.trim().toLowerCase() ?? null;
  const selectedRepoParts = args.selectedRepo?.split('/').filter(Boolean) ?? [];
  const selectedRepoOwner = selectedRepoParts[0] ?? null;
  const selectedRepoName = selectedRepoParts[1] ?? null;
  const repoRef =
    args.repoAccessMode === 'public'
      ? args.publicRepoRef
      : args.repoAccessMode === 'shared'
        ? args.currentRouteRepoRef
        : args.repoAccessMode === 'installed' && selectedRepoOwner && selectedRepoName
          ? { owner: selectedRepoOwner, repo: selectedRepoName }
          : null;
  const normalizedRepoOwner = repoRef?.owner.trim().toLowerCase() ?? null;
  const repoIsTrusted = repoRef !== null && normalizedRepoOwner !== null && trustedOwners.has(normalizedRepoOwner);
  const gistIsTrusted =
    args.currentGistId !== null && normalizedGistOwnerLogin !== null && trustedOwners.has(normalizedGistOwnerLogin);
  const isTrusted = repoIsTrusted || gistIsTrusted || args.workspaceKey === 'workspace:none';

  const target: 'gist' | 'repo' | 'workspace' = repoRef ? 'repo' : args.currentGistId !== null ? 'gist' : 'workspace';
  const trustResolved =
    !normalizedUserLogin ||
    args.workspaceKey === 'workspace:none' ||
    (target === 'repo'
      ? normalizedRepoOwner === null || normalizedRepoOwner === normalizedUserLogin || args.linkedInstallationsLoaded
      : target === 'gist'
        ? normalizedGistOwnerLogin === null ||
          normalizedGistOwnerLogin === normalizedUserLogin ||
          args.linkedInstallationsLoaded
        : true);
  // When the workspace is untrusted and the user is authenticated but has no
  // linked installations, the installation list may still be loading. Show a
  // note so the user knows they can reconfigure later.
  const note =
    !isTrusted && !trustResolved
      ? "If this workspace belongs to an organization you've installed Input on, your organization information may still be loading. You can reconfigure credential sync later from the terminal menu."
      : null;
  return {
    canConfigure: true,
    prompt: {
      storageKey: buildPersistedHomeTrustStorageKey({
        currentGistId: args.currentGistId,
        repoRef,
        userLogin: args.userLogin,
        workspaceKey: args.workspaceKey,
      }),
      target,
      title: 'Configure credential sync',
      message: buildPersistedHomeTrustMessage(target),
      note,
      defaultMode: isTrusted ? 'include' : 'exclude',
      trustResolved,
    },
  };
}
