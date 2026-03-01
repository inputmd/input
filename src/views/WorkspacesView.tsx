import { useEffect } from 'preact/hooks';
import type { GistSummary } from '../github';
import type { InstallationRepo } from '../github_app';
import { DocumentsView } from './DocumentsView';

interface WorkspacesViewProps {
  installationId: string | null;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  onLoadRepos: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenRepo: (fullName: string, id: number, isPrivate: boolean) => void;
  reposInitialLoaded: boolean;
  gistsInitialLoaded: boolean;
  initialGists: GistSummary[];
  navigate: (route: string) => void;
  userLogin: string;
  notice: string | null;
  onDismissNotice: () => void;
}

function formatRepoMeta(repo: InstallationRepo): string {
  return repo.private ? 'Private' : 'Public';
}

export function WorkspacesView({
  installationId,
  availableRepos,
  repoListLoading,
  onLoadRepos,
  onConnect,
  onDisconnect,
  onOpenRepo,
  reposInitialLoaded,
  gistsInitialLoaded,
  initialGists,
  navigate,
  userLogin,
  notice,
  onDismissNotice,
}: WorkspacesViewProps) {
  useEffect(() => {
    onLoadRepos();
  }, [onLoadRepos]);

  const sectionsReady = reposInitialLoaded && gistsInitialLoaded;

  return (
    <div class="settings-view">
      {notice ? (
        <div class="settings-alert" role="status">
          <span>{notice}</span>
          <button type="button" class="settings-alert-close" aria-label="Dismiss notice" onClick={onDismissNotice}>
            ×
          </button>
        </div>
      ) : null}
      <h1>Workspaces</h1>
      {sectionsReady ? (
        <>
          <div class="settings-repos-header">
            <div class="settings-repos-header-copy">
              <h2 class="settings-repos-title">My Repos</h2>
              <p class="hint settings-repos-subtitle">Workspaces stored as repos on GitHub</p>
            </div>
            <div class="settings-actions">
              <button type="button" class="settings-connect-btn" onClick={() => void onConnect()}>
                Configure
              </button>
              <button type="button" onClick={() => void onDisconnect()} disabled={!installationId}>
                Disconnect
              </button>
            </div>
          </div>
          {repoListLoading ? (
            <p class="loading-hint">Loading repos...</p>
          ) : availableRepos.length > 0 ? (
            <div class="settings-repo-list">
              {availableRepos.map((repo) => (
                <div class="settings-repo-card" key={repo.id}>
                  <div class="settings-repo-info">
                    <div class="settings-repo-title">{repo.full_name}</div>
                    <div class="settings-repo-meta">{formatRepoMeta(repo)}</div>
                  </div>
                  <div class="settings-repo-actions">
                    <button type="button" onClick={() => onOpenRepo(repo.full_name, repo.id, repo.private)}>
                      Open
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div class="empty-state settings-empty-state">
              <p>No connected repos</p>
              <p>Connect a repository to start editing docs.</p>
            </div>
          )}
          <DocumentsView navigate={navigate} userLogin={userLogin} embedded initialGists={initialGists} initialLoaded />
        </>
      ) : (
        <p class="loading-hint">Loading repos and gists...</p>
      )}
    </div>
  );
}
