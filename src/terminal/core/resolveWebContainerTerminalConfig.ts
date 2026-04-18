import { WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL } from '../../webcontainer_home_overlay.ts';
import type {
  WebContainerTerminalConfig,
  WebContainerTerminalPersistedHomeMode,
  WebContainerTerminalPersistedHomePrompt,
} from './config.ts';
import { DEFAULT_AUTO_IMPORT_INTERVAL_MS, DEFAULT_LIVE_FILE_DEBOUNCE_MS } from './filesystem.ts';

type ImportFromContainerConfig = NonNullable<WebContainerTerminalConfig['files']['importFromContainer']>;
type PaneConfig = NonNullable<WebContainerTerminalConfig['panes']>;
type SessionBootConfig = NonNullable<WebContainerTerminalConfig['session']['boot']>;
type ShortcutConfig = NonNullable<WebContainerTerminalConfig['shortcuts']>;

export interface ResolvedWebContainerTerminalConfig {
  apiKey?: string;
  autostart: boolean;
  baseFiles: Record<string, string>;
  baseFilesLoadError: string | null;
  baseFilesReady: boolean;
  bootCoep: SessionBootConfig['coep'];
  bootReuseInstance: SessionBootConfig['reuseBootInstance'];
  importFromContainerEnabled: boolean;
  importFromContainerIntervalMs: number | false;
  importOnUnmount: boolean;
  includeActiveEditPathInImports: boolean;
  initialSplit: PaneConfig['initialSplit'];
  liveFileContent: string | null;
  liveFilePath: string | null;
  liveSyncDebounceMs: number;
  maxPaneCount: 1 | 2;
  networkEnabled: boolean;
  onImportDiff: ImportFromContainerConfig['onDiff'];
  onToggleVisibilityShortcut: ShortcutConfig['onToggleVisibility'];
  overlayArchiveUrl: string;
  overlayEnabled: boolean;
  persistedHomeMode: WebContainerTerminalPersistedHomeMode;
  persistedHomeTrustPrompt: WebContainerTerminalPersistedHomePrompt | null;
  registerImportHandler: ImportFromContainerConfig['registerHandler'];
  stopOnUnmount: boolean;
  syncToContainerEnabled: boolean;
  upstreamProxyBaseUrl: string;
  workdirName: string;
  workspaceKey: string;
}

export function resolveWebContainerTerminalConfig(
  config: WebContainerTerminalConfig,
): ResolvedWebContainerTerminalConfig {
  const liveFile = config.files.live ?? null;
  const importFromContainerConfig = config.files.importFromContainer;
  const syncToContainerConfig = config.files.syncToContainer;
  const persistedHomeConfig = config.persistedHome === false ? null : config.persistedHome;
  const overlayConfig = config.overlay === false ? null : config.overlay;
  const networkConfig = config.network === false ? null : config.network;

  return {
    apiKey: config.session.apiKey,
    autostart: config.session.autostart ?? true,
    baseFiles: config.files.base,
    baseFilesLoadError: config.files.baseLoadError ?? null,
    baseFilesReady: config.files.ready,
    bootCoep: config.session.boot?.coep,
    bootReuseInstance: config.session.boot?.reuseBootInstance,
    importFromContainerEnabled: importFromContainerConfig?.enabled ?? Boolean(importFromContainerConfig?.onDiff),
    importFromContainerIntervalMs: importFromContainerConfig?.intervalMs ?? DEFAULT_AUTO_IMPORT_INTERVAL_MS,
    importOnUnmount: config.lifecycle?.importOnUnmount ?? true,
    includeActiveEditPathInImports: importFromContainerConfig?.includeLiveFile ?? false,
    initialSplit: config.panes?.initialSplit,
    liveFileContent: liveFile?.content ?? null,
    liveFilePath: liveFile?.path ?? null,
    liveSyncDebounceMs: syncToContainerConfig?.debounceMs ?? DEFAULT_LIVE_FILE_DEBOUNCE_MS,
    maxPaneCount: config.panes?.max ?? 2,
    networkEnabled: networkConfig?.enabled ?? config.network !== false,
    onImportDiff: importFromContainerConfig?.onDiff,
    onToggleVisibilityShortcut: config.shortcuts?.onToggleVisibility,
    overlayArchiveUrl: overlayConfig?.archiveUrl ?? WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL,
    overlayEnabled: overlayConfig?.enabled ?? config.overlay !== false,
    persistedHomeMode: persistedHomeConfig?.mode ?? (persistedHomeConfig ? 'ask' : 'off'),
    persistedHomeTrustPrompt: persistedHomeConfig?.prompt ?? null,
    registerImportHandler: importFromContainerConfig?.registerHandler,
    stopOnUnmount: config.lifecycle?.stopOnUnmount ?? true,
    syncToContainerEnabled: syncToContainerConfig?.enabled ?? true,
    upstreamProxyBaseUrl: networkConfig?.upstreamProxyBaseUrl ?? '/api/upstream-proxy',
    workdirName: config.session.workdirName,
    workspaceKey: config.session.id,
  };
}
