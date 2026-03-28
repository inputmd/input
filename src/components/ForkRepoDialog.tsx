import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef } from 'preact/hooks';
import type { InstallationRepo, LinkedInstallation } from '../github_app';

interface ForkRepoDialogProps {
  open: boolean;
  installations: LinkedInstallation[];
  selectedInstallationId: string;
  repos: InstallationRepo[];
  reposLoading?: boolean;
  reposLoadError?: string | null;
  selectedRepoFullName: string;
  currentTargetFullName?: string | null;
  submitting?: boolean;
  onSelectInstallation: (installationId: string) => void;
  onSelectRepo: (fullName: string) => void;
  onRetryRepos?: () => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function ForkRepoDialog({
  open,
  installations,
  selectedInstallationId,
  repos,
  reposLoading = false,
  reposLoadError = null,
  selectedRepoFullName,
  currentTargetFullName = null,
  submitting = false,
  onSelectInstallation,
  onSelectRepo,
  onRetryRepos,
  onConfirm,
  onClose,
}: ForkRepoDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const repoSelectDisabled = reposLoading || repos.length === 0 || submitting;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay class="dialog-overlay" />
        <DialogPrimitive.Content
          class="dialog-content"
          onOpenAutoFocus={(event: Event) => {
            event.preventDefault();
            setTimeout(() => confirmButtonRef.current?.focus(), 0);
          }}
        >
          <DialogPrimitive.Title class="dialog-title">Fork this document</DialogPrimitive.Title>
          <DialogPrimitive.Description class="dialog-message">
            Choose an installation and repo to create a new file with this document&apos;s contents.
          </DialogPrimitive.Description>
          <label class="dialog-field-label" for="fork-installation-select">
            Installation
          </label>
          <select
            id="fork-installation-select"
            class="dialog-input dialog-select"
            value={selectedInstallationId}
            onInput={(event) => onSelectInstallation((event.target as HTMLSelectElement).value)}
            disabled={installations.length <= 1 || submitting}
          >
            {installations.map((installation) => (
              <option key={installation.installationId} value={installation.installationId}>
                {installation.accountLogin ?? installation.installationId}
              </option>
            ))}
          </select>
          <select
            id="fork-repo-select"
            class="dialog-input dialog-select"
            value={selectedRepoFullName}
            onInput={(event) => onSelectRepo((event.target as HTMLSelectElement).value)}
            disabled={repoSelectDisabled}
            aria-label="Target repo"
          >
            {reposLoading ? (
              <option value="">Loading repos...</option>
            ) : repos.length === 0 ? (
              <option value="">{reposLoadError ? 'Failed to load repos' : 'No repos available'}</option>
            ) : null}
            {repos.map((repo) => (
              <option key={repo.id} value={repo.full_name}>
                {repo.full_name}
                {currentTargetFullName !== null && repo.full_name.toLowerCase() === currentTargetFullName.toLowerCase()
                  ? ' (currently selected)'
                  : ''}
              </option>
            ))}
          </select>
          {reposLoadError ? <p class="dialog-message">{reposLoadError}</p> : null}
          {reposLoadError && onRetryRepos ? (
            <div class="dialog-actions">
              <button type="button" onClick={onRetryRepos} disabled={reposLoading || submitting}>
                Retry repos
              </button>
            </div>
          ) : null}
          <div class="dialog-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              ref={confirmButtonRef}
              type="button"
              class="dialog-action-success"
              onClick={onConfirm}
              disabled={!selectedRepoFullName || reposLoading || submitting}
            >
              Fork
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
