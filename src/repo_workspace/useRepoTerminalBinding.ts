import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError } from '../api_error';
import type { GistFile } from '../github';
import type { LinkedInstallation } from '../github_app';
import { getPublicRepoTarball, getRepoTarball } from '../github_app';
import type { WebContainerTerminalConfig } from '../terminal/config.ts';
import { WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL } from '../webcontainer_home_overlay.ts';
import type { PublicRepoRef } from '../wiki_links';
import { applyRepoWorkspaceMutationsToTerminalFiles, buildGistTerminalBaseFiles } from './helpers';
import { resolvePersistedHomeTrustAccess } from './persisted_home_trust.ts';
import type { TerminalImportDiff, TerminalImportOptions } from './terminal_sync.ts';
import { buildTerminalWorkdirName } from './terminal_workdir.ts';
import type {
  RepoAccessMode,
  RepoTerminalBinding,
  RepoWorkspaceDeletedFile,
  RepoWorkspaceOverlayFile,
  RepoWorkspaceRenamedFile,
} from './types';

interface UseRepoTerminalBindingArgs {
  workspaceKey: string;
  snapshotVersion: number;
  mounted: boolean;
  enabled: boolean;
  apiKey: string | undefined;
  currentGistId: string | null;
  currentGistOwnerLogin: string | null;
  gistFiles: Record<string, GistFile> | null;
  repoAccessMode: RepoAccessMode;
  selectedRepo: string | null;
  activeInstalledRepoInstallationId: string | null;
  publicRepoRef: PublicRepoRef | null;
  currentRouteRepoRef: PublicRepoRef | null;
  userLogin: string | null;
  linkedInstallations: LinkedInstallation[];
  linkedInstallationsLoaded: boolean;
  terminalBaseFiles: Record<string, string>;
  terminalBaseSnapshotKey: string | null;
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRenamedFile[];
  replaceTerminalBaseSnapshot: (snapshotKey: string, files: Record<string, string>) => void;
  editing: boolean;
  activeEditPath: string | null;
  editContent: string;
  includeActiveEditPathInImports?: boolean;
  onToggleVisibilityShortcut?: () => void | Promise<void>;
  onImportDiff?: (args: {
    workspaceKey: string;
    diff: TerminalImportDiff;
    options?: TerminalImportOptions;
  }) => void | Promise<void>;
  registerImportHandler?: (
    handler: ((options?: TerminalImportOptions) => Promise<TerminalImportDiff | null>) | null,
  ) => void;
}

