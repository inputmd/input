import { useMemo } from 'preact/hooks';
import type { EditSessionViewProps } from '../views/EditSessionView';
import type { RepoEditorBinding } from './types';

interface UseRepoEditorBindingArgs {
  baseProps: Omit<EditSessionViewProps, 'canSave' | 'readerAiFloatingActions' | 'imageUploadIssue'>;
  canSave: boolean;
  floatingActions: {
    visible: boolean;
    applying: boolean;
    canApply: boolean;
    changeCount: number;
    applyLabel: string;
    onApply: () => void;
    onDiscard: () => void;
  } | null;
  failedImageUpload: { imageName: string } | null;
  onRetryFailedImageUpload: () => void;
  onRemoveFailedImageUploadPlaceholder: () => void;
}

export function useRepoEditorBinding({
  baseProps,
  canSave,
  floatingActions,
  failedImageUpload,
  onRetryFailedImageUpload,
  onRemoveFailedImageUploadPlaceholder,
}: UseRepoEditorBindingArgs): RepoEditorBinding {
  return useMemo(
    () => ({
      props: {
        ...baseProps,
        canSave,
        readerAiFloatingActions: floatingActions?.visible
          ? {
              applying: floatingActions.applying,
              canApply: floatingActions.canApply,
              changeCount: floatingActions.changeCount,
              applyLabel: floatingActions.applyLabel,
              onApply: floatingActions.onApply,
              onDiscard: floatingActions.onDiscard,
            }
          : null,
        imageUploadIssue: failedImageUpload
          ? {
              message: `Image upload failed for ${failedImageUpload.imageName}.`,
              onRetry: onRetryFailedImageUpload,
              onRemovePlaceholder: onRemoveFailedImageUploadPlaceholder,
            }
          : null,
      },
    }),
    [
      baseProps,
      canSave,
      failedImageUpload,
      floatingActions,
      onRemoveFailedImageUploadPlaceholder,
      onRetryFailedImageUpload,
    ],
  );
}
