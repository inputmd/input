import type { GitHubUser } from '../github';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';

export type ActiveView = 'auth' | 'documents' | 'githubapp' | 'repodocuments' | 'loading' | 'error' | 'content' | 'edit';

interface ToolbarProps {
  view: ActiveView;
  user: GitHubUser | null;
  installationId: string | null;
  selectedRepo: string | null;
  currentGistId: string | null;
  currentRepoDocPath: string | null;
  currentFileName: string | null;
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
  currentGistId, currentRepoDocPath, currentFileName, theme, saving,
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
        {currentFileName && (view === 'content' || view === 'edit') && (
          <span class="current-filename">{currentFileName}</span>
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
            <button type="button" onClick={() => navigate('auth')}>Sign in</button>
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
          <Tooltip.Provider delayDuration={250}>
            <DropdownMenu.Root>
              <Tooltip.Root>
                <DropdownMenu.Trigger asChild>
                  <Tooltip.Trigger asChild>
                    <button type="button" class="user-menu-trigger" aria-label="User menu">
                      <img class="user-avatar" src={user.avatar_url} alt="" width={24} height={24} />
                      <span class="user-name">{user.name ?? user.login}</span>
                    </button>
                  </Tooltip.Trigger>
                </DropdownMenu.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content class="toolbar-tooltip" side="bottom" align="end" sideOffset={6}>
                    User menu
                    <Tooltip.Arrow class="toolbar-tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="user-menu-content" sideOffset={6} align="end">
                  <DropdownMenu.Label class="user-menu-label">{user.login}</DropdownMenu.Label>
                  <DropdownMenu.Separator class="user-menu-separator" />
                  <Popover.Root>
                    <Popover.Trigger asChild>
                      <DropdownMenu.Item
                        class="user-menu-item"
                        onSelect={(e: Event) => e.preventDefault()}
                      >
                        Account Details
                      </DropdownMenu.Item>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content class="user-popover-content" side="left" align="start" sideOffset={8}>
                        <div class="user-popover-row">
                          <img class="user-avatar" src={user.avatar_url} alt="" width={32} height={32} />
                          <div class="user-popover-meta">
                            <div>{user.name ?? user.login}</div>
                            <div>@{user.login}</div>
                          </div>
                        </div>
                        <Popover.Arrow class="user-popover-arrow" />
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                  <DropdownMenu.Separator class="user-menu-separator" />
                  <DropdownMenu.Item class="user-menu-item" onSelect={() => onSignOut()}>
                    Sign Out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </Tooltip.Provider>
        ) : !showSignInToSave && view !== 'auth' ? (
          <button type="button" onClick={() => navigate('auth')}>Sign In</button>
        ) : null}
      </div>
    </header>
  );
}
