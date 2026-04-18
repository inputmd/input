import { useEffect, useState } from 'preact/hooks';
import { getDocumentThemeMode, type TerminalThemeMode } from './runtime_shared.ts';

export function useTerminalThemeMode(): TerminalThemeMode {
  const [terminalThemeMode, setTerminalThemeMode] = useState<TerminalThemeMode>(() => getDocumentThemeMode());

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const syncThemeMode = () => {
      setTerminalThemeMode((current) => {
        const next = getDocumentThemeMode();
        return current === next ? current : next;
      });
    };
    syncThemeMode();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          syncThemeMode();
          break;
        }
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return terminalThemeMode;
}
