import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  Globe,
  Link2,
  Lock,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { GistSummary, GitHubUser } from '../github';
import type { InstallationRepo } from '../github_app';
import { type GitHubRateLimitSnapshot, readStoredGitHubRateLimitSnapshot } from '../github_rate_limit';
import { routePath } from '../routing';

function isLocalhostHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1';
}

function getOpenInInputMdUrl(): string | null {
  const { hostname, pathname, search, hash } = window.location;
  if (!isLocalhostHostname(hostname)) return null;
  return `https://input.md${pathname}${search}${hash}`;
}

export type ActiveView = 'workspaces' | 'loading' | 'error' | 'content' | 'edit';

function animateRateLimitSnapshot(
  snapshot: GitHubRateLimitSnapshot | null,
  nowMs: number,
): GitHubRateLimitSnapshot | null {
  if (!snapshot || snapshot.resetAtUnixSeconds == null) return snapshot;
  if (snapshot.remaining >= snapshot.limit) return snapshot;

  const resetAtMs = snapshot.resetAtUnixSeconds * 1000;
  if (resetAtMs <= snapshot.observedAtMs) return snapshot;
  if (nowMs >= resetAtMs) {
    return { ...snapshot, remaining: snapshot.limit };
  }

  const progress = Math.max(0, Math.min(1, (nowMs - snapshot.observedAtMs) / (resetAtMs - snapshot.observedAtMs)));
  const refill = Math.round((snapshot.limit - snapshot.remaining) * progress);
  return {
    ...snapshot,
    remaining: Math.min(snapshot.limit, snapshot.remaining + refill),
  };
}

function rateFillPercent(snapshot: GitHubRateLimitSnapshot | null): number {
  if (!snapshot || snapshot.limit <= 0) return 0;
  return Math.max(0, Math.min(100, (snapshot.remaining / snapshot.limit) * 100));
}

function rateLimitTone(snapshot: GitHubRateLimitSnapshot | null): 'danger' | 'warn' | 'ok' {
  if (!snapshot || snapshot.limit <= 0) return 'ok';
  const usedRatio = (snapshot.limit - snapshot.remaining) / snapshot.limit;
  if (usedRatio >= 0.85) return 'danger';
  if (usedRatio >= 0.5) return 'warn';
  return 'ok';
}

function rateLimitAvailabilityLabel(snapshot: GitHubRateLimitSnapshot | null): string {
  if (!snapshot || snapshot.limit <= 0) return '--';
  return `${Math.round((snapshot.remaining / snapshot.limit) * 100)}%`;
}

interface ToolbarProps {
  view: ActiveView;
  user: GitHubUser | null;
  selectedRepo: string | null;
  selectedRepoPrivate: boolean | null;
  inRepoContext: boolean;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  reposLoadError: string | null;
  menuGists: GistSummary[];
  menuGistsLoading: boolean;
  gistsLoadError: string | null;
  draftMode: boolean;
  sidebarVisible: boolean;
  showShare: boolean;
  shareMetadata: string | null;
  showDraftBadge?: boolean;
  showDraftActions?: boolean;
  showRestoreDraft?: boolean;
  onShare: () => void;
  onResetDraftChanges?: () => void;
  onRestoreDraft?: () => void;
  onViewInGitHub: () => void;
  showCompactCommits?: boolean;
  onCompactCommits?: () => void;
  showEdit: boolean;
  editUrl: string | null;
  showPreviewToggle: boolean;
  previewVisible: boolean;
  onTogglePreview: () => void;
  showAiToggle: boolean;
  aiVisible: boolean;
  aiDisabled?: boolean;
  onToggleAi: () => void;
  showCancel: boolean;
  onCancel: () => void;
  showSave: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  onSaveAndExit: () => void;
  saveStatusText?: string | null;
  saveStatusTone?: 'pending' | 'warning';
  onSignInWithGitHub: (options?: { includeGists?: boolean }) => void;
  navigate: (route: string, options?: { replace?: boolean; state?: unknown }) => void;
  onOpenRepoMenu: () => void;
  onRetryRepos: () => void;
  onRetryGists: () => void;
  onSelectRepo: (fullName: string, id: number, isPrivate: boolean) => void;
  onSignOut: () => void;
  onClearCache: () => void | Promise<void>;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onEdit: () => void;
  showLeftLoading: boolean;
  preserveLeftControlsWhileLoading?: boolean;
  showGoToWorkspace: boolean;
  onGoToWorkspace: () => void;
  localRateLimit: GitHubRateLimitSnapshot | null;
  serverRateLimit: GitHubRateLimitSnapshot | null;
}

