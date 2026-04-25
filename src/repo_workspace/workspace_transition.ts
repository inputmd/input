import { safeDecodeURIComponent } from '../path_utils.ts';
import type { Route } from '../routing';

export const WORKSPACE_NONE_KEY = 'workspace:none';
export const WORKSPACE_EXTERNAL_KEY = 'workspace:external';

function normalizeWorkspaceKeyForComparison(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return WORKSPACE_NONE_KEY;
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex === -1) return trimmed.toLowerCase();
  const prefix = trimmed.slice(0, separatorIndex).toLowerCase();
  const value = trimmed.slice(separatorIndex + 1);
  if (prefix === 'repo' || prefix === 'public' || prefix === 'shared' || prefix === 'share') {
    return `${prefix}:${value.toLowerCase()}`;
  }
  return `${prefix}:${value}`;
}

export function workspaceKeysMatch(left: string, right: string): boolean {
  return normalizeWorkspaceKeyForComparison(left) === normalizeWorkspaceKeyForComparison(right);
}

export function workspaceKeyFromRoute(route: Route): string {
  switch (route.name) {
    case 'gist':
    case 'edit':
      return `gist:${route.params.id}`;
    case 'repodocuments':
    case 'repofile':
    case 'reponew':
    case 'repoedit':
      return `repo:${safeDecodeURIComponent(route.params.owner)}/${safeDecodeURIComponent(route.params.repo)}`;
    case 'sharefile':
      return `share:${safeDecodeURIComponent(route.params.owner)}/${safeDecodeURIComponent(route.params.repo)}`;
    case 'sharetoken':
      return `share:${route.params.token}`;
    case 'home':
    case 'new':
    case 'workspaces':
      return WORKSPACE_NONE_KEY;
  }
}

export function isWorkspaceTransition(currentWorkspaceKey: string, nextWorkspaceKey: string): boolean {
  return !workspaceKeysMatch(currentWorkspaceKey, nextWorkspaceKey);
}
