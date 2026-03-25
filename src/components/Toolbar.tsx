import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Check,
  ChevronDown,
  CodeXml,
  ExternalLink,
  Eye,
  Globe,
  Link2,
  Lock,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GistSummary, GitHubUser } from '../github';
import type { InstallationRepo, LinkedInstallation } from '../github_app';
import { type GitHubRateLimitSnapshot, readStoredGitHubRateLimitSnapshot } from '../github_rate_limit';
import { isEditableShortcutTarget, matchesControlShortcut } from '../keyboard_shortcuts';
import type { ReaderAiModel } from '../reader_ai';
import { routePath } from '../routing';
import { ReaderAiModelSelector } from './ReaderAiModelSelector';

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
  isGistContext: boolean;
  documentCollaborators: Array<{ login: string; avatarUrl: string; isAuthor: boolean }>;
  availableRepos: InstallationRepo[];
  installationId: string | null;
  linkedInstallations: LinkedInstallation[];
  repoListLoading: boolean;
  reposLoadError: string | null;
  menuGists: GistSummary[];
  menuGistsLoading: boolean;
  gistsLoadError: string | null;
  draftMode: boolean;
  sidebarVisible: boolean;
  showActionsMenu: boolean;
  showShare: boolean;
  showViewSource: boolean;
  viewSourceLabel?: string;
  shareMetadata: string | null;
  showDraftBadge?: boolean;
  showDraftActions?: boolean;
  showRestoreDraft?: boolean;
  onShare: () => void;
  onViewSource: () => void;
  onResetDraftChanges?: () => void;
  onRestoreDraft?: () => void;
  onViewInGitHub: () => void;
  showCompactCommits?: boolean;
  onCompactCommits?: () => void;
  showEdit: boolean;
  editLabel?: string;
  mobileEditIcon?: 'source-toggle' | null;
  editUrl: string | null;
  showPreviewToggle: boolean;
  previewVisible: boolean;
  onTogglePreview: () => void;
  showAiToggle: boolean;
  aiVisible: boolean;
  aiDisabled?: boolean;
  onToggleAi: () => void;
  aiModels: ReaderAiModel[];
  aiModelsLoading: boolean;
  aiModelsError: string | null;
  selectedAiModel: string;
  onSelectAiModel: (modelId: string) => void;
  localCodexEnabled?: boolean;
  onEnableLocalCodex?: () => void;
  showAiLoginPrompt?: boolean;
  showCancel: boolean;
  onCancel: () => void;
  showSave: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  onSaveAndExit: () => void;
  saveStatusText?: string | null;
  saveStatusPlain?: boolean;
  saveStatusTone?: 'pending' | 'warning';
  onSignInWithGitHub: (options?: { includeGists?: boolean }) => void;
  navigate: (route: string, options?: { replace?: boolean; state?: unknown }) => void;
  onOpenRepoMenu: () => void;
  onRetryRepos: () => void;
  onRetryGists: () => void;
  onSelectInstallation: (installationId: string) => void | Promise<void>;
  onSelectRepo: (fullName: string, id: number, isPrivate: boolean) => void | Promise<void>;
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
  isGistContext,
  documentCollaborators,
  availableRepos,
  installationId,
  linkedInstallations,
  repoListLoading,
  reposLoadError,
  menuGists,
  menuGistsLoading,
  gistsLoadError,
  draftMode,
  sidebarVisible,
  showActionsMenu,
  showShare,
  showViewSource,
  viewSourceLabel = 'View Source',
  shareMetadata,
  showDraftBadge = false,
  showDraftActions = false,
  showRestoreDraft = false,
  onShare,
  onViewSource,
  onResetDraftChanges,
  onRestoreDraft,
  onViewInGitHub,
  showCompactCommits = false,
  onCompactCommits,
  showEdit,
  editLabel = 'Edit',
  mobileEditIcon = null,
  editUrl,
  showPreviewToggle,
  previewVisible,
  onTogglePreview,
  showAiToggle,
  aiVisible,
  aiDisabled = false,
  onToggleAi,
  aiModels,
  aiModelsLoading,
  aiModelsError,
  selectedAiModel,
  onSelectAiModel,
  localCodexEnabled = false,
  onEnableLocalCodex,
  showAiLoginPrompt = false,
  showCancel,
  onCancel,
  showSave,
  saving,
  canSave,
  onSave,
  onSaveAndExit,
  saveStatusText = null,
  saveStatusPlain = false,
  saveStatusTone = 'pending',
  onSignInWithGitHub,
  navigate,
  onOpenRepoMenu,
  onRetryRepos,
  onRetryGists,
  onSelectInstallation,
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
  const [collaboratorsTooltipOpen, setCollaboratorsTooltipOpen] = useState(false);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const collaboratorsTooltipCloseTimeoutRef = useRef<number | null>(null);
  const isHomeDraft = view === 'edit' && draftMode;
  const showHomeOnlyActions = isHomeDraft && !user;
  const showGitHubApp = !!user;
  const showSidebarToggle = view === 'content' || view === 'edit';
  const disableLeftControls = showLeftLoading && preserveLeftControlsWhileLoading;
  const repoMenuShortcutAvailable = showGitHubApp && !disableLeftControls;
  const RepoPrivacyIcon = selectedRepoPrivate ? Lock : Globe;
  const noReposOrGists = !repoListLoading && !menuGistsLoading && availableRepos.length === 0 && menuGists.length === 0;
  const openInInputMdUrl = getOpenInInputMdUrl();
  const selectedInstallation =
    linkedInstallations.find((candidate) => candidate.installationId === installationId) ??
    linkedInstallations[0] ??
    null;
  const selectedInstallationLabel = selectedInstallation?.accountLogin ?? selectedInstallation?.installationId ?? null;
  const selectedRepoName = selectedRepo?.split('/').at(-1) ?? selectedRepo;
  const showHeaderToggleGroup = showPreviewToggle || showAiToggle;
  const showAiModelSelector = showAiToggle;
  const modelSelectorShortcutAvailable = showAiModelSelector && !aiDisabled && !aiModelsLoading && aiModels.length > 0;
  const canOpenSaveMenu = !saving && (canSave || showCancel);
  const collaboratorCountLabel = `${documentCollaborators.length} editor${documentCollaborators.length === 1 ? '' : 's'}`;
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

  useEffect(() => {
    return () => {
      if (collaboratorsTooltipCloseTimeoutRef.current !== null) {
        window.clearTimeout(collaboratorsTooltipCloseTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!repoMenuShortcutAvailable || !matchesControlShortcut(event, 'r')) return;
      if (isEditableShortcutTarget(event.target)) return;

      event.preventDefault();
      setRepoMenuOpen((open) => {
        const nextOpen = !open;
        if (nextOpen) onOpenRepoMenu();
        return nextOpen;
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpenRepoMenu, repoMenuShortcutAvailable]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!modelSelectorShortcutAvailable || !matchesControlShortcut(event, 'o')) return;
      if (isEditableShortcutTarget(event.target)) return;

      event.preventDefault();
      setModelSelectorOpen((open) => !open);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modelSelectorShortcutAvailable]);

  const openCollaboratorsTooltip = (): void => {
    if (collaboratorsTooltipCloseTimeoutRef.current !== null) {
      window.clearTimeout(collaboratorsTooltipCloseTimeoutRef.current);
      collaboratorsTooltipCloseTimeoutRef.current = null;
    }
    setCollaboratorsTooltipOpen(true);
  };

  const closeCollaboratorsTooltipSoon = (): void => {
    if (collaboratorsTooltipCloseTimeoutRef.current !== null) {
      window.clearTimeout(collaboratorsTooltipCloseTimeoutRef.current);
    }
    collaboratorsTooltipCloseTimeoutRef.current = window.setTimeout(() => {
      collaboratorsTooltipCloseTimeoutRef.current = null;
      setCollaboratorsTooltipOpen(false);
    }, 120);
  };

  const runAuthorMenuAction = (event: Event, action: () => void, options?: { preventDefault?: boolean }): void => {
    if (options?.preventDefault) event.preventDefault();
    event.stopPropagation();
    setAuthorMenuOpen(false);
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
          {showShare ? (
            <DropdownMenu.Item
              class="author-menu-item"
              onSelect={(event: Event) => {
                runAuthorMenuAction(event, onShare, { preventDefault: true });
              }}
            >
              Share
            </DropdownMenu.Item>
          ) : null}
          {showViewSource ? (
            <DropdownMenu.Item
              class="author-menu-item"
              onSelect={(event: Event) => {
                runAuthorMenuAction(event, onViewSource);
              }}
            >
              {viewSourceLabel}
            </DropdownMenu.Item>
          ) : null}
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
          {openInInputMdUrl && !showHomeOnlyActions ? (
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
                  Reset changes
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
        <span class="toolbar-desktop-only">Sign in with GitHub</span>
        <span class="toolbar-mobile-only">Sign in</span>
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
              Sign in (privacy mode, no gists)
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
              <div class="toolbar-repo-group">
                <DropdownMenu.Root
                  open={repoMenuOpen}
                  onOpenChange={(open: boolean) => {
                    setRepoMenuOpen(open);
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
                          <span class="repo-menu-current-name">
                            {selectedInstallationLabel
                              ? `${selectedInstallationLabel}/${selectedRepoName}`
                              : selectedRepo}
                          </span>
                        </>
                      ) : isGistContext ? (
                        'My Workspaces'
                      ) : (
                        <>
                          {selectedInstallation ? (
                            selectedInstallation.accountAvatarUrl ? (
                              <img
                                class="repo-menu-trigger-avatar"
                                src={selectedInstallation.accountAvatarUrl}
                                alt=""
                                aria-hidden="true"
                                width={18}
                                height={18}
                              />
                            ) : (
                              <span
                                class="repo-menu-trigger-avatar repo-menu-trigger-avatar--placeholder"
                                aria-hidden="true"
                              />
                            )
                          ) : null}
                          <span class="repo-menu-current-name">
                            {selectedInstallation?.accountLogin ??
                              selectedInstallation?.installationId ??
                              'My Workspaces'}
                          </span>
                        </>
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
                                void onSelectRepo(repo.full_name, repo.id, repo.private);
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
                      {linkedInstallations.length > 1 ? (
                        <>
                          <DropdownMenu.Separator class="user-menu-separator" />
                          <div class="repo-menu-section-label">Installations</div>
                          {linkedInstallations.map((installation) => {
                            const isSelected = installation.installationId === installationId;
                            return (
                              <DropdownMenu.Item
                                key={installation.installationId}
                                class="repo-menu-item"
                                onSelect={() => {
                                  void onSelectInstallation(installation.installationId);
                                }}
                              >
                                <span class="repo-menu-item-main">
                                  {installation.accountAvatarUrl ? (
                                    <img
                                      src={installation.accountAvatarUrl}
                                      alt=""
                                      aria-hidden="true"
                                      class="repo-menu-installation-avatar"
                                    />
                                  ) : (
                                    <span
                                      aria-hidden="true"
                                      class="repo-menu-installation-avatar repo-menu-installation-avatar--placeholder"
                                    />
                                  )}
                                  <span>{installation.accountLogin ?? installation.installationId}</span>
                                </span>
                                {isSelected ? <Check size={14} class="repo-menu-icon" aria-hidden="true" /> : null}
                              </DropdownMenu.Item>
                            );
                          })}
                        </>
                      ) : null}
                      <DropdownMenu.Separator class="user-menu-separator" />
                      <DropdownMenu.Item class="repo-menu-item" onSelect={() => navigate(routePath.workspaces())}>
                        {noReposOrGists ? 'Get started...' : 'Manage Workspaces'}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                {documentCollaborators.length > 0 ? (
                  <Tooltip.Provider delayDuration={150}>
                    <Tooltip.Root open={collaboratorsTooltipOpen} onOpenChange={setCollaboratorsTooltipOpen}>
                      <Tooltip.Trigger asChild>
                        <span
                          class="toolbar-collaborator-summary"
                          onMouseEnter={openCollaboratorsTooltip}
                          onMouseLeave={closeCollaboratorsTooltipSoon}
                        >
                          {collaboratorCountLabel}
                        </span>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          class="toolbar-collaborator-tooltip"
                          side="bottom"
                          align="center"
                          sideOffset={8}
                          onMouseEnter={openCollaboratorsTooltip}
                          onMouseLeave={closeCollaboratorsTooltipSoon}
                        >
                          <div
                            class="toolbar-collaborator-tooltip-stack"
                            role="group"
                            aria-label="Document collaborators"
                          >
                            {documentCollaborators.map((collaborator) => (
                              <img
                                key={collaborator.login}
                                class="toolbar-collaborator-avatar"
                                src={collaborator.avatarUrl}
                                alt={`@${collaborator.login}`}
                                title={
                                  collaborator.isAuthor
                                    ? `Author: @${collaborator.login}`
                                    : `Editor: @${collaborator.login}`
                                }
                                loading="lazy"
                                decoding="async"
                              />
                            ))}
                          </div>
                          <div class="toolbar-collaborator-tooltip-list">
                            <span class="toolbar-collaborator-tooltip-label">Invited editors: </span>
                            <span>
                              {documentCollaborators.map((collaborator, index) => (
                                <>
                                  {index > 0 ? ', ' : null}
                                  <a
                                    href={`https://github.com/${collaborator.login}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="toolbar-collaborator-link"
                                  >
                                    {collaborator.login}
                                  </a>
                                </>
                              ))}
                            </span>
                          </div>
                          <Tooltip.Arrow class="toolbar-collaborator-tooltip-arrow" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
      <div class="toolbar-right">
        <div class="action-buttons">
          {saveStatusText ? (
            <div
              class={`toolbar-save-status${saveStatusTone === 'warning' ? ' toolbar-save-status--warning' : ''}${saveStatusPlain ? ' toolbar-save-status--plain' : ''}`}
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
            <button
              type="button"
              class={mobileEditIcon === 'source-toggle' ? 'toolbar-mobile-icon-btn' : undefined}
              onClick={onEdit}
              aria-label={mobileEditIcon === 'source-toggle' ? editLabel : undefined}
              title={mobileEditIcon === 'source-toggle' ? editLabel : undefined}
            >
              {mobileEditIcon === 'source-toggle' ? (
                <>
                  <span class="toolbar-desktop-only">{editLabel}</span>
                  <span class="toolbar-mobile-only toolbar-mobile-source-icon" aria-hidden="true">
                    <CodeXml size={16} />
                  </span>
                </>
              ) : (
                editLabel
              )}
            </button>
          )}
          {showActionsMenu && view !== 'edit' && view !== 'workspaces' && authorMenu}
          {editUrl && (
            <a href={editUrl} target="_blank" rel="noopener noreferrer" class="edit-on-input-link">
              Edit <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {showCancel && (
            <button type="button" class="toolbar-close-btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          {showSave && (
            <div class="toolbar-split-button-group" role="group" aria-label="Save options">
              <button type="button" class="toolbar-split-button-main" onClick={onSave} disabled={saving || !canSave}>
                {saving ? 'Saving...' : 'Save'}
              </button>
              {!canOpenSaveMenu ? (
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
                      <DropdownMenu.Item class="user-menu-item" onSelect={onSaveAndExit} disabled={!canSave}>
                        Save and close
                      </DropdownMenu.Item>
                      {showCancel ? (
                        <DropdownMenu.Item class="user-menu-item toolbar-mobile-save-menu-item" onSelect={onCancel}>
                          Cancel
                        </DropdownMenu.Item>
                      ) : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
          )}
          {showActionsMenu && view === 'edit' && authorMenu}
        </div>
        {showHeaderToggleGroup ? (
          <div class="toolbar-toggle-controls">
            <div class="toggle-button-group" role="group" aria-label="Preview and Reader AI controls">
              {showPreviewToggle ? (
                <button
                  type="button"
                  class={`preview-toggle-btn${previewVisible ? '' : ' preview-toggle-btn-off'}`}
                  title={previewVisible ? 'Hide preview' : 'Show preview'}
                  aria-label={previewVisible ? 'Hide preview' : 'Show preview'}
                  onClick={onTogglePreview}
                >
                  <Eye size={16} />
                </button>
              ) : null}
              {showAiToggle ? (
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
              ) : null}
              {showAiModelSelector ? (
                <ReaderAiModelSelector
                  models={aiModels}
                  modelsLoading={aiModelsLoading}
                  modelsError={aiModelsError}
                  selectedModel={selectedAiModel}
                  onSelectModel={onSelectAiModel}
                  localCodexEnabled={localCodexEnabled}
                  onEnableLocalCodex={onEnableLocalCodex}
                  open={modelSelectorOpen}
                  onOpenChange={setModelSelectorOpen}
                  disabled={aiDisabled}
                  triggerClassName="preview-toggle-btn preview-toggle-btn-model"
                  triggerAriaLabel="Reader AI model"
                  menuClassName="reader-ai-model-menu"
                  align="end"
                  showFreeBadge
                  showLoginForMoreModels={showAiLoginPrompt}
                />
              ) : null}
            </div>
          </div>
        ) : null}
        {user ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" class="user-menu-trigger" aria-label="Settings menu" title="Settings menu">
                <Settings size={18} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="user-menu-content" sideOffset={6} align="end">
                {view !== 'workspaces' ? (
                  <DropdownMenu.Item class="user-menu-item" onSelect={() => navigate(routePath.workspaces())}>
                    Workspaces
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item class="user-menu-item" onSelect={() => onToggleTheme()}>
                  Toggle theme
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
        ) : (
          signInButton
        )}
      </div>
    </header>
  );
}
