import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Check, ChevronDown, Eye, Globe, Link2, Lock, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { GistSummary, GitHubUser } from '../github';
import type { InstallationRepo } from '../github_app';
import { routePath } from '../routing';

export type ActiveView = 'login' | 'workspaces' | 'loading' | 'error' | 'content' | 'edit';

interface ToolbarProps {
  view: ActiveView;
  user: GitHubUser | null;
  selectedRepo: string | null;
  selectedRepoPrivate: boolean | null;
  inRepoContext: boolean;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  menuGists: GistSummary[];
  menuGistsLoading: boolean;
  draftMode: boolean;
  sidebarVisible: boolean;
  showShare: boolean;
  onShare: () => void;
  showEdit: boolean;
  showPreviewToggle: boolean;
  previewVisible: boolean;
  onTogglePreview: () => void;
  showSave: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  navigate: (route: string, options?: { replace?: boolean; state?: unknown }) => void;
  onOpenRepoMenu: () => void;
  onSelectRepo: (fullName: string, id: number, isPrivate: boolean) => void;
  onSignOut: () => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onEdit: () => void;
  showLeftLoading: boolean;
}

export function Toolbar({
  view,
  user,
  selectedRepo,
  selectedRepoPrivate,
  inRepoContext,
  availableRepos,
  repoListLoading,
  menuGists,
  menuGistsLoading,
  draftMode,
  sidebarVisible,
  showShare,
  onShare,
  showEdit,
  showPreviewToggle,
  previewVisible,
  onTogglePreview,
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
  showLeftLoading,
}: ToolbarProps) {
  const isHomeDraft = view === 'edit' && draftMode;
  const showSignInToSave = isHomeDraft && !user;
  const showGitHubApp = !!user;
  const showSidebarToggle = view === 'content' || view === 'edit';
  const RepoPrivacyIcon = selectedRepoPrivate ? Lock : Globe;

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        {showLeftLoading ? (
          <div class="toolbar-left-loading" role="status" aria-label="Loading workspace">
            <span class="toolbar-spinner" aria-hidden="true" />
          </div>
        ) : (
          <>
            {showSidebarToggle ? (
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
                      'My Workspaces'
                    )}
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="repo-menu-content" sideOffset={6} align="start">
                    <div class="repo-menu-section-label">Repos</div>
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
                              navigate(routePath.repoDocuments(), {
                                state: {
                                  selectedRepo: {
                                    full_name: repo.full_name,
                                    id: repo.id,
                                    private: repo.private,
                                  },
                                },
                              });
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
                    <div class="repo-menu-section-label">Gists</div>
                    {menuGistsLoading ? (
                      <DropdownMenu.Item class="repo-menu-item" disabled>
                        Loading gists...
                      </DropdownMenu.Item>
                    ) : menuGists.length === 0 ? (
                      <DropdownMenu.Item class="repo-menu-item" disabled>
                        No gists
                      </DropdownMenu.Item>
                    ) : (
                      menuGists.map((gist) => (
                        <DropdownMenu.Item
                          key={gist.id}
                          class="repo-menu-item"
                          onSelect={() => navigate(routePath.gistView(gist.id))}
                        >
                          <span class="repo-menu-item-main">
                            {gist.public ? (
                              <Globe size={14} aria-hidden="true" />
                            ) : (
                              <Link2 size={14} aria-hidden="true" />
                            )}
                            <span>{gist.description || 'Untitled'}</span>
                          </span>
                        </DropdownMenu.Item>
                      ))
                    )}
                    <DropdownMenu.Separator class="user-menu-separator" />
                    <DropdownMenu.Item class="repo-menu-item" onSelect={() => navigate(routePath.workspaces())}>
                      Manage Workspaces
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </>
        )}
      </div>
      <div class="toolbar-right">
        <div class="action-buttons">
          {showShare && (
            <button type="button" onClick={onShare}>
              Share
            </button>
          )}
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
          {showSave && (
            <button type="button" onClick={onSave} disabled={saving || !canSave}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          {showSignInToSave && (
            <button type="button" onClick={() => navigate(routePath.login())}>
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
                  <DropdownMenu.Label class="user-menu-label">
                    <a href="https://github.com/settings/profile" target="_blank" rel="noopener noreferrer">
                      {user.login}
                    </a>
                  </DropdownMenu.Label>
                  <DropdownMenu.Separator class="user-menu-separator" />
                  <DropdownMenu.Item class="user-menu-item" onSelect={() => navigate(routePath.workspaces())}>
                    Workspaces
                  </DropdownMenu.Item>
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
        ) : !showSignInToSave && view !== 'login' ? (
          <button type="button" onClick={() => navigate(routePath.login())}>
            Sign In
          </button>
        ) : null}
      </div>
    </header>
  );
}
