import { createContext } from 'preact';
import { useState, useCallback, useContext } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import * as ToastPrimitive from '@radix-ui/react-toast';

interface ToastContextValue {
  showToast: (message: string) => void;
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
}

let nextId = 0;

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const showToast = useCallback((message: string) => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, message }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      <ToastPrimitive.Provider duration={3000}>
        {children}
        {toasts.map(t => (
          <ToastPrimitive.Root
            key={t.id}
            class="toast-root"
            onOpenChange={(open: boolean) => { if (!open) removeToast(t.id); }}
          >
            <ToastPrimitive.Description>{t.message}</ToastPrimitive.Description>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport class="toast-viewport" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
