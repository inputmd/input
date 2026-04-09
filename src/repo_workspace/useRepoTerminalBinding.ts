import { useEffect, useMemo, useState } from 'preact/hooks';
import type { GistFile } from '../github';
import { getPublicRepoTarball, getRepoTarball, type RepoFileEntry } from '../github_app';
import type { PublicRepoRef } from '../wiki_links';
import type { RepoAccessMode, RepoTerminalBinding } from './types';

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
  editing: boolean;
  activeEditPath: string | null;
  editContent: string;
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
  editing,
  activeEditPath,
  editContent,
}: UseRepoTerminalBindingArgs): RepoTerminalBinding {
  const [terminalRepoFiles, setTerminalRepoFiles] = useState<{
    key: string;
    files: RepoFileEntry[];
  } | null>(null);
  const cacheKey = `${workspaceKey}:${snapshotVersion}`;

  useEffect(() => {
    if (!enabled) {
      setTerminalRepoFiles((current) => (current === null ? current : null));
      return;
    }
    if (!mounted) return;
    if (currentGistId) return;
    if (terminalRepoFiles?.key === cacheKey) return;
    let cancelled = false;
    void (async () => {
      try {
        let files: RepoFileEntry[] | null = null;
        if (repoAccessMode === 'installed' && selectedRepo && activeInstalledRepoInstallationId) {
          files = await getRepoTarball(activeInstalledRepoInstallationId, selectedRepo);
        } else if (repoAccessMode === 'public' && publicRepoRef) {
          files = await getPublicRepoTarball(publicRepoRef.owner, publicRepoRef.repo);
        }
        if (cancelled || files === null) return;
        setTerminalRepoFiles({ key: cacheKey, files });
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
    terminalRepoFiles,
    cacheKey,
  ]);

  const baseFiles = useMemo<Record<string, string>>(() => {
    if (!mounted) return {};
    const result: Record<string, string> = {};
    if (currentGistId && gistFiles) {
      for (const [path, file] of Object.entries(gistFiles)) {
        if (file.truncated || file.content == null) continue;
        result[path] = file.content;
      }
    } else if (terminalRepoFiles && terminalRepoFiles.key === cacheKey) {
      for (const entry of terminalRepoFiles.files) {
        result[entry.path] = entry.content;
      }
    }
    return result;
  }, [cacheKey, currentGistId, gistFiles, mounted, terminalRepoFiles]);

  const liveFile = useMemo(() => {
    if (!mounted || !editing || !activeEditPath) return null;
    return { path: activeEditPath, content: editContent };
  }, [activeEditPath, editContent, editing, mounted]);

  return useMemo(
    () => ({
      props: {
        visible,
        apiKey,
        baseFiles,
        liveFile,
      },
    }),
    [apiKey, baseFiles, liveFile, visible],
  );
}
