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
}

let nextId = 0;

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const showToast = useCallback((message: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, variant: 'default' }]);
  }, []);

  const showSuccessToast = useCallback((message: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, variant: 'success' }]);
  }, []);

  const showFailureToast = useCallback((message: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, variant: 'failure' }]);
  }, []);

  const showLoadingToast = useCallback((message: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, variant: 'loading', duration: 60_000 }]);
    return id;
  }, []);

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
