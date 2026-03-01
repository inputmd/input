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
  notice: string | null;
  onDismissNotice: () => void;
}

export function SettingsView({
  user,
  installationId,
  availableRepos,
  repoListLoading,
  onLoadRepos,
  onConnect,
  onDisconnect,
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
      <div class="settings-panel">
        <div class="settings-panel-header">
          <h2 class="settings-panel-title">Connected GitHub repos</h2>
          <div class="settings-actions">
            <button type="button" class="settings-connect-btn" onClick={() => void onConnect()}>
              Connect
            </button>
            <button type="button" onClick={() => void onDisconnect()} disabled={!installationId}>
              Disconnect
            </button>
          </div>
        </div>
        <table class="settings-repo-table">
          <tbody>
            {repoListLoading ? (
              <tr>
                <td>Loading repos...</td>
              </tr>
            ) : availableRepos.length > 0 ? (
              availableRepos.map((repo) => (
                <tr key={repo.id}>
                  <td>
                    <a href={repo.html_url} target="_blank" rel="noopener noreferrer">
                      {repo.full_name}
                    </a>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td>No connected repos</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
