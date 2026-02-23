import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { GitHubUser } from '../github';
import { routePath } from '../routing';

export type ActiveView =
  | 'auth'
  | 'documents'
  | 'githubapp'
  | 'repodocuments'
  | 'loading'
  | 'error'
  | 'content'
  | 'edit';

interface ToolbarProps {
  view: ActiveView;
  user: GitHubUser | null;
  installationId: string | null;
  selectedRepo: string | null;
  draftMode: boolean;
  canToggleSidebar: boolean;
  sidebarVisible: boolean;
  showEdit: boolean;
  navigate: (route: string) => void;
  onSignOut: () => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onEdit: () => void;
}

export function Toolbar({
  view,
  user,
  installationId,
  selectedRepo,
  draftMode,
  canToggleSidebar,
  sidebarVisible,
  showEdit,
  navigate,
  onSignOut,
  onToggleTheme,
  onToggleSidebar,
  onEdit,
}: ToolbarProps) {
  const isHomeDraft = view === 'edit' && draftMode;
  const showSignInToSave = isHomeDraft && !user;
  const showGitHubApp = !!installationId;
  const showRepoDocs = !!selectedRepo;

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        {showGitHubApp && (
          <button type="button" onClick={() => navigate(routePath.githubApp())}>
            GitHub App
          </button>
        )}
        {showRepoDocs && (
          <button type="button" onClick={() => navigate(routePath.repoDocuments())}>
            Repo Docs
          </button>
        )}
        {isHomeDraft ? (
          <span class="document-menu-label">New Wiki</span>
        ) : canToggleSidebar ? (
          <button
            type="button"
            class="document-menu-trigger"
            onClick={onToggleSidebar}
            aria-label={sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar'}
            title={sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar'}
          >
            {sidebarVisible ? (
              <PanelLeftClose size={20} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={20} aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
      <div class="toolbar-right">
        <div class="action-buttons">
          {showEdit && (
            <button type="button" onClick={onEdit}>
              Edit
            </button>
          )}
          {showSignInToSave && (
            <button type="button" onClick={() => navigate(routePath.auth())}>
              Sign in
            </button>
          )}
        </div>
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
                  {view !== 'documents' ? (
                    <>
                      <DropdownMenu.Item class="user-menu-item" onSelect={() => navigate(routePath.documents())}>
                        My Wikis
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator class="user-menu-separator" />
                    </>
                  ) : null}
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
          <button type="button" onClick={() => navigate(routePath.auth())}>
            Sign In
          </button>
        ) : null}
      </div>
    </header>
  );
}
