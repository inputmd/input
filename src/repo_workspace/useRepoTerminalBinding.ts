import { useEffect, useMemo } from 'preact/hooks';
import type { GistFile } from '../github';
import { getPublicRepoTarball, getRepoTarball } from '../github_app';
import type { PublicRepoRef } from '../wiki_links';
import { applyRepoWorkspaceMutationsToTerminalFiles, buildGistTerminalBaseFiles } from './helpers';
import type { TerminalImportDiff, TerminalImportOptions } from './terminal_sync.ts';
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
  gistFiles: Record<string, GistFile> | null;
  repoAccessMode: RepoAccessMode;
  selectedRepo: string | null;
  activeInstalledRepoInstallationId: string | null;
  publicRepoRef: PublicRepoRef | null;
  terminalBaseFiles: Record<string, string>;
  terminalBaseSnapshotKey: string | null;
  overlayFiles: RepoWorkspaceOverlayFile[];
  deletedBaseFiles: RepoWorkspaceDeletedFile[];
  renamedBaseFiles: RepoWorkspaceRenamedFile[];
  replaceTerminalBaseSnapshot: (snapshotKey: string, files: Record<string, string>) => void;
  editing: boolean;
  activeEditPath: string | null;
  editContent: string;
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
  gistFiles,
  repoAccessMode,
  selectedRepo,
  activeInstalledRepoInstallationId,
  publicRepoRef,
  terminalBaseFiles,
  terminalBaseSnapshotKey,
  overlayFiles,
  deletedBaseFiles,
  renamedBaseFiles,
  replaceTerminalBaseSnapshot,
  editing,
  activeEditPath,
  editContent,
  onImportDiff,
  registerImportHandler,
}: UseRepoTerminalBindingArgs): RepoTerminalBinding {
  const cacheKey = `${workspaceKey}:${snapshotVersion}`;

  useEffect(() => {
    if (!enabled) return;
    if (!mounted) return;
    if (currentGistId) return;
    if (terminalBaseSnapshotKey === cacheKey) return;
    let cancelled = false;
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
      } catch (err) {
        console.error('[terminal] failed to fetch repo tarball', err);
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

  const liveFile = useMemo(() => {
    if (!mounted || !editing || !activeEditPath) return null;
    return { path: activeEditPath, content: editContent };
  }, [activeEditPath, editContent, editing, mounted]);

  return useMemo(
    () => ({
      props: {
        visible,
        workspaceKey,
        apiKey,
        baseFiles,
        liveFile,
        onImportDiff,
        registerImportHandler,
      },
    }),
    [apiKey, baseFiles, liveFile, onImportDiff, registerImportHandler, visible, workspaceKey],
  );
}
