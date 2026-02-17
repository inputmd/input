import type { GitHubUser } from '../github';

export type ActiveView = 'auth' | 'documents' | 'githubapp' | 'repodocuments' | 'loading' | 'error' | 'content' | 'edit';

interface ToolbarProps {
  view: ActiveView;
  user: GitHubUser | null;
  installationId: string | null;
  selectedRepo: string | null;
  currentGistId: string | null;
  currentRepoDocPath: string | null;
  theme: 'dark' | 'light';
  saving: boolean;
  navigate: (route: string) => void;
  onSignOut: () => void;
  onToggleTheme: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

export function Toolbar({
  view, user, installationId, selectedRepo,
  currentGistId, currentRepoDocPath, theme, saving,
  navigate, onSignOut, onToggleTheme,
  onEdit, onSave, onCancel, onDelete,
}: ToolbarProps) {
  const isRepoFile = view === 'content' && currentRepoDocPath !== null;
  const isOwnedGist = view === 'content' && user !== null && currentGistId !== null;

  const isHomeDraft = view === 'edit' && currentGistId === null && currentRepoDocPath === null;
  const showEdit = isRepoFile || isOwnedGist;
  const showDelete = isOwnedGist;
  const showSave = view === 'edit' && !(isHomeDraft && !user);
  const showCancel = view === 'edit' && !isHomeDraft;
  const showSignInToSave = isHomeDraft && !user;
  const showDocs = !!user;
  const showHome = true;
  const showGitHubApp = !!installationId;
  const showRepoDocs = !!selectedRepo;

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        {showHome && (
          <button type="button" onClick={() => navigate('')}>Home</button>
        )}
        {showDocs && (
          <button type="button" onClick={() => navigate('documents')}>My Gists</button>
        )}
        {showGitHubApp && (
          <button type="button" onClick={() => navigate('githubapp')}>GitHub App</button>
        )}
        {showRepoDocs && (
          <button type="button" onClick={() => navigate('repodocuments')}>Repo Docs</button>
        )}
      </div>
      <div class="toolbar-right">
        <div class="action-buttons">
          {showEdit && (
            <button type="button" onClick={onEdit}>Edit</button>
          )}
          {showSave && (
            <button type="button" onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          {showCancel && (
            <button type="button" onClick={onCancel}>Cancel</button>
          )}
          {showDelete && (
            <button type="button" class="delete-btn" onClick={onDelete}>Delete</button>
          )}
          {showSignInToSave && (
            <button type="button" onClick={() => navigate('auth')}>Sign in to save</button>
          )}
        </div>
        {view === 'content' && currentGistId && (
          <a
            class="view-original-btn"
            href={`https://gist.github.com/${currentGistId}`}
            target="_blank"
            rel="noopener noreferrer"
          >View Original</a>
        )}
        <button type="button" class="theme-toggle" title="Toggle theme" onClick={onToggleTheme}>
          <span>{theme === 'dark' ? '\u2600' : '\u263D'}</span>
        </button>
        {user ? (
          <div class="user-info">
            <img class="user-avatar" src={user.avatar_url} alt="" width={24} height={24} />
            <span class="user-name">{user.name ?? user.login}</span>
            <button type="button" onClick={onSignOut}>Sign Out</button>
          </div>
        ) : !showSignInToSave && view !== 'auth' ? (
          <button type="button" onClick={() => navigate('auth')}>Sign In</button>
        ) : null}
      </div>
    </header>
  );
}
