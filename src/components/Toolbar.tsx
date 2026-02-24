import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Check, ChevronDown, Eye, Globe, Lock, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { GitHubUser } from '../github';
import type { InstallationRepo } from '../github_app';
import { routePath } from '../routing';

export type ActiveView = 'auth' | 'documents' | 'githubapp' | 'loading' | 'error' | 'content' | 'edit';

interface ToolbarProps {
  view: ActiveView;
  user: GitHubUser | null;
  installationId: string | null;
  selectedRepo: string | null;
  selectedRepoPrivate: boolean | null;
  inRepoContext: boolean;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  draftMode: boolean;
  canToggleSidebar: boolean;
  sidebarVisible: boolean;
  showEdit: boolean;
  showPreviewToggle: boolean;
  previewVisible: boolean;
  onTogglePreview: () => void;
  showCancel: boolean;
  onCancel: () => void;
  showSave: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  navigate: (route: string) => void;
  onOpenRepoMenu: () => void;
  onSelectRepo: (fullName: string, id: number, isPrivate: boolean) => void;
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
  selectedRepoPrivate,
  inRepoContext,
  availableRepos,
  repoListLoading,
  draftMode,
  canToggleSidebar,
  sidebarVisible,
  showEdit,
  showPreviewToggle,
  previewVisible,
  onTogglePreview,
  showCancel,
  onCancel,
  showSave,
  saving,
  canSave,
  onSave,
  navigate,
  onOpenRepoMenu,
  onSelectRepo,
  onSignOut,
  onToggleTheme,
  onToggleSidebar,
  onEdit,
}: ToolbarProps) {
  const isHomeDraft = view === 'edit' && draftMode;
  const showSignInToSave = isHomeDraft && !user;
  const showGitHubApp = !!installationId;
  const RepoPrivacyIcon = selectedRepoPrivate ? Lock : Globe;

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        {showGitHubApp && (
          <DropdownMenu.Root
            onOpenChange={(open: boolean) => {
              if (open) onOpenRepoMenu();
            }}
          >
            <DropdownMenu.Trigger asChild>
              <button type="button" class="repo-menu-trigger" aria-label="Navigation menu">
                {inRepoContext && selectedRepo ? (
                  <>
                    <RepoPrivacyIcon size={14} aria-hidden="true" />
                    {selectedRepo}
                  </>
                ) : (
                  'My Gists'
                )}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="repo-menu-content" sideOffset={6} align="start">
                <DropdownMenu.Item class="repo-menu-item" onSelect={() => navigate(routePath.documents())}>
                  <span class="repo-menu-item-main">
                    <span>My Gists</span>
                  </span>
                  {view === 'documents' ? <Check size={14} aria-hidden="true" /> : null}
                </DropdownMenu.Item>
                <DropdownMenu.Separator class="user-menu-separator" />
                {repoListLoading ? (
                  <DropdownMenu.Item class="repo-menu-item" disabled>
                    Loading repos...
                  </DropdownMenu.Item>
                ) : availableRepos.length === 0 ? (
                  <DropdownMenu.Item class="repo-menu-item" disabled>
                    No connected repos
                  </DropdownMenu.Item>
                ) : (
                  availableRepos.map((repo) => {
                    const PrivacyIcon = repo.private ? Lock : Globe;
                    const isSelected = selectedRepo === repo.full_name;
                    return (
                      <DropdownMenu.Item
                        key={repo.id}
                        class="repo-menu-item"
                        onSelect={() => {
                          onSelectRepo(repo.full_name, repo.id, repo.private);
                          navigate(routePath.repoDocuments());
                        }}
                      >
                        <span class="repo-menu-item-main">
                          <PrivacyIcon size={14} aria-hidden="true" />
                          <span>{repo.full_name}</span>
                        </span>
                        {isSelected && inRepoContext ? <Check size={14} aria-hidden="true" /> : null}
                      </DropdownMenu.Item>
                    );
                  })
                )}
                <DropdownMenu.Separator class="user-menu-separator" />
                <DropdownMenu.Item class="repo-menu-item" onSelect={() => navigate(routePath.auth())}>
                  Connect a repo
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        {isHomeDraft ? (
          <span class="document-menu-label">New Document</span>
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
          {showPreviewToggle && (
            <button
              type="button"
              class={`preview-toggle-btn${previewVisible ? '' : ' preview-toggle-btn-off'}`}
              title={previewVisible ? 'Hide preview' : 'Show preview'}
              aria-label={previewVisible ? 'Hide preview' : 'Show preview'}
              onClick={onTogglePreview}
            >
              <Eye size={16} />
            </button>
          )}
          {showCancel && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          {showSave && (
            <button type="button" onClick={onSave} disabled={saving || !canSave}>
              {saving ? 'Saving...' : 'Save'}
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
