import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError } from '../api_error';
import type { GistFile } from '../github';
import type { LinkedInstallation } from '../github_app';
import { getPublicRepoTarball, getRepoTarball } from '../github_app';
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
  visible: boolean;
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
  visible,
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
      publicRepoRef,
      repoAccessMode,
      selectedRepo,
      userLogin,
      workspaceKey,
    ],
  );

  const workspaceChangesNotice = useMemo(() => {
    if (workspaceChangesPersisted) return null;
    if (repoAccessMode === 'public' && publicRepoRef) {
      return `Changes in this terminal won't be saved to ${publicRepoRef.owner}/${publicRepoRef.repo}. Download files or clone this repo to keep your work.`;
    }
    if (repoAccessMode === 'shared' && currentRouteRepoRef) {
      return `Changes in this terminal won't be saved to ${currentRouteRepoRef.owner}/${currentRouteRepoRef.repo}. Download files or clone this repo to keep your work.`;
    }
    if (currentGistId) {
      return "Changes in this terminal won't be saved to this gist. Download files to keep your work.";
    }
    return "Changes in this terminal won't be saved here. Download files to keep your work.";
  }, [currentGistId, currentRouteRepoRef, publicRepoRef, repoAccessMode, workspaceChangesPersisted]);

  useEffect(() => {
    if (!enabled) return;
    if (!mounted) return;
    if (currentGistId) {
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
    if (terminalBaseSnapshotKey !== cacheKey) return {};
    return applyRepoWorkspaceMutationsToTerminalFiles(terminalBaseFiles, {
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
    terminalBaseFiles,
    terminalBaseSnapshotKey,
  ]);

  const baseFilesReady = useMemo(() => {
    if (!mounted) return false;
    if (currentGistId) return gistFiles !== null;
    return terminalBaseSnapshotKey === cacheKey;
  }, [cacheKey, currentGistId, gistFiles, mounted, terminalBaseSnapshotKey]);

  const liveFile = useMemo(() => {
    if (!mounted || !editing || !activeEditPath) return null;
    return { path: activeEditPath, content: editContent };
  }, [activeEditPath, editContent, editing, mounted]);

  return useMemo(
    () => ({
      props: {
        visible,
        workspaceKey,
        workdirName,
        apiKey,
        baseFiles,
        baseFilesReady,
        baseFilesLoadError,
        liveFile,
        workspaceChangesPersisted,
        workspaceChangesNotice,
        persistedHomeTrustPrompt: persistedHomeTrustAccess.prompt,
        showPersistedHomeTrustConfiguration: persistedHomeTrustAccess.canConfigure,
        includeActiveEditPathInImports,
        onToggleVisibilityShortcut,
        onImportDiff: workspaceChangesPersisted ? onImportDiff : undefined,
        registerImportHandler: workspaceChangesPersisted ? registerImportHandler : undefined,
      },
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
      visible,
      workspaceChangesNotice,
      workspaceChangesPersisted,
      workdirName,
      workspaceKey,
    ],
  );
}
