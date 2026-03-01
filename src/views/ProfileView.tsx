import { Edit } from 'lucide-react';
import type { GitHubUser } from '../github';

interface ProfileViewProps {
  user: GitHubUser;
}

export function ProfileView({ user }: ProfileViewProps) {
  return (
    <div class="settings-view">
      <h1>Profile</h1>
      <div class="settings-panel settings-user-panel">
        <div class="settings-user-header">
          <a
            class="settings-user-avatar-link"
            href="https://github.com/settings/profile"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Change avatar on GitHub"
          >
            <img class="settings-user-avatar" src={user.avatar_url} alt="" width={56} height={56} />
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
    </div>
  );
}
