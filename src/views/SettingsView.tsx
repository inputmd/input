import { useEffect } from 'preact/hooks';
import { Edit } from 'lucide-react';
import type { GitHubUser } from '../github';
import type { InstallationRepo } from '../github_app';

interface SettingsViewProps {
  user: GitHubUser;
  installationId: string | null;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  onLoadRepos: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenRepo: (fullName: string, id: number, isPrivate: boolean) => void;
  notice: string | null;
  onDismissNotice: () => void;
}

function formatRepoMeta(repo: InstallationRepo): string {
  const permissionEntries = repo.permissions ? Object.entries(repo.permissions).filter(([, allowed]) => allowed) : [];
  const permissionsLabel =
    permissionEntries.length > 0
      ? `Permissions: ${permissionEntries.map(([name]) => name).join(', ')}`
      : 'Permissions: unavailable';
  const visibilityLabel = repo.private ? 'Private' : 'Public';
  return `${visibilityLabel} · ${permissionsLabel} · ID ${repo.id}`;
}

export function SettingsView({
  user,
  installationId,
  availableRepos,
  repoListLoading,
  onLoadRepos,
  onConnect,
  onDisconnect,
  onOpenRepo,
  notice,
  onDismissNotice,
}: SettingsViewProps) {
  useEffect(() => {
    onLoadRepos();
  }, [onLoadRepos]);

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
      <h1>Settings</h1>
      <div class="settings-panel">
        <div class="settings-user-header">
          <a
            class="settings-user-avatar-link"
            href="https://github.com/settings/profile"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Change avatar on GitHub"
          >
            <img class="settings-user-avatar" src={user.avatar_url} alt="" width={72} height={72} />
            <span class="settings-user-avatar-overlay" aria-hidden="true">
              <Edit size={14} />
            </span>
          </a>
          <div class="settings-user-meta">
            <div class="settings-user-name">{user.name ?? 'No display name'}</div>
            <div class="settings-user-login">@{user.login}</div>
          </div>
        </div>
      </div>
      <div class="settings-repos-header">
        <h2 class="settings-repos-title">Connected Repos</h2>
        <div class="settings-actions">
          <button type="button" class="settings-connect-btn" onClick={() => void onConnect()}>
            Connect
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
    </div>
  );
}
