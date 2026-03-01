import { Edit } from 'lucide-react';
import type { GitHubUser } from '../github';

interface ProfileViewProps {
  user: GitHubUser;
}

export function ProfileView({ user }: ProfileViewProps) {
  return (
    <div class="account-view">
      <h1>Profile</h1>
      <div class="account-panel account-user-panel">
        <div class="account-user-header">
          <a
            class="account-user-avatar-link"
            href="https://github.com/settings/profile"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Change avatar on GitHub"
          >
            <img class="account-user-avatar" src={user.avatar_url} alt="" width={56} height={56} />
            <span class="account-user-avatar-overlay" aria-hidden="true">
              <Edit size={14} />
            </span>
          </a>
          <div class="account-user-meta">
            <div class="account-user-name">{user.name ?? 'No display name'}</div>
            <div class="account-user-login">@{user.login}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
