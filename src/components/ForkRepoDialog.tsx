import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef } from 'preact/hooks';
import type { InstallationRepo } from '../github_app';

interface ForkRepoDialogProps {
  open: boolean;
  repos: InstallationRepo[];
  selectedRepoFullName: string;
  submitting?: boolean;
  onSelectRepo: (fullName: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function ForkRepoDialog({
  open,
  repos,
  selectedRepoFullName,
  submitting = false,
  onSelectRepo,
  onConfirm,
  onClose,
}: ForkRepoDialogProps) {
  const selectRef = useRef<HTMLSelectElement | null>(null);

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
            setTimeout(() => selectRef.current?.focus(), 0);
          }}
        >
          <DialogPrimitive.Title class="dialog-title">Fork this Repo</DialogPrimitive.Title>
          <DialogPrimitive.Description class="dialog-message">
            Choose a repo in the current installation to create a new file with this document&apos;s contents.
          </DialogPrimitive.Description>
          <label class="dialog-field-label" for="fork-repo-select">
            Target repo
          </label>
          <select
            id="fork-repo-select"
            ref={selectRef}
            class="dialog-input dialog-select"
            value={selectedRepoFullName}
            onInput={(event) => onSelectRepo((event.target as HTMLSelectElement).value)}
            disabled={repos.length === 0 || submitting}
          >
            {repos.map((repo) => (
              <option key={repo.id} value={repo.full_name}>
                {repo.full_name}
              </option>
            ))}
          </select>
          <div class="dialog-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="button" onClick={onConfirm} disabled={!selectedRepoFullName || submitting}>
              Fork to Repo
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
