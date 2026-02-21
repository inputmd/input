import type { GitHubUser } from '../github';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ExternalLink, Menu } from 'lucide-react';

export type ActiveView = 'auth' | 'documents' | 'githubapp' | 'repodocuments' | 'loading' | 'error' | 'content' | 'edit';

interface ToolbarProps {
  view: ActiveView;
  user: GitHubUser | null;
  installationId: string | null;
  selectedRepo: string | null;
  currentGistId: string | null;
  currentRepoDocPath: string | null;
  currentFileName: string | null;
  saving: boolean;
  canSave: boolean;
  showSave: boolean;
  navigate: (route: string) => void;
  onSignOut: () => void;
  onToggleTheme: () => void;
  onSave: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

export function Toolbar({
  view, user, installationId, selectedRepo,
  currentGistId, currentRepoDocPath, currentFileName, saving, canSave, showSave,
  navigate, onSignOut, onToggleTheme,
  onSave, onEdit, onCancel, onDelete,
}: ToolbarProps) {
  const isRepoFile = view === 'content' && currentRepoDocPath !== null;
  const isOwnedGist = view === 'content' && user !== null && currentGistId !== null;
  const showViewOriginal = view === 'content' && currentGistId !== null;

  const isHomeDraft = view === 'edit' && currentGistId === null && currentRepoDocPath === null;
  const showEdit = isRepoFile || isOwnedGist;
  const showDelete = isOwnedGist;
  const showCancel = view === 'edit' && !isHomeDraft;
  const showSignInToSave = isHomeDraft && !user;
  const showGitHubApp = !!installationId;
  const showRepoDocs = !!selectedRepo;
  const showDocumentActions = !!currentFileName && (showEdit || showDelete || showViewOriginal);

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        {showGitHubApp && (
          <button type="button" onClick={() => navigate('githubapp')}>GitHub App</button>
        )}
        {showRepoDocs && (
          <button type="button" onClick={() => navigate('repodocuments')}>Repo Docs</button>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              class={`document-menu-trigger${showDocumentActions ? '' : ' document-menu-trigger-caret'}`}
              aria-label="Document menu"
            >
              {showDocumentActions ? currentFileName : <Menu size={16} aria-hidden="true" />}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="document-menu-content" sideOffset={6} align="start">
              <DropdownMenu.Item class="user-menu-item" onSelect={() => navigate('new')}>
                New Wiki
              </DropdownMenu.Item>
              {showDocumentActions && <DropdownMenu.Separator class="user-menu-separator" />}
              {showViewOriginal && (
                <DropdownMenu.Item
                  class="user-menu-item user-menu-item-with-icon"
                  onSelect={() => window.open(`https://gist.github.com/${currentGistId}`, '_blank', 'noopener,noreferrer')}
                >
                  View Gist
                  <ExternalLink size={14} aria-hidden="true" />
                </DropdownMenu.Item>
              )}
              {showEdit && (
                <DropdownMenu.Item class="user-menu-item" onSelect={onEdit}>
                  Edit
                </DropdownMenu.Item>
              )}
              {showDelete && (
                <>
                  {(showViewOriginal || showEdit) && <DropdownMenu.Separator class="user-menu-separator" />}
                  <DropdownMenu.Item class="user-menu-item document-menu-item-danger" onSelect={onDelete}>
                    Delete
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div class="toolbar-right">
        <div class="action-buttons">
          {showCancel && (
            <button type="button" onClick={onCancel}>Cancel</button>
          )}
          {showSignInToSave && (
            <button type="button" onClick={() => navigate('auth')}>Sign in</button>
          )}
        </div>
        {showSave && (
          <div class="header-save-actions">
            <button type="button" onClick={onSave} disabled={saving || !canSave}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
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
                  <DropdownMenu.Item class="user-menu-item" onSelect={() => navigate('documents')}>
                    My Wikis
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="user-menu-separator" />
                  <DropdownMenu.Item class="user-menu-item" onSelect={() => onToggleTheme()}>
                    Toggle Theme
                  </DropdownMenu.Item>
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
