import type { GitHubUser } from '../github';

interface SettingsViewProps {
  user: GitHubUser;
}

export function SettingsView({ user }: SettingsViewProps) {
  return (
    <div class="settings-view">
      <h1>Settings</h1>
      <div class="settings-panel">
        <div class="settings-user-header">
          <img class="settings-user-avatar" src={user.avatar_url} alt="" width={72} height={72} />
          <div class="settings-user-meta">
            <div class="settings-user-name">{user.name ?? 'No display name'}</div>
            <div class="settings-user-login">@{user.login}</div>
          </div>
        </div>
        <dl class="settings-user-fields">
          <div class="settings-user-row">
            <dt>GitHub profile</dt>
            <dd>
              <a href={`https://github.com/${user.login}`} target="_blank" rel="noopener noreferrer">
                github.com/{user.login}
              </a>
            </dd>
          </div>
          <div class="settings-user-row">
            <dt>Avatar</dt>
            <dd>
              <a href="https://github.com/settings/profile" target="_blank" rel="noopener noreferrer">
                Change avatar on GitHub
              </a>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
