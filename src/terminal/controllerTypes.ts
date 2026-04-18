import type { PersistedHomeInspectionSnapshot } from '../persisted_home_state.ts';
import type { WebContainerTerminalConfig, WebContainerTerminalPaneId } from './config.ts';
import type { TerminalPersistedHomePromptState } from './useTerminalPersistedHome.ts';

export interface WebContainerTerminalControllerDialogs {
  showAlert: (message: string) => Promise<void>;
  showPrompt: (message: string, defaultValue?: string) => Promise<string | null>;
}

export interface UseWebContainerTerminalControllerOptions {
  config: WebContainerTerminalConfig;
  dialogs: WebContainerTerminalControllerDialogs;
  visible: boolean;
  workspaceChangesPersisted?: boolean;
  workspaceChangesNotice?: string | null;
}

export interface WebContainerTerminalPersistenceDialogState {
  error: string | null;
  loading: boolean;
  open: boolean;
  snapshot: PersistedHomeInspectionSnapshot | null;
}

export interface WebContainerTerminalController {
  activePaneId: WebContainerTerminalPaneId;
  actions: {
    closePersistenceDialog: () => void;
    closePersistedHomePrompt: () => void;
    closeSplitPane: (position: 'top' | 'bottom') => void;
    downloadFromWebContainer: () => Promise<void>;
    openPersistedHomeReconfigurePrompt: () => void;
    openPersistenceDialog: () => Promise<void>;
    openSplitTerminal: () => void;
    restartShell: () => Promise<void>;
    restartWebContainer: () => Promise<void>;
    selectPane: (paneId: WebContainerTerminalPaneId) => void;
    setPaneContainer: (paneId: WebContainerTerminalPaneId, node: HTMLDivElement | null) => void;
    settlePersistedHomePrompt: (restorePersistedHome: boolean) => void;
  };
  canDownloadFromWebContainer: boolean;
  canManageSplit: boolean;
  canResetTerminal: boolean;
  canRestartWebContainer: boolean;
  error: string | null;
  persistedHomePromptState: TerminalPersistedHomePromptState | null;
  persistenceDialog: WebContainerTerminalPersistenceDialogState;
  resetBannerPaneId: WebContainerTerminalPaneId | null;
  resetBannerText: string | null;
  splitOpen: boolean;
  status: {
    credentialSyncLabel: string;
    credentialSyncMenuNote: string;
    networkingLabel: string;
  };
  visiblePaneIds: WebContainerTerminalPaneId[];
  workspaceNotice: {
    dismiss: () => void;
    message: string | null;
    visible: boolean;
  };
}
