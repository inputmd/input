import { Check } from 'lucide-react';

export interface GroupedRepoMenuGroup {
  installationId: string;
  installationLabel: string;
  repos: Array<{
    id: number;
    fullName: string;
    isCurrentTarget: boolean;
  }>;
  loading: boolean;
  error?: string | null;
}

interface GroupedRepoMenuProps {
  repoGroups: GroupedRepoMenuGroup[];
  selectedInstallationId: string;
  selectedRepoFullName: string;
  submitting?: boolean;
  onSelectRepo: (selection: { installationId: string; fullName: string }) => void;
  onRetryRepos?: (installationId: string) => void;
  onDismiss?: () => void;
}

export function GroupedRepoMenu({
  repoGroups,
  selectedInstallationId,
  selectedRepoFullName,
  submitting = false,
  onSelectRepo,
  onRetryRepos,
  onDismiss,
}: GroupedRepoMenuProps) {
  return (
    <>
      {repoGroups.map((group, groupIndex) => (
        <div key={group.installationId}>
          {groupIndex > 0 ? <div class="user-menu-separator" aria-hidden="true" /> : null}
          <div class="repo-menu-section-label">{group.installationLabel}</div>
          {group.loading ? (
            <div class="repo-menu-item" aria-disabled="true">
              Loading repos...
            </div>
          ) : group.error ? (
            <>
              <div class="repo-menu-item" aria-disabled="true">
                Failed to load repos
              </div>
              {onRetryRepos ? (
                <button
                  type="button"
                  class="repo-menu-item"
                  onClick={() => onRetryRepos(group.installationId)}
                  disabled={submitting}
                >
                  Retry repos
                </button>
              ) : null}
            </>
          ) : group.repos.length === 0 ? (
            <div class="repo-menu-item" aria-disabled="true">
              No repos available
            </div>
          ) : (
            group.repos.map((repo) => {
              const selected =
                selectedInstallationId === group.installationId && selectedRepoFullName === repo.fullName;
              return (
                <button
                  key={`${group.installationId}:${repo.id}`}
                  type="button"
                  class="repo-menu-item"
                  aria-pressed={selected}
                  disabled={submitting}
                  onClick={() => {
                    onSelectRepo({ installationId: group.installationId, fullName: repo.fullName });
                    onDismiss?.();
                  }}
                >
                  <span class="repo-menu-item-main">
                    <span>{repo.fullName}</span>
                    {repo.isCurrentTarget ? <span class="fork-repo-menu-item-meta">(currently selected)</span> : null}
                  </span>
                  {selected ? <Check size={14} class="repo-menu-icon" aria-hidden="true" /> : null}
                </button>
              );
            })
          )}
        </div>
      ))}
    </>
  );
}