export function useRepoTerminalBinding({
  workspaceKey,
  snapshotVersion,
  mounted,
  enabled,
  apiKey,
  currentGistId,
  currentGistOwnerLogin,
  gistFiles,
  repoAccessMode,
  selectedRepo,
  activeInstalledRepoInstallationId,
  publicRepoRef,
  currentRouteRepoRef,
  userLogin,
  linkedInstallations,
  linkedInstallationsLoaded,
  terminalBaseFiles,
  terminalBaseSnapshotKey,
  overlayFiles,
  deletedBaseFiles,
  renamedBaseFiles,
  replaceTerminalBaseSnapshot,
  editing,
  activeEditPath,
  editContent,
  includeActiveEditPathInImports = false,
  onToggleVisibilityShortcut,
  onImportDiff,
  registerImportHandler,
}: UseRepoTerminalBindingArgs): RepoTerminalBinding {
  const cacheKey = `${workspaceKey}:${snapshotVersion}`;
  const [baseFilesLoadError, setBaseFilesLoadError] = useState<string | null>(null);
  const workspaceChangesPersisted = repoAccessMode === 'installed';

  const workdirName = useMemo(
    () =>
      buildTerminalWorkdirName({
        currentGistId,
        repoAccessMode,
        selectedRepo,
        publicRepoRef,
      }),
    [currentGistId, publicRepoRef, repoAccessMode, selectedRepo],
  );

  const persistedHomeTrustAccess = useMemo(
    () =>
      resolvePersistedHomeTrustAccess({
        currentGistId,
        currentGistOwnerLogin,
        currentRouteRepoRef,
        linkedInstallations,
        linkedInstallationsLoaded,
        publicRepoRef,
        repoAccessMode,
        selectedRepo,
        userLogin,
        workspaceKey,
      }),
    [
      currentGistId,
      currentGistOwnerLogin,
      currentRouteRepoRef,
      linkedInstallations,
      linkedInstallationsLoaded,
      publicRepoRef,
      repoAccessMode,
      selectedRepo,
      userLogin,
      workspaceKey,
    ],
  );

  const requiresTerminalBaseSnapshot = useMemo(
    () =>
      (repoAccessMode === 'installed' && Boolean(selectedRepo) && Boolean(activeInstalledRepoInstallationId)) ||
      (repoAccessMode === 'public' && Boolean(publicRepoRef)),
    [activeInstalledRepoInstallationId, publicRepoRef, repoAccessMode, selectedRepo],
  );

  const workspaceChangesNotice = useMemo(() => {
    if (workspaceChangesPersisted) return null;
    if (repoAccessMode === 'public' && publicRepoRef) {
      return `Changes in this terminal won't be saved to ${publicRepoRef.owner}/${publicRepoRef.repo}.`;
    }
    if (repoAccessMode === 'shared' && currentRouteRepoRef) {
      return `Changes in this terminal won't be saved to ${currentRouteRepoRef.owner}/${currentRouteRepoRef.repo}.`;
    }
    if (currentGistId) {
      return "Changes in this terminal won't be saved to this gist.";
    }
    return "Changes in this terminal won't be saved.";
  }, [currentGistId, currentRouteRepoRef, publicRepoRef, repoAccessMode, workspaceChangesPersisted]);

  useEffect(() => {
    if (!enabled) return;
    if (!mounted) return;
    if (currentGistId) {
      setBaseFilesLoadError(null);
      return;
    }
    if (!requiresTerminalBaseSnapshot) {
      setBaseFilesLoadError(null);
      return;
    }
    if (terminalBaseSnapshotKey === cacheKey) {
      setBaseFilesLoadError(null);
      return;
    }
    let cancelled = false;
    setBaseFilesLoadError(null);
    void (async () => {
      try {
        let files: Record<string, string> | null = null;
        if (repoAccessMode === 'installed' && selectedRepo && activeInstalledRepoInstallationId) {
          files = Object.fromEntries(
            (await getRepoTarball(activeInstalledRepoInstallationId, selectedRepo)).map((entry) => [
              entry.path,
              entry.content,
            ]),
          );
        } else if (repoAccessMode === 'public' && publicRepoRef) {
          files = Object.fromEntries(
            (await getPublicRepoTarball(publicRepoRef.owner, publicRepoRef.repo)).map((entry) => [
              entry.path,
              entry.content,
            ]),
          );
        }
        if (cancelled || files === null) return;
        replaceTerminalBaseSnapshot(cacheKey, files);
        setBaseFilesLoadError(null);
      } catch (err) {
        if (cancelled) return;
        console.error('[terminal] failed to fetch repo tarball', err);
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
        setBaseFilesLoadError(`[terminal] failed to fetch repo tarball: ${message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeInstalledRepoInstallationId,
    currentGistId,
    enabled,
    mounted,
    publicRepoRef,
    repoAccessMode,
    requiresTerminalBaseSnapshot,
    selectedRepo,
    terminalBaseSnapshotKey,
    cacheKey,
    replaceTerminalBaseSnapshot,
  ]);

  const baseFiles = useMemo<Record<string, string>>(() => {
    if (!mounted) return {};
    if (currentGistId && gistFiles) {
      return buildGistTerminalBaseFiles(gistFiles);
    }
    const baseSnapshotFiles = terminalBaseSnapshotKey === cacheKey ? terminalBaseFiles : {};
    if (terminalBaseSnapshotKey !== cacheKey && requiresTerminalBaseSnapshot) return {};
    return applyRepoWorkspaceMutationsToTerminalFiles(baseSnapshotFiles, {
      overlayFiles: overlayFiles.filter((file) => file.path !== activeEditPath),
      deletedBaseFiles,
      renamedBaseFiles,
    });
  }, [
    activeEditPath,
    cacheKey,
    currentGistId,
    deletedBaseFiles,
    gistFiles,
    mounted,
    overlayFiles,
    renamedBaseFiles,
    requiresTerminalBaseSnapshot,
    terminalBaseFiles,
    terminalBaseSnapshotKey,
  ]);

  const baseFilesReady = useMemo(() => {
    if (!mounted) return false;
    if (currentGistId) return gistFiles !== null;
    if (!requiresTerminalBaseSnapshot) return true;
    return terminalBaseSnapshotKey === cacheKey;
  }, [cacheKey, currentGistId, gistFiles, mounted, requiresTerminalBaseSnapshot, terminalBaseSnapshotKey]);

  const liveFile = useMemo(() => {
    if (!mounted || !editing || !activeEditPath) return null;
    return { path: activeEditPath, content: editContent };
  }, [activeEditPath, editContent, editing, mounted]);

  return useMemo(
    () => ({
      config: {
        session: {
          id: workspaceKey,
          apiKey,
          workdirName,
        },
        files: {
          base: baseFiles,
          ready: baseFilesReady,
          baseLoadError: baseFilesLoadError,
          live: liveFile,
          importFromContainer: {
            enabled: workspaceChangesPersisted,
            includeLiveFile: includeActiveEditPathInImports,
            onDiff: workspaceChangesPersisted
              ? async (diff, context) => {
                  await onImportDiff?.({
                    workspaceKey: context.sessionId,
                    diff,
                    options: context.options,
                  });
                }
              : undefined,
            registerHandler: workspaceChangesPersisted ? registerImportHandler : undefined,
          },
        },
        overlay: {
          archiveUrl: WEBCONTAINER_HOME_OVERLAY_ARCHIVE_URL,
          enabled: true,
        },
        network: {
          enabled: true,
          upstreamProxyBaseUrl: '/api/upstream-proxy',
        },
        persistedHome: {
          canConfigure: persistedHomeTrustAccess.canConfigure,
          mode: persistedHomeTrustAccess.prompt ? 'ask' : 'off',
          prompt: persistedHomeTrustAccess.prompt
            ? {
                storageKey: persistedHomeTrustAccess.prompt.storageKey,
                target: persistedHomeTrustAccess.prompt.target,
                title: persistedHomeTrustAccess.prompt.title,
                message: persistedHomeTrustAccess.prompt.message,
                note: persistedHomeTrustAccess.prompt.note,
                defaultMode: persistedHomeTrustAccess.prompt.defaultMode,
                trustResolved: persistedHomeTrustAccess.prompt.trustResolved,
              }
            : null,
        },
        shortcuts: {
          onToggleVisibility: onToggleVisibilityShortcut,
        },
      } satisfies WebContainerTerminalConfig,
      workspaceChangesNotice,
      workspaceChangesPersisted,
    }),
    [
      apiKey,
      baseFiles,
      baseFilesLoadError,
      baseFilesReady,
      includeActiveEditPathInImports,
      liveFile,
      onToggleVisibilityShortcut,
      onImportDiff,
      persistedHomeTrustAccess,
      registerImportHandler,
      workspaceChangesNotice,
      workspaceChangesPersisted,
      workdirName,
      workspaceKey,
    ],
  );
}
