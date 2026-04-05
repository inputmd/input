import * as ToastPrimitive from '@radix-ui/react-toast';
import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';

interface ToastContextValue {
  showToast: (message: string) => void;
  showSuccessToast: (message: string) => void;
  showFailureToast: (message: string) => void;
  showWarningToast: (message: string) => void;
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
  variant: 'default' | 'success' | 'failure' | 'warning' | 'loading';
  duration?: number;
  createdAt: number;
}

let nextId = 0;
const TOAST_DEDUPE_WINDOW_MS = 4_000;

function ToastHost({
  subscribe,
  removeToast,
}: {
  subscribe: (listener: (toasts: ToastEntry[]) => void) => () => void;
  removeToast: (id: number) => void;
}) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => subscribe(setToasts), [subscribe]);

  return (
    <ToastPrimitive.Provider duration={3000}>
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          class={`toast-root${t.variant === 'success' ? ' toast-root--success' : ''}${t.variant === 'failure' ? ' toast-root--failure' : ''}${t.variant === 'warning' ? ' toast-root--warning' : ''}${t.variant === 'loading' ? ' toast-root--loading' : ''}`}
          duration={t.duration}
          onClick={() => {
            removeToast(t.id);
          }}
          onOpenChange={(open: boolean) => {
            if (!open) removeToast(t.id);
          }}
        >
          <ToastPrimitive.Description>{t.message}</ToastPrimitive.Description>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport class="toast-viewport" />
    </ToastPrimitive.Provider>
  );
}

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const listenersRef = useRef(new Set<(toasts: ToastEntry[]) => void>());
  const toastsRef = useRef<ToastEntry[]>([]);

  const publish = useCallback((toasts: ToastEntry[]) => {
    toastsRef.current = toasts;
    listenersRef.current.forEach((listener) => {
      listener(toasts);
    });
  }, []);

  const subscribe = useCallback((listener: (toasts: ToastEntry[]) => void) => {
    listenersRef.current.add(listener);
    listener(toastsRef.current);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const enqueueToast = useCallback(
    (message: string, variant: ToastEntry['variant'], duration?: number): number | null => {
      const now = Date.now();
      let createdId: number | null = null;
      const duplicate =
        variant === 'loading'
          ? false
          : toastsRef.current.some((toast) => {
              if (toast.variant !== variant) return false;
              if (toast.message !== message) return false;
              return now - toast.createdAt <= TOAST_DEDUPE_WINDOW_MS;
            });
      if (duplicate) return createdId;
      const id = nextId++;
      createdId = id;
      publish([...toastsRef.current, { id, message, variant, duration, createdAt: now }]);
      return createdId;
    },
    [publish],
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

  const showWarningToast = useCallback(
    (message: string) => {
      void enqueueToast(message, 'warning');
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

  const removeToast = useCallback(
    (id: number) => {
      publish(toastsRef.current.filter((t) => t.id !== id));
    },
    [publish],
  );

  const dismissToast = useCallback(
    (id: number) => {
      removeToast(id);
    },
    [removeToast],
  );

  const contextValue = useMemo(
    () => ({ showToast, showSuccessToast, showFailureToast, showWarningToast, showLoadingToast, dismissToast }),
    [dismissToast, showFailureToast, showLoadingToast, showSuccessToast, showToast, showWarningToast],
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastHost subscribe={subscribe} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}
