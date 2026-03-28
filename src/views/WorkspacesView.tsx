import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ExternalLink, Globe, Lock, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GistSummary } from '../github';
import type { InstallationRepo } from '../github_app';
import { DocumentsView } from './DocumentsView';

const CONNECT_REPOS_LABEL = 'Install';

function blurOnClose(open: boolean): void {
  if (!open) (document.activeElement as HTMLElement | null)?.blur?.();
}

interface WorkspacesViewProps {
  installationId: string | null;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  reposLoadError: string | null;
  gists: GistSummary[];
  gistsLoading: boolean;
  gistsAllLoaded: boolean;
  gistsLoadError: string | null;
  onLoadRepos: (mode: 'auto' | 'manual') => void;
  onRetryRepos: () => void | Promise<void>;
  onRetryGists: () => void | Promise<void>;
  onRetryGistsSignIn: () => void;
  onLoadMoreGists: () => void;
  onRenameGist: (gist: GistSummary) => void | Promise<void>;
  onDeleteGist: (gist: GistSummary) => void | Promise<void>;
  onConnect: () => void;
  onDisconnectCurrentInstallation: () => void | Promise<void>;
  onDisconnect: () => void;
  onOpenRepo: (fullName: string, id: number, isPrivate: boolean) => void;
  reposInitialLoaded: boolean;
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
  gists,
  gistsLoading,
  gistsAllLoaded,
  gistsLoadError,
  onLoadRepos,
  onRetryRepos,
  onRetryGists,
  onRetryGistsSignIn,
  onLoadMoreGists,
  onRenameGist,
  onDeleteGist,
  onConnect,
  onDisconnectCurrentInstallation,
  onDisconnect,
  onOpenRepo,
  reposInitialLoaded,
  navigate,
  userLogin,
  workspaceNotice,
  onDismissWorkspaceNotice,
}: WorkspacesViewProps) {
  const didAutoLoadRef = useRef(false);
  const [retryingRepos, setRetryingRepos] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  useEffect(() => {
    if (didAutoLoadRef.current) return;
    didAutoLoadRef.current = true;
    onLoadRepos('auto');
  }, [onLoadRepos]);

  const handleRetryRepos = async () => {
    setRetryingRepos(true);
    try {
      await onRetryRepos();
    } finally {
      setRetryingRepos(false);
    }
  };

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
            {CONNECT_REPOS_LABEL}
          </button>
          <DropdownMenu.Root open={actionsMenuOpen} onOpenChange={(open: boolean) => { setActionsMenuOpen(open); blurOnClose(open); }}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                class="doc-actions-menu-trigger workspaces-installation-trigger"
                aria-label="Workspace actions"
                title="Workspace actions"
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="doc-actions-menu-content" sideOffset={6} align="end">
                {installationId ? (
                  <DropdownMenu.Item
                    class="doc-actions-menu-item"
                    onSelect={(event: Event) => {
                      event.preventDefault();
                      setActionsMenuOpen(false);
                      void onDisconnectCurrentInstallation();
                    }}
                  >
                    Disconnect current installation
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item
                  class="doc-actions-menu-item doc-actions-menu-item-danger"
                  onSelect={(event: Event) => {
                    event.preventDefault();
                    setActionsMenuOpen(false);
                    void onDisconnect();
                  }}
                >
                  Disconnect all repos
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      {repoListLoading && !reposLoadError ? (
        <p class="loading-hint">Loading...</p>
      ) : reposLoadError ? (
        <div class="empty-state workspaces-empty-state">
          <p>Failed to load repos</p>
          <p class="hint">{reposLoadError}</p>
          <button
            type="button"
            onClick={() => void handleRetryRepos()}
            disabled={retryingRepos}
            aria-busy={retryingRepos}
          >
            {retryingRepos ? <span class="documents-button-spinner" aria-hidden="true" /> : null}
            {retryingRepos ? 'Retrying Repos...' : 'Retry Repos'}
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
          <p>This app must be installed on a GitHub repo.</p>
          <p>
            <a href="https://github.com/new" target="_blank" rel="noopener noreferrer">
              Create a repo
            </a>{' '}
            {`and select "${CONNECT_REPOS_LABEL}" to get started.`}
          </p>
        </div>
      )}
      <DocumentsView
        navigate={navigate}
        userLogin={userLogin}
        gists={gists}
        loading={gistsLoading}
        allLoaded={gistsAllLoaded}
        error={gistsLoadError}
        embedded
        onRetry={onRetryGists}
        onRetrySignIn={onRetryGistsSignIn}
        onLoadMore={onLoadMoreGists}
        onRename={onRenameGist}
        onDelete={onDeleteGist}
      />
    </div>
  );
}