export function Toolbar({
  view,
  user,
  selectedRepo,
  selectedRepoPrivate,
  inRepoContext,
  availableRepos,
  repoListLoading,
  reposLoadError,
  menuGists,
  menuGistsLoading,
  gistsLoadError,
  draftMode,
  sidebarVisible,
  showShare,
  shareMetadata,
  showDraftBadge = false,
  showDraftActions = false,
  showRestoreDraft = false,
  onShare,
  onResetDraftChanges,
  onRestoreDraft,
  onViewInGitHub,
  showCompactCommits = false,
  onCompactCommits,
  showEdit,
  editUrl,
  showPreviewToggle,
  previewVisible,
  onTogglePreview,
  showAiToggle,
  aiVisible,
  aiDisabled = false,
  onToggleAi,
  showCancel,
  onCancel,
  showSave,
  saving,
  canSave,
  onSave,
  onSaveAndExit,
  saveStatusText = null,
  saveStatusTone = 'pending',
  onSignInWithGitHub,
  navigate,
  onOpenRepoMenu,
  onRetryRepos,
  onRetryGists,
  onSelectRepo,
  onSignOut,
  onClearCache,
  onToggleTheme,
  onToggleSidebar,
  onEdit,
  showLeftLoading,
  preserveLeftControlsWhileLoading = false,
  showGoToWorkspace,
  onGoToWorkspace,
  localRateLimit,
  serverRateLimit,
}: ToolbarProps) {
  const [authorMenuOpen, setAuthorMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isHomeDraft = view === 'edit' && draftMode;
  const showSignInToSave = isHomeDraft && !user;
  const showGitHubApp = !!user;
  const showSidebarToggle = view === 'content' || view === 'edit';
  const disableLeftControls = showLeftLoading && preserveLeftControlsWhileLoading;
  const RepoPrivacyIcon = selectedRepoPrivate ? Lock : Globe;
  const noReposOrGists = !repoListLoading && !menuGistsLoading && availableRepos.length === 0 && menuGists.length === 0;
  const openInInputMdUrl = getOpenInInputMdUrl();
  const showPreviewAndAiGroup = showPreviewToggle && showAiToggle;
  const resolvedLocalRateLimit = localRateLimit ?? readStoredGitHubRateLimitSnapshot('serverLocal');
  const resolvedServerRateLimit = serverRateLimit ?? readStoredGitHubRateLimitSnapshot('server');
  const localRateLimitAnimated = useMemo(
    () => animateRateLimitSnapshot(resolvedLocalRateLimit, nowMs),
    [resolvedLocalRateLimit, nowMs],
  );
  const serverRateLimitAnimated = useMemo(
    () => animateRateLimitSnapshot(resolvedServerRateLimit, nowMs),
    [resolvedServerRateLimit, nowMs],
  );
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const runAuthorMenuAction = (event: Event, action: () => void, options?: { preventDefault?: boolean }): void => {
    if (options?.preventDefault) event.preventDefault();
    event.stopPropagation();
    action();
  };
  const authorMenu = (
    <DropdownMenu.Root open={authorMenuOpen} onOpenChange={setAuthorMenuOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" class="author-menu-trigger" aria-label="Author menu" title="Author menu">
          <MoreVertical size={16} aria-hidden="true" />
          {showDraftBadge ? <span class="author-menu-trigger-badge" aria-hidden="true" /> : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="author-menu-content" sideOffset={6} align="end">
          {shareMetadata ? (
            <>
              <DropdownMenu.Label class="user-menu-label">{shareMetadata}</DropdownMenu.Label>
              <DropdownMenu.Separator class="user-menu-separator" />
            </>
          ) : null}
          <DropdownMenu.Item
            class="author-menu-item"
            onSelect={(event: Event) => {
              setAuthorMenuOpen(false);
              runAuthorMenuAction(event, onShare, { preventDefault: true });
            }}
          >
            Share
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="author-menu-item"
            onSelect={(event: Event) => {
              runAuthorMenuAction(event, onViewInGitHub);
            }}
          >
            View in GitHub <ExternalLink size={14} className="author-menu-item-icon" aria-hidden="true" />
          </DropdownMenu.Item>
          {showCompactCommits ? (
            <DropdownMenu.Item
              class="author-menu-item"
              onSelect={(event: Event) => {
                runAuthorMenuAction(event, () => {
                  onCompactCommits?.();
                });
              }}
            >
              Compact recent commits
            </DropdownMenu.Item>
          ) : null}
          {openInInputMdUrl ? (
            <>
              <DropdownMenu.Separator class="user-menu-separator" />
              <DropdownMenu.Item
                class="author-menu-item"
                onSelect={(event: Event) => {
                  runAuthorMenuAction(event, () => {
                    window.open(openInInputMdUrl, '_blank', 'noopener,noreferrer');
                  });
                }}
              >
                Open in input.md <ExternalLink size={14} className="author-menu-item-icon" aria-hidden="true" />
              </DropdownMenu.Item>
            </>
          ) : null}
          {showDraftActions ? (
            <>
              <DropdownMenu.Separator class="user-menu-separator" />
              {showRestoreDraft ? (
                <DropdownMenu.Item
                  class="author-menu-item"
                  onSelect={(event: Event) => {
                    runAuthorMenuAction(event, () => {
                      onRestoreDraft?.();
                    });
                  }}
                >
                  Restore previous changes
                </DropdownMenu.Item>
              ) : null}
              {!showRestoreDraft ? (
                <DropdownMenu.Item
                  class="author-menu-item"
                  onSelect={(event: Event) => {
                    runAuthorMenuAction(event, () => {
                      onResetDraftChanges?.();
                    });
                  }}
                >
                  Reset Changes
                </DropdownMenu.Item>
              ) : null}
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  const signInButton = (
    <div class="github-signin-group" role="group" aria-label="Sign in with GitHub options">
      <button type="button" class="github-signin-btn github-signin-btn-main" onClick={() => onSignInWithGitHub()}>
        Sign in with GitHub
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            class="github-signin-btn github-signin-btn-toggle"
            aria-label="More GitHub sign-in options"
            title="More GitHub sign-in options"
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="user-menu-content github-signin-menu-content" sideOffset={6} align="end">
            <DropdownMenu.Item class="user-menu-item" onSelect={() => onSignInWithGitHub({ includeGists: false })}>
              Sign in with GitHub (no gists)
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
  return (
    <header class="toolbar">
      <div class="toolbar-left">
        {showLeftLoading && !preserveLeftControlsWhileLoading ? (
          <div class="toolbar-left-loading" role="status" aria-label="Loading workspace">
            <span class="toolbar-spinner" aria-hidden="true" />
          </div>
        ) : (
          <>
            {showLeftLoading ? (
              <div class="toolbar-left-loading" role="status" aria-label="Loading workspace">
                <span class="toolbar-spinner" aria-hidden="true" />
              </div>
            ) : null}
            {showSidebarToggle ? (
              <button
                type="button"
                class="document-menu-trigger"
                onClick={onToggleSidebar}
                disabled={disableLeftControls}
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
                  if (disableLeftControls) return;
                  if (open) onOpenRepoMenu();
                }}
              >
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    class="repo-menu-trigger"
                    aria-label="Navigation menu"
                    disabled={disableLeftControls}
                  >
                    {inRepoContext && selectedRepo ? (
                      <>
                        <RepoPrivacyIcon size={14} class="repo-menu-icon" aria-hidden="true" />
                        <span class="repo-menu-current-name">{selectedRepo}</span>
                      </>
                    ) : (
                      'My Workspaces'
                    )}
                    <ChevronDown size={14} class="repo-menu-icon" aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="repo-menu-content" sideOffset={6} align="start">
                    <div class="repo-menu-section-label">Repos</div>
                    {repoListLoading ? (
                      <DropdownMenu.Item class="repo-menu-item" disabled>
                        Loading repos...
                      </DropdownMenu.Item>
                    ) : reposLoadError ? (
                      <>
                        <DropdownMenu.Item class="repo-menu-item" disabled>
                          Failed to load repos
                        </DropdownMenu.Item>
                        <DropdownMenu.Item class="repo-menu-item" onSelect={() => onRetryRepos()}>
                          Retry Repos
                        </DropdownMenu.Item>
                      </>
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
                              const [owner, name] = repo.full_name.split('/');
                              if (!owner || !name) {
                                navigate(routePath.workspaces());
                                return;
                              }
                              navigate(routePath.repoDocuments(owner, name));
                            }}
                          >
                            <span class="repo-menu-item-main">
                              <PrivacyIcon size={14} class="repo-menu-icon" aria-hidden="true" />
                              <span>{repo.full_name}</span>
                            </span>
                            {isSelected && inRepoContext ? (
                              <Check size={14} class="repo-menu-icon" aria-hidden="true" />
                            ) : null}
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
                    ) : gistsLoadError ? (
                      <>
                        <DropdownMenu.Item class="repo-menu-item" disabled>
                          Failed to load gists
                        </DropdownMenu.Item>
                        <DropdownMenu.Item class="repo-menu-item" onSelect={() => onRetryGists()}>
                          Retry Gists
                        </DropdownMenu.Item>
                      </>
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
                              <Globe size={14} class="repo-menu-icon" aria-hidden="true" />
                            ) : (
                              <Link2 size={14} class="repo-menu-icon" aria-hidden="true" />
                            )}
                            <span>{gist.description || 'Untitled'}</span>
                          </span>
                        </DropdownMenu.Item>
                      ))
                    )}
                    <DropdownMenu.Separator class="user-menu-separator" />
                    <DropdownMenu.Item class="repo-menu-item" onSelect={() => navigate(routePath.workspaces())}>
                      {noReposOrGists ? 'Get started...' : 'Manage Workspaces'}
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
          {saveStatusText ? (
            <div
              class={`toolbar-save-status${saveStatusTone === 'warning' ? ' toolbar-save-status--warning' : ''}`}
              role="status"
              aria-live="polite"
            >
              {saveStatusText}
            </div>
          ) : null}
          {showGoToWorkspace && (
            <button type="button" onClick={onGoToWorkspace}>
              Go to workspace
            </button>
          )}
          {showEdit && (
            <button type="button" onClick={onEdit}>
              Edit
            </button>
          )}
          {showShare && view !== 'edit' && authorMenu}
          {editUrl && (
            <a href={editUrl} target="_blank" rel="noopener noreferrer" class="edit-on-input-link">
              Edit <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {showCancel && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          {showSave && (
            <div class="toolbar-split-button-group" role="group" aria-label="Save options">
              <button type="button" class="toolbar-split-button-main" onClick={onSave} disabled={saving || !canSave}>
                {saving ? 'Saving...' : 'Save'}
              </button>
              {saving || !canSave ? (
                <button
                  type="button"
                  class="toolbar-split-button-toggle"
                  aria-label="More save options"
                  title="More save options"
                  disabled
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              ) : (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      class="toolbar-split-button-toggle"
                      aria-label="More save options"
                      title="More save options"
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      class="user-menu-content toolbar-split-button-menu-content"
                      sideOffset={6}
                      align="end"
                    >
                      <DropdownMenu.Item class="user-menu-item" onSelect={onSaveAndExit}>
                        Save and exit
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
          )}
          {showShare && view === 'edit' && authorMenu}
          {showSignInToSave && signInButton}
        </div>
        {showPreviewToggle || showAiToggle ? (
          <div class="toolbar-toggle-controls">
            {showPreviewAndAiGroup ? (
              <div class="toggle-button-group" role="group" aria-label="Preview and Reader AI controls">
                <button
                  type="button"
                  class={`preview-toggle-btn${previewVisible ? '' : ' preview-toggle-btn-off'}`}
                  title={previewVisible ? 'Hide preview' : 'Show preview'}
                  aria-label={previewVisible ? 'Hide preview' : 'Show preview'}
                  onClick={onTogglePreview}
                >
                  <Eye size={16} />
                </button>
                <button
                  type="button"
                  class={`preview-toggle-btn${aiVisible ? '' : ' preview-toggle-btn-off'}`}
                  title={aiVisible ? 'Hide Reader AI' : 'Show Reader AI'}
                  aria-label={aiVisible ? 'Hide Reader AI' : 'Show Reader AI'}
                  disabled={aiDisabled}
                  onClick={onToggleAi}
                >
                  <Sparkles size={16} />
                </button>
              </div>
            ) : (
              <>
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
                {showAiToggle && (
                  <button
                    type="button"
                    class={`preview-toggle-btn${aiVisible ? '' : ' preview-toggle-btn-off'}`}
                    title={aiVisible ? 'Hide Reader AI' : 'Show Reader AI'}
                    aria-label={aiVisible ? 'Hide Reader AI' : 'Show Reader AI'}
                    disabled={aiDisabled}
                    onClick={onToggleAi}
                  >
                    <Sparkles size={16} />
                  </button>
                )}
              </>
            )}
          </div>
        ) : null}
        {user ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" class="user-menu-trigger" aria-label="User menu" title="User menu">
                <img class="user-avatar" src={user.avatar_url} alt="" width={24} height={24} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="user-menu-content" sideOffset={6} align="end">
                <DropdownMenu.Label class="user-menu-label">
                  <a href="https://github.com/settings/profile" target="_blank" rel="noopener noreferrer">
                    {user.login}
                  </a>
                </DropdownMenu.Label>
                <DropdownMenu.Separator class="user-menu-separator" />
                {view !== 'workspaces' ? (
                  <DropdownMenu.Item class="user-menu-item" onSelect={() => navigate(routePath.workspaces())}>
                    Workspaces
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item class="user-menu-item" onSelect={() => onToggleTheme()}>
                  Toggle Theme
                </DropdownMenu.Item>
                <DropdownMenu.Separator class="user-menu-separator" />
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger class="user-menu-item user-menu-subtrigger">
                    Show rate limits
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      class="user-menu-content user-menu-subcontent"
                      sideOffset={6}
                      alignOffset={-6}
                    >
                      <div class="rate-limit-menu-content">
                        <div class="rate-limit-menu-meter">
                          <div class="rate-limit-menu-label">Your rate limit</div>
                          <div
                            class={`toolbar-health-detail-bar toolbar-health-detail-bar--${rateLimitTone(localRateLimitAnimated)}`}
                          >
                            <div class="toolbar-health-detail-bar-track">
                              <div
                                class="toolbar-health-detail-bar-fill"
                                style={{ width: `${rateFillPercent(localRateLimitAnimated)}%` }}
                              />
                            </div>
                          </div>
                          <div class="rate-limit-menu-value">
                            <span>{rateLimitAvailabilityLabel(localRateLimitAnimated)}</span>
                            <span>{localRateLimitAnimated ? `${localRateLimitAnimated.limit}/min` : '--'}</span>
                          </div>
                        </div>
                        <div class="rate-limit-menu-meter">
                          <div class="rate-limit-menu-label">Shared rate limit</div>
                          <div
                            class={`toolbar-health-detail-bar toolbar-health-detail-bar--${rateLimitTone(serverRateLimitAnimated)}`}
                          >
                            <div class="toolbar-health-detail-bar-track">
                              <div
                                class="toolbar-health-detail-bar-fill"
                                style={{ width: `${rateFillPercent(serverRateLimitAnimated)}%` }}
                              />
                            </div>
                          </div>
                          <div class="rate-limit-menu-value">
                            <span>{rateLimitAvailabilityLabel(serverRateLimitAnimated)}</span>
                            <span>{serverRateLimitAnimated ? `${serverRateLimitAnimated.limit}/hour` : '--'}</span>
                          </div>
                        </div>
                      </div>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
                <DropdownMenu.Item class="user-menu-item" onSelect={() => void onClearCache()}>
                  Clear cache
                </DropdownMenu.Item>
                <DropdownMenu.Separator class="user-menu-separator" />
                <DropdownMenu.Item class="user-menu-item" onSelect={() => onSignOut()}>
                  Sign Out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : !showSignInToSave ? (
          signInButton
        ) : null}
      </div>
    </header>
  );
}
