import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import { useMemo, useRef, useState } from 'preact/hooks';
import { GroupedRepoMenu, type GroupedRepoMenuGroup } from './GroupedRepoMenu';

interface ForkRepoDialogProps {
  open: boolean;
  selectedInstallationId: string;
  repoGroups: GroupedRepoMenuGroup[];
  selectedRepoFullName: string;
  submitting?: boolean;
  onSelectRepo: (selection: { installationId: string; fullName: string }) => void;
  onRetryRepos?: (installationId: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function ForkRepoDialog({
  open,
  selectedInstallationId,
  repoGroups,
  selectedRepoFullName,
  submitting = false,
  onSelectRepo,
  onRetryRepos,
  onConfirm,
  onClose,
}: ForkRepoDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const repoOptionsAvailable = repoGroups.some((group) => group.repos.length > 0);
  const repoSelectDisabled = submitting || !repoOptionsAvailable;
  const selectedRepoLabel = useMemo(() => {
    const selectedGroup = repoGroups.find((group) => group.installationId === selectedInstallationId);
    const selectedRepo = selectedGroup?.repos.find((repo) => repo.fullName === selectedRepoFullName);
    if (selectedRepo) return selectedRepo.fullName;
    if (repoGroups.some((group) => group.loading)) return 'Loading repos...';
    return 'Choose a target repo';
  }, [repoGroups, selectedInstallationId, selectedRepoFullName]);

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
          ref={contentRef}
          class="dialog-content"
          onOpenAutoFocus={(event: Event) => {
            event.preventDefault();
            setTimeout(() => confirmButtonRef.current?.focus(), 0);
          }}
          onInteractOutside={(event: Event) => {
            if (!repoMenuOpen) return;
            event.preventDefault();
            setRepoMenuOpen(false);
          }}
        >
          <DialogPrimitive.Title class="dialog-title">Fork this document</DialogPrimitive.Title>
          <DialogPrimitive.Description class="dialog-message">
            Choose a repo to create a new file with this document&apos;s contents.
          </DialogPrimitive.Description>
          <Popover.Root open={repoMenuOpen} onOpenChange={setRepoMenuOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                class="dialog-input dialog-menu-trigger"
                disabled={repoSelectDisabled}
                aria-label="Target repo"
              >
                <span class="dialog-menu-trigger-label">{selectedRepoLabel}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </Popover.Trigger>
            <Popover.Portal container={contentRef.current ?? undefined}>
              <Popover.Content
                class="repo-menu-content fork-repo-menu-content"
                sideOffset={6}
                align="start"
                onOpenAutoFocus={(event: Event) => {
                  event.preventDefault();
                }}
                onCloseAutoFocus={(event: Event) => {
                  event.preventDefault();
                }}
              >
                <GroupedRepoMenu
                  repoGroups={repoGroups}
                  selectedInstallationId={selectedInstallationId}
                  selectedRepoFullName={selectedRepoFullName}
                  submitting={submitting}
                  onSelectRepo={onSelectRepo}
                  onRetryRepos={onRetryRepos}
                  onDismiss={() => setRepoMenuOpen(false)}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <div class="dialog-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              ref={confirmButtonRef}
              type="button"
              class="dialog-action-success"
              onClick={onConfirm}
              disabled={!selectedRepoFullName || submitting}
            >
              Fork
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
