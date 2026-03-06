import { ExternalLink, Globe, Lock } from 'lucide-react';
import { useEffect, useRef } from 'preact/hooks';
import type { GistSummary } from '../github';
import type { InstallationRepo } from '../github_app';
import { DocumentsView } from './DocumentsView';

interface WorkspacesViewProps {
  installationId: string | null;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  reposLoadError: string | null;
  gistsLoadError: string | null;
  onLoadRepos: (mode: 'auto' | 'manual') => void;
  onRetryRepos: () => void;
  onRetryGists: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenRepo: (fullName: string, id: number, isPrivate: boolean) => void;
  reposInitialLoaded: boolean;
  gistsInitialLoaded: boolean;
  initialGists: GistSummary[];
  navigate: (route: string) => void;
  userLogin: string;
  workspaceNotice: string | null;
  onDismissWorkspaceNotice: () => void;
}

function formatRepoMeta(repo: InstallationRepo): string {
  return repo.private ? 'Private' : 'Public';
}

export function WorkspacesView({
  installationId,
  availableRepos,
  repoListLoading,
  reposLoadError,
  gistsLoadError,
  onLoadRepos,
  onRetryRepos,
  onRetryGists,
  onConnect,
  onDisconnect,
  onOpenRepo,
  reposInitialLoaded,
  gistsInitialLoaded,
  initialGists,
  navigate,
  userLogin,
  workspaceNotice,
  onDismissWorkspaceNotice,
}: WorkspacesViewProps) {
  const didAutoLoadRef = useRef(false);
  useEffect(() => {
    if (didAutoLoadRef.current) return;
    didAutoLoadRef.current = true;
    onLoadRepos('auto');
  }, [onLoadRepos]);

  return (
    <div class="account-view">
      {workspaceNotice ? (
        <div class="workspaces-alert" role="status">
          <span>{workspaceNotice}</span>
          <button
            type="button"
            class="workspaces-alert-close"
            aria-label="Dismiss notice"
            onClick={onDismissWorkspaceNotice}
          >
            ×
          </button>
        </div>
      ) : null}
      <div class="workspaces-repos-header">
        <div class="workspaces-repos-header-copy">
          <h2 class="workspaces-repos-title">My Repos</h2>
          <p class="hint workspaces-repos-subtitle">Workspaces stored as repos on GitHub</p>
        </div>
        <div class="workspaces-actions">
          <button type="button" class="workspaces-connect-btn" onClick={() => void onConnect()}>
            Configure
          </button>
          <button type="button" onClick={() => void onDisconnect()} disabled={!installationId}>
            Disconnect
          </button>
        </div>
      </div>
      {repoListLoading ? (
        <p class="loading-hint">Loading...</p>
      ) : reposLoadError ? (
        <div class="empty-state workspaces-empty-state">
          <p>Failed to load repos.</p>
          <p class="hint">{reposLoadError}</p>
          <button type="button" onClick={() => void onRetryRepos()}>
            Retry Repos
          </button>
        </div>
      ) : installationId && !reposInitialLoaded ? (
        <div class="empty-state workspaces-empty-state">
          <p>Repos are not loaded yet.</p>
          <button type="button" onClick={() => void onRetryRepos()}>
            Load Repos
          </button>
        </div>
      ) : availableRepos.length > 0 ? (
        <div class="workspaces-repo-list">
          {availableRepos.map((repo) => (
            <div class="workspaces-repo-card" key={repo.id}>
              <div class="workspaces-repo-info">
                <div class="workspaces-repo-title">
                  {repo.private ? (
                    <Lock size={14} class="workspaces-repo-visibility-icon" aria-hidden="true" />
                  ) : (
                    <Globe size={14} class="workspaces-repo-visibility-icon" aria-hidden="true" />
                  )}
                  <span>{repo.full_name}</span>
                </div>
                <div class="workspaces-repo-meta">{formatRepoMeta(repo)}</div>
              </div>
              <div class="workspaces-repo-actions">
                <button type="button" onClick={() => onOpenRepo(repo.full_name, repo.id, repo.private)}>
                  Open
                </button>
                <button
                  type="button"
                  class="workspaces-repo-open-github-btn"
                  aria-label={`Open ${repo.full_name} on GitHub`}
                  title="Open on GitHub"
                  onClick={() => window.open(`https://github.com/${repo.full_name}`, '_blank', 'noopener,noreferrer')}
                >
                  <ExternalLink size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div class="empty-state workspaces-empty-state">
          <p>No connected repos yet.</p>
          <p>
            <a href="https://github.com/new" target="_blank" rel="noopener noreferrer">
              Create a repo
            </a>{' '}
            and select "Configure" to get started.
          </p>
        </div>
      )}
      {gistsLoadError ? (
        <div class="empty-state workspaces-empty-state">
          <p>Failed to load gists.</p>
          <p class="hint">{gistsLoadError}</p>
          <button type="button" onClick={() => void onRetryGists()}>
            Retry Gists
          </button>
        </div>
      ) : null}
      <DocumentsView
        navigate={navigate}
        userLogin={userLogin}
        embedded
        initialGists={initialGists}
        initialLoaded={gistsInitialLoaded}
      />
    </div>
  );
}
