import type { WebContainerTerminalControllerDialogs } from './controllerTypes.ts';

export type WebContainerTerminalControllerDialogOverrides = Partial<WebContainerTerminalControllerDialogs> | null;

async function showAlertFallback(message: string): Promise<void> {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message);
    return;
  }
  console.error('[terminal] alert:', message);
}

async function showPromptFallback(message: string, defaultValue = ''): Promise<string | null> {
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    return window.prompt(message, defaultValue);
  }
  return null;
}

export function resolveWebContainerTerminalDialogs(
  dialogs?: WebContainerTerminalControllerDialogOverrides,
): WebContainerTerminalControllerDialogs {
  return {
    showAlert: dialogs?.showAlert ?? showAlertFallback,
    showPrompt: dialogs?.showPrompt ?? showPromptFallback,
  };
}
