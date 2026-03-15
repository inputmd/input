import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useRef, useState } from 'preact/hooks';
import type { DiffChangeEntry } from './DiffViewer';
import { SideBySideDiffView } from './DiffViewer';

interface DialogContextValue {
  showAlert: (message: string) => Promise<void>;
  showConfirm: (message: string, options?: ConfirmDialogOptions) => Promise<boolean>;
  showDiffChoice: (
    message: string,
    changes: DiffChangeEntry[],
    options: DiffChoiceDialogOptions,
  ) => Promise<'cancel' | 'tertiary' | 'secondary' | 'primary'>;
  showPrompt: (message: string, defaultValue?: string) => Promise<string | null>;
}

type ConfirmDialogIntent = 'default' | 'danger' | 'warning' | 'success';
type ConfirmDialogFocus = 'cancel' | 'action';

interface ConfirmDialogOptions {
  intent?: ConfirmDialogIntent;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultFocus?: ConfirmDialogFocus;
}

interface DiffConfirmDialogOptions extends ConfirmDialogOptions {
  leftLabel?: string;
  rightLabel?: string;
}

interface DiffChoiceDialogOptions extends DiffConfirmDialogOptions {
  tertiaryActionLabel?: string;
  tertiaryActionIntent?: ConfirmDialogIntent;
  secondaryActionLabel: string;
  secondaryActionIntent?: ConfirmDialogIntent;
  primaryActionLabel: string;
  primaryActionIntent?: ConfirmDialogIntent;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialogs(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialogs must be used within DialogProvider');
  return ctx;
}

type DialogState =
  | { type: 'alert'; message: string; resolve: () => void }
  | {
      type: 'confirm';
      message: string;
      resolve: (value: boolean) => void;
      options: Required<ConfirmDialogOptions>;
    }
  | {
      type: 'diff-choice';
      message: string;
      changes: DiffChangeEntry[];
      resolve: (value: 'cancel' | 'tertiary' | 'secondary' | 'primary') => void;
      options: Pick<
        Required<DiffChoiceDialogOptions>,
        'leftLabel' | 'rightLabel' | 'secondaryActionLabel' | 'primaryActionLabel'
      > & {
        defaultFocus: ConfirmDialogFocus;
        title: string;
        tertiaryActionLabel?: string;
        tertiaryActionIntent: ConfirmDialogIntent;
        secondaryActionIntent: ConfirmDialogIntent;
        primaryActionIntent: ConfirmDialogIntent;
        cancelLabel: string;
      };
    }
  | { type: 'prompt'; message: string; defaultValue: string; resolve: (value: string | null) => void };

export function DialogProvider({ children }: { children: ComponentChildren }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const promptInputRef = useRef<HTMLInputElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const confirmTertiaryActionRef = useRef<HTMLButtonElement>(null);
  const confirmActionRef = useRef<HTMLButtonElement>(null);
  const confirmSecondaryActionRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setDialog(null), []);

  const showAlert = useCallback((message: string): Promise<void> => {
    return new Promise((resolve) => {
      setDialog({ type: 'alert', message, resolve });
    });
  }, []);

