import { createContext } from 'preact';
import { useState, useCallback, useContext, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';

interface DialogContextValue {
  showAlert: (message: string) => Promise<void>;
  showConfirm: (message: string) => Promise<boolean>;
  showPrompt: (message: string, defaultValue?: string) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialogs(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialogs must be used within DialogProvider');
  return ctx;
}

type DialogState =
  | { type: 'alert'; message: string; resolve: () => void }
  | { type: 'confirm'; message: string; resolve: (value: boolean) => void }
  | { type: 'prompt'; message: string; defaultValue: string; resolve: (value: string | null) => void };

export function DialogProvider({ children }: { children: ComponentChildren }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const promptInputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => setDialog(null), []);

  const showAlert = useCallback((message: string): Promise<void> => {
    return new Promise(resolve => {
      setDialog({ type: 'alert', message, resolve });
    });
  }, []);

  const showConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise(resolve => {
      setDialog({ type: 'confirm', message, resolve });
    });
  }, []);

  const showPrompt = useCallback((message: string, defaultValue = ''): Promise<string | null> => {
    return new Promise(resolve => {
      setPromptValue(defaultValue);
      setDialog({ type: 'prompt', message, defaultValue, resolve });
    });
  }, []);

  return (
    <DialogContext.Provider value={{ showAlert, showConfirm, showPrompt }}>
      {children}

      {/* Alert Dialog */}
      {dialog?.type === 'alert' && (
        <AlertDialogPrimitive.Root
          open
          onOpenChange={(open: boolean) => {
            if (!open) { dialog.resolve(); close(); }
          }}
        >
          <AlertDialogPrimitive.Portal>
            <AlertDialogPrimitive.Overlay class="dialog-overlay" />
            <AlertDialogPrimitive.Content class="dialog-content">
              <AlertDialogPrimitive.Description class="dialog-message">
                {dialog.message}
              </AlertDialogPrimitive.Description>
              <div class="dialog-actions">
                <AlertDialogPrimitive.Action asChild>
                  <button type="button" onClick={() => { dialog.resolve(); close(); }}>
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
            if (!open) { dialog.resolve(false); close(); }
          }}
        >
          <AlertDialogPrimitive.Portal>
            <AlertDialogPrimitive.Overlay class="dialog-overlay" />
            <AlertDialogPrimitive.Content class="dialog-content">
              <AlertDialogPrimitive.Description class="dialog-message">
                {dialog.message}
              </AlertDialogPrimitive.Description>
              <div class="dialog-actions">
                <AlertDialogPrimitive.Cancel asChild>
                  <button type="button" onClick={() => { dialog.resolve(false); close(); }}>
                    Cancel
                  </button>
                </AlertDialogPrimitive.Cancel>
                <AlertDialogPrimitive.Action asChild>
                  <button type="button" onClick={() => { dialog.resolve(true); close(); }}>
                    OK
                  </button>
                </AlertDialogPrimitive.Action>
              </div>
            </AlertDialogPrimitive.Content>
          </AlertDialogPrimitive.Portal>
        </AlertDialogPrimitive.Root>
      )}

      {/* Prompt Dialog */}
      {dialog?.type === 'prompt' && (
        <DialogPrimitive.Root
          open
          onOpenChange={(open: boolean) => {
            if (!open) { dialog.resolve(null); close(); }
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
              <DialogPrimitive.Description class="dialog-message">
                {dialog.message}
              </DialogPrimitive.Description>
              <input
                ref={promptInputRef}
                class="dialog-input"
                type="text"
                value={promptValue}
                onInput={e => setPromptValue((e.target as HTMLInputElement).value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { dialog.resolve(promptValue); close(); }
                }}
              />
              <div class="dialog-actions">
                <button type="button" onClick={() => { dialog.resolve(null); close(); }}>
                  Cancel
                </button>
                <button type="button" onClick={() => { dialog.resolve(promptValue); close(); }}>
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
