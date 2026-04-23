export const APP_SHORTCUTS_ALLOWED_ATTR = 'data-allow-app-shortcuts';
export const TERMINAL_OPTION_ENTER_SEQUENCE = '\x1b\r';

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(`[${APP_SHORTCUTS_ALLOWED_ATTR}="true"]`) !== null) return false;
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

export function matchesControlShortcut(event: KeyboardEvent, key: string): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === key;
}

export function matchesPrimaryShortcut(event: KeyboardEvent, key: string): boolean {
  const usesSinglePrimaryModifier = (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey);
  return usesSinglePrimaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === key;
}

export function shouldBypassTerminalMetaShortcut(event: KeyboardEvent): boolean {
  if (!event.metaKey) return false;
  if (event.code === 'KeyC' || event.code === 'KeyV') return false;
  if (!event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyK') return false;
  return true;
}

export function getTerminalInputOverride(event: KeyboardEvent): string | null {
  if (event.isComposing) return null;
  if (event.key !== 'Enter') return null;
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  return TERMINAL_OPTION_ENTER_SEQUENCE;
}
