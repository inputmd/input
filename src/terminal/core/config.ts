export type WebContainerTerminalPaneId = 'primary' | 'secondary';

export type WebContainerTerminalPersistedHomeMode = 'off' | 'include' | 'exclude' | 'ask';

export type WebContainerTerminalPersistedHomePromptTarget = 'gist' | 'repo' | 'workspace';

export interface WebContainerTerminalLiveFile {
  path: string;
  content: string;
}

export interface WebContainerTerminalFileDiff {
  upserts: Record<string, string>;
  deletes: string[];
}

export interface WebContainerTerminalImportOptions {
  silent?: boolean;
}

export interface WebContainerTerminalImportContext {
  options?: WebContainerTerminalImportOptions;
  reason: 'interval' | 'manual' | 'restart' | 'unmount';
  sessionId: string;
}

export interface WebContainerTerminalPersistedHomePrompt {
  storageKey: string;
  target: WebContainerTerminalPersistedHomePromptTarget;
  title: string;
  message: string;
  note?: string | null;
  defaultMode: Extract<WebContainerTerminalPersistedHomeMode, 'include' | 'exclude'>;
  trustResolved: boolean;
}

export interface WebContainerTerminalFilesConfig {
  base: Record<string, string>;
  ready: boolean;
  baseLoadError?: string | null;
  live?: WebContainerTerminalLiveFile | null;
  syncToContainer?: {
    debounceMs?: number;
    enabled?: boolean;
  };
  importFromContainer?: {
    enabled?: boolean;
    includeLiveFile?: boolean;
    intervalMs?: number | false;
    maxDepth?: number;
    maxEntries?: number;
    maxFileBytes?: number;
    onDiff?: (diff: WebContainerTerminalFileDiff, context: WebContainerTerminalImportContext) => void | Promise<void>;
    registerHandler?: (
      handler: ((options?: WebContainerTerminalImportOptions) => Promise<WebContainerTerminalFileDiff | null>) | null,
    ) => void;
    shouldIncludePath?: (path: string) => boolean;
  };
}

export interface WebContainerTerminalSessionConfig {
  id: string;
  apiKey?: string;
  autostart?: boolean;
  workdirName: string;
  boot?: {
    coep?: 'credentialless' | 'none';
    reuseBootInstance?: boolean;
  };
}

export interface WebContainerTerminalOverlayConfig {
  archiveUrl: string;
  enabled?: boolean;
}

export interface WebContainerTerminalNetworkConfig {
  enabled?: boolean;
  upstreamProxyBaseUrl: string;
}

export interface WebContainerTerminalPersistedHomeConfig {
  canConfigure?: boolean;
  mode?: WebContainerTerminalPersistedHomeMode;
  prompt?: WebContainerTerminalPersistedHomePrompt | null;
  watch?: boolean;
}

export interface WebContainerTerminalShortcutsConfig {
  onToggleVisibility?: () => void | Promise<void>;
}

export interface WebContainerTerminalPanesConfig {
  initialSplit?: boolean;
  max?: 1 | 2;
}

export interface WebContainerTerminalLifecycleConfig {
  importOnUnmount?: boolean;
  stopOnUnmount?: boolean;
}

export interface WebContainerTerminalDiagnosticsConfig {
  enablePerfLog?: boolean;
  onEvent?: (event: { detail?: Record<string, unknown>; type: string }) => void;
  onLog?: (line: string) => void;
}

export interface WebContainerTerminalConfig {
  diagnostics?: WebContainerTerminalDiagnosticsConfig;
  files: WebContainerTerminalFilesConfig;
  lifecycle?: WebContainerTerminalLifecycleConfig;
  network?: false | WebContainerTerminalNetworkConfig;
  overlay?: false | WebContainerTerminalOverlayConfig;
  panes?: WebContainerTerminalPanesConfig;
  persistedHome?: false | WebContainerTerminalPersistedHomeConfig;
  session: WebContainerTerminalSessionConfig;
  shortcuts?: WebContainerTerminalShortcutsConfig;
}
