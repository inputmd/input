import * as ToastPrimitive from '@radix-ui/react-toast';
import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useState } from 'preact/hooks';

interface ToastContextValue {
  showToast: (message: string) => void;
  showSuccessToast: (message: string) => void;
  showFailureToast: (message: string) => void;
  showLoadingToast: (message: string) => number;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

interface ToastEntry {
  id: number;
  message: string;
  variant: 'default' | 'success' | 'failure' | 'loading';
  duration?: number;
  createdAt: number;
}

let nextId = 0;
const TOAST_DEDUPE_WINDOW_MS = 4_000;

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const enqueueToast = useCallback(
    (message: string, variant: ToastEntry['variant'], duration?: number): number | null => {
      const now = Date.now();
      let createdId: number | null = null;
      setToasts((prev) => {
        const duplicate =
          variant === 'loading'
            ? false
            : prev.some((toast) => {
                if (toast.variant !== variant) return false;
                if (toast.message !== message) return false;
                return now - toast.createdAt <= TOAST_DEDUPE_WINDOW_MS;
              });
        if (duplicate) return prev;
        const id = nextId++;
        createdId = id;
        return [...prev, { id, message, variant, duration, createdAt: now }];
      });
      return createdId;
    },
    [],
  );

  const showToast = useCallback(
    (message: string) => {
      void enqueueToast(message, 'default');
    },
    [enqueueToast],
  );

  const showSuccessToast = useCallback(
    (message: string) => {
      void enqueueToast(message, 'success');
    },
    [enqueueToast],
  );

  const showFailureToast = useCallback(
    (message: string) => {
      void enqueueToast(message, 'failure');
    },
    [enqueueToast],
  );

  const showLoadingToast = useCallback(
    (message: string) => {
      const id = enqueueToast(message, 'loading', 60_000);
      return id ?? -1;
    },
    [enqueueToast],
  );

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissToast = useCallback(
    (id: number) => {
      removeToast(id);
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ showToast, showSuccessToast, showFailureToast, showLoadingToast, dismissToast }}>
      <ToastPrimitive.Provider duration={3000}>
        {children}
        {toasts.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            class={`toast-root${t.variant === 'success' ? ' toast-root--success' : ''}${t.variant === 'failure' ? ' toast-root--failure' : ''}${t.variant === 'loading' ? ' toast-root--loading' : ''}`}
            duration={t.duration}
            onOpenChange={(open: boolean) => {
              if (!open) removeToast(t.id);
            }}
          >
            <ToastPrimitive.Description>{t.message}</ToastPrimitive.Description>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport class="toast-viewport" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
