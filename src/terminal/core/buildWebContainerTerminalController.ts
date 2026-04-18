import type { WebContainerTerminalPaneId } from './config.ts';
import type { WebContainerTerminalController, WebContainerTerminalPersistenceDialogState } from './controllerTypes.ts';
import type { TerminalPersistedHomePromptState } from './useTerminalPersistedHome.ts';

interface BuildWebContainerTerminalControllerOptions {
  activePaneId: WebContainerTerminalPaneId;
  activeShellReady: boolean;
  activeShellSessionId: number;
  closePersistenceDialog: () => void;
  closePersistedHomePrompt: () => void;
  closeSplitPane: (position: 'top' | 'bottom') => void;
  credentialSyncEnabled: boolean | null;
  dismissWorkspaceNotice: () => void;
  downloadFromWebContainer: () => Promise<void>;
  downloadInProgress: boolean;
  error: string | null;
  focusPane: () => void;
  fsReady: boolean;
  hasHostBridgeError: boolean;
  maxPaneCount: number;
  openPersistedHomeReconfigurePrompt: () => void;
  openPersistenceDialog: () => Promise<void>;
  openSplitTerminal: () => void;
  persistedHomePromptState: TerminalPersistedHomePromptState | null;
  persistenceDialog: WebContainerTerminalPersistenceDialogState;
  primaryShellSessionId: number;
  resetBannerPaneId: WebContainerTerminalPaneId | null;
  resetBannerText: string | null;
  restartingWebContainer: boolean;
  resettingShell: boolean;
  restartShell: () => Promise<void>;
  restartWebContainer: () => Promise<void>;
  secondaryShellSessionId: number;
  selectPane: (paneId: WebContainerTerminalPaneId) => void;
  setPaneContainer: (paneId: WebContainerTerminalPaneId, node: HTMLDivElement | null) => void;
  settlePersistedHomePrompt: (restorePersistedHome: boolean) => void;
  splitOpen: boolean;
  visiblePaneIds: WebContainerTerminalPaneId[];
  workspaceChangesNotice: string | null;
  workspaceNoticeVisible: boolean;
}

export function buildWebContainerTerminalController({
  activePaneId,
  activeShellReady,
  activeShellSessionId,
  closePersistenceDialog,
  closePersistedHomePrompt,
  closeSplitPane,
  credentialSyncEnabled,
  dismissWorkspaceNotice,
  downloadFromWebContainer,
  downloadInProgress,
  error,
  focusPane,
  fsReady,
  hasHostBridgeError,
  maxPaneCount,
  openPersistedHomeReconfigurePrompt,
  openPersistenceDialog,
  openSplitTerminal,
  persistedHomePromptState,
  persistenceDialog,
  primaryShellSessionId,
  resetBannerPaneId,
  resetBannerText,
  restartingWebContainer,
  resettingShell,
  restartShell,
  restartWebContainer,
  secondaryShellSessionId,
  selectPane,
  setPaneContainer,
  settlePersistedHomePrompt,
  splitOpen,
  visiblePaneIds,
  workspaceChangesNotice,
  workspaceNoticeVisible,
}: BuildWebContainerTerminalControllerOptions): WebContainerTerminalController {
  const canManageSplit = maxPaneCount > 1 && !error && !restartingWebContainer && !resettingShell;
  const canResetTerminal =
    !error && fsReady && !resettingShell && !restartingWebContainer && (activeShellReady || activeShellSessionId > 0);
  const canRestartWebContainer =
    !error &&
    !resettingShell &&
    !restartingWebContainer &&
    (fsReady || primaryShellSessionId > 0 || secondaryShellSessionId > 0);
  const canDownloadFromWebContainer = !error && fsReady && !restartingWebContainer && !downloadInProgress;
  const credentialSyncLabel =
    credentialSyncEnabled === null
      ? 'Sync loading...'
      : credentialSyncEnabled
        ? 'Credential sync on'
        : 'Credential sync off';
  const credentialSyncMenuNote =
    credentialSyncEnabled === null
      ? 'Loading...'
      : credentialSyncEnabled
        ? 'Credentials and sessions are automatically synced across terminals.'
        : 'Untrusted repo, credentials and sessions will be deleted on exit.';
  const networkingLabel = hasHostBridgeError ? 'Networking error' : 'Networking on';

  return {
    activePaneId,
    actions: {
      closePersistenceDialog,
      closePersistedHomePrompt() {
        closePersistedHomePrompt();
        focusPane();
      },
      closeSplitPane,
      async downloadFromWebContainer() {
        await downloadFromWebContainer();
      },
      openPersistedHomeReconfigurePrompt,
      async openPersistenceDialog() {
        await openPersistenceDialog();
      },
      openSplitTerminal,
      async restartShell() {
        await restartShell();
      },
      async restartWebContainer() {
        await restartWebContainer();
      },
      selectPane,
      setPaneContainer,
      settlePersistedHomePrompt,
    },
    canDownloadFromWebContainer,
    canManageSplit,
    canResetTerminal,
    canRestartWebContainer,
    error,
    persistedHomePromptState,
    persistenceDialog,
    resetBannerPaneId,
    resetBannerText,
    splitOpen,
    status: {
      credentialSyncLabel,
      credentialSyncMenuNote,
      networkingLabel,
    },
    visiblePaneIds,
    workspaceNotice: {
      dismiss: dismissWorkspaceNotice,
      message: workspaceChangesNotice,
      visible: workspaceNoticeVisible,
    },
  };
}