  const showConfirm = useCallback((message: string, options?: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const intent = options?.intent ?? 'default';
      setDialog({
        type: 'confirm',
        message,
        resolve,
        options: {
          intent,
          title: options?.title ?? 'Confirm',
          confirmLabel: options?.confirmLabel ?? (intent === 'danger' ? 'Delete' : 'OK'),
          cancelLabel: options?.cancelLabel ?? 'Cancel',
          defaultFocus: options?.defaultFocus ?? (intent === 'danger' ? 'action' : 'cancel'),
        },
      });
    });
  }, []);

  const showPrompt = useCallback((message: string, defaultValue = ''): Promise<string | null> => {
    return new Promise((resolve) => {
      setPromptValue(defaultValue);
      setDialog({ type: 'prompt', message, defaultValue, resolve });
    });
  }, []);

  const showDiffChoice = useCallback(
    (
      message: string,
      changes: DiffChangeEntry[],
      options: DiffChoiceDialogOptions,
    ): Promise<'cancel' | 'tertiary' | 'secondary' | 'primary'> => {
      return new Promise((resolve) => {
        setDialog({
          type: 'diff-choice',
          message,
          changes,
          resolve,
          options: {
            title: options.title ?? 'Confirm',
            cancelLabel: options.cancelLabel ?? 'Cancel',
            defaultFocus: options.defaultFocus ?? 'cancel',
            leftLabel: options.leftLabel ?? 'Original',
            rightLabel: options.rightLabel ?? 'Updated',
            tertiaryActionLabel: options.tertiaryActionLabel,
            tertiaryActionIntent: options.tertiaryActionIntent ?? 'default',
            secondaryActionLabel: options.secondaryActionLabel,
            primaryActionLabel: options.primaryActionLabel,
            secondaryActionIntent: options.secondaryActionIntent ?? 'default',
            primaryActionIntent: options.primaryActionIntent ?? 'default',
          },
        });
      });
    },
    [],
  );

  const dialogActionClassName = (intent: ConfirmDialogIntent): string | undefined => {
    if (intent === 'danger') return 'dialog-action-danger';
    if (intent === 'warning') return 'dialog-action-warning';
    if (intent === 'success') return 'dialog-action-success';
    return undefined;
  };

  return (
    <DialogContext.Provider value={{ showAlert, showConfirm, showDiffChoice, showPrompt }}>
      {children}

      {/* Alert Dialog */}
      {dialog?.type === 'alert' && (
        <AlertDialogPrimitive.Root
          open
          onOpenChange={(open: boolean) => {
            if (!open) {
              dialog.resolve();
              close();
            }
          }}
        >
          <AlertDialogPrimitive.Portal>
            <AlertDialogPrimitive.Overlay class="dialog-overlay" />
            <AlertDialogPrimitive.Content class="dialog-content">
              <AlertDialogPrimitive.Title class="dialog-title">Alert</AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description class="dialog-message">
                {dialog.message}
              </AlertDialogPrimitive.Description>
              <div class="dialog-actions">
                <AlertDialogPrimitive.Action asChild>
                  <button
                    type="button"
                    onClick={() => {
                      dialog.resolve();
                      close();
                    }}
                  >
                    OK
                  </button>
                </AlertDialogPrimitive.Action>
              </div>
            </AlertDialogPrimitive.Content>
          </AlertDialogPrimitive.Portal>
        </AlertDialogPrimitive.Root>
      )}

      {/* Confirm Dialog */}
      {dialog?.type === 'confirm' && (
        <AlertDialogPrimitive.Root
          open
          onOpenChange={(open: boolean) => {
            if (!open) {
              dialog.resolve(false);
              close();
            }
          }}
        >
          <AlertDialogPrimitive.Portal>
            <AlertDialogPrimitive.Overlay class="dialog-overlay" />
            <AlertDialogPrimitive.Content
              class="dialog-content"
              onOpenAutoFocus={(e: Event) => {
                if (dialog.options.defaultFocus === 'action') {
                  e.preventDefault();
                  setTimeout(() => confirmActionRef.current?.focus(), 0);
                  return;
                }
                setTimeout(() => confirmCancelRef.current?.focus(), 0);
              }}
            >
              <AlertDialogPrimitive.Title class="dialog-title">{dialog.options.title}</AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description class="dialog-message">
                {dialog.message}
              </AlertDialogPrimitive.Description>
              <div class="dialog-actions">
                <AlertDialogPrimitive.Cancel asChild>
                  <button
                    ref={confirmCancelRef}
                    type="button"
                    onClick={() => {
                      dialog.resolve(false);
                      close();
                    }}
                  >
                    {dialog.options.cancelLabel}
                  </button>
                </AlertDialogPrimitive.Cancel>
                <AlertDialogPrimitive.Action asChild>
                  <button
                    ref={confirmActionRef}
                    class={dialogActionClassName(dialog.options.intent)}
                    type="button"
                    onClick={() => {
                      dialog.resolve(true);
                      close();
                    }}
                  >
                    {dialog.options.confirmLabel}
                  </button>
                </AlertDialogPrimitive.Action>
              </div>
            </AlertDialogPrimitive.Content>
          </AlertDialogPrimitive.Portal>
        </AlertDialogPrimitive.Root>
      )}

      {dialog?.type === 'diff-choice' && (
        <DialogPrimitive.Root
          open
          onOpenChange={(open: boolean) => {
            if (!open) {
              dialog.resolve('cancel');
              close();
            }
          }}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay class="dialog-overlay" />
            <DialogPrimitive.Content
              class="dialog-content dialog-content--diff"
              onOpenAutoFocus={(e: Event) => {
                if (dialog.options.defaultFocus === 'action') {
                  e.preventDefault();
                  setTimeout(() => confirmActionRef.current?.focus(), 0);
                  return;
                }
                setTimeout(() => confirmCancelRef.current?.focus(), 0);
              }}
            >
              <DialogPrimitive.Title class="dialog-title">{dialog.options.title}</DialogPrimitive.Title>
              <DialogPrimitive.Description class="dialog-message">{dialog.message}</DialogPrimitive.Description>
              <div class="dialog-diff-frame">
                <SideBySideDiffView
                  changes={dialog.changes}
                  leftLabel={dialog.options.leftLabel}
                  rightLabel={dialog.options.rightLabel}
                />
              </div>
              <div class="dialog-actions">
                <button
                  ref={confirmCancelRef}
                  type="button"
                  onClick={() => {
                    dialog.resolve('cancel');
                    close();
                  }}
                >
                  {dialog.options.cancelLabel}
                </button>
                {dialog.options.tertiaryActionLabel ? (
                  <button
                    ref={confirmTertiaryActionRef}
                    class={dialogActionClassName(dialog.options.tertiaryActionIntent)}
                    type="button"
                    onClick={() => {
                      dialog.resolve('tertiary');
                      close();
                    }}
                  >
                    {dialog.options.tertiaryActionLabel}
                  </button>
                ) : null}
                <button
                  ref={confirmSecondaryActionRef}
                  class={dialogActionClassName(dialog.options.secondaryActionIntent)}
                  type="button"
                  onClick={() => {
                    dialog.resolve('secondary');
                    close();
                  }}
                >
                  {dialog.options.secondaryActionLabel}
                </button>
                <button
                  ref={confirmActionRef}
                  class={dialogActionClassName(dialog.options.primaryActionIntent)}
                  type="button"
                  onClick={() => {
                    dialog.resolve('primary');
                    close();
                  }}
                >
                  {dialog.options.primaryActionLabel}
                </button>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}

      {/* Prompt Dialog */}
      {dialog?.type === 'prompt' && (
        <DialogPrimitive.Root
          open
          onOpenChange={(open: boolean) => {
            if (!open) {
              dialog.resolve(null);
              close();
            }
          }}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay class="dialog-overlay" />
            <DialogPrimitive.Content
              class="dialog-content"
              onOpenAutoFocus={(e: Event) => {
                e.preventDefault();
                setTimeout(() => promptInputRef.current?.focus(), 0);
              }}
            >
              <DialogPrimitive.Description class="dialog-message">{dialog.message}</DialogPrimitive.Description>
              <input
                ref={promptInputRef}
                class="dialog-input"
                type="text"
                value={promptValue}
                onInput={(e) => setPromptValue((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    dialog.resolve(promptValue);
                    close();
                  }
                }}
              />
              <div class="dialog-actions">
                <button
                  type="button"
                  onClick={() => {
                    dialog.resolve(null);
                    close();
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    dialog.resolve(promptValue);
                    close();
                  }}
                >
                  OK
                </button>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}
    </DialogContext.Provider>
  );
}
