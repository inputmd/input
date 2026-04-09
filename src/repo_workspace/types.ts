import type { SidebarFile, SidebarFileFilter, SidebarProps } from '../components/Sidebar';
import type { TerminalPanelProps } from '../components/TerminalPanel';
import type { RepoDocFile } from '../document_store';
import type { GistFile } from '../github';
import type { RepoFileEntry } from '../github_app';
import type { Route } from '../routing';
import type { EditSessionViewProps } from '../views/EditSessionView';
import type { PublicRepoRef } from '../wiki_links';

export type RepoAccessMode = 'installed' | 'shared' | 'public' | null;

export interface RepoWorkspaceFileCounts {
  markdown: number;
  text: number;
  total: number;
}

export interface RepoWorkspaceRename {
  from: string;
  to: string;
}

export interface RepoWorkspaceOverlayFile {
  path: string;
  content: string;
  source: 'editor' | 'sidebar' | 'terminal' | 'reader_ai';
}

export interface RepoWorkspaceIdentity {
  sidebarWorkspaceKey: string;
  scrollWorkspaceKey: string | null;
}

export interface BuildRepoWorkspaceIdentityArgs {
  currentGistId: string | null;
  route: Route;
  repoAccessMode: RepoAccessMode;
  selectedRepo: string | null;
  publicRepoRef: PublicRepoRef | null;
  currentRouteRepoRef: PublicRepoRef | null;
}

export interface RepoWorkspaceState {
  sidebarWorkspaceKey: string;
  sidebarFiles: SidebarFile[];
  sidebarFileCounts: RepoWorkspaceFileCounts;
  overlayFiles: RepoWorkspaceOverlayFile[];
  hasOverlayChanges: boolean;
  terminalSnapshotVersion: number;
  terminalBaseFiles: Record<string, string>;
  terminalBaseSnapshotKey: string | null;
  getRepoMarkdownPaths: () => string[];
  getRepoSidebarPaths: () => string[];
  getRepoOverlayPaths: () => string[];
  hasRepoSidebarPath: (path: string) => boolean;
  findBaseRepoSidebarFile: (path: string) => RepoDocFile | undefined;
  findRepoSidebarFile: (path: string) => RepoDocFile | undefined;
  listRepoSidebarFilesInFolder: (folderPath: string) => RepoDocFile[];
  resetRepoState: () => void;
  replaceRepoSnapshot: (repoSidebarFiles: RepoDocFile[], options?: { invalidateTerminal?: boolean }) => void;
  replaceRepoMarkdownFiles: (repoMarkdownFiles: RepoDocFile[]) => void;
  replaceTerminalBaseSnapshot: (snapshotKey: string, files: RepoFileEntry[] | Record<string, string>) => void;
  clearTerminalBaseSnapshot: () => void;
  setRepoFileContent: (path: string, content: string) => void;
  removeRepoFileContent: (path: string) => void;
  removeRepoFileContents: (paths: string[]) => void;
  stageRepoOverlayFile: (path: string, content: string, source?: RepoWorkspaceOverlayFile['source']) => void;
  clearRepoOverlayFile: (path: string) => void;
  clearAllRepoOverlayFiles: () => void;
  setSharedRepoFile: (repoFile: RepoDocFile) => void;
  upsertRepoFile: (repoFile: RepoDocFile) => void;
  updateRepoFile: (path: string, updates: Partial<Pick<RepoDocFile, 'name' | 'sha' | 'size'>>) => void;
  applyRepoRenames: (renames: RepoWorkspaceRename[]) => void;
  applyRepoContentRenames: (renames: RepoWorkspaceRename[]) => void;
}

export interface UseRepoWorkspaceArgs {
  workspaceIdentity: RepoWorkspaceIdentity;
  gistFiles: Record<string, GistFile> | null;
  currentFileName: string | null;
  currentRepoDocPath: string | null;
  scratchSidebarPath: string | null;
  sidebarFileFilter: SidebarFileFilter;
}

export interface RepoSidebarBinding {
  props: SidebarProps;
}

export interface RepoTerminalBinding {
  props: TerminalPanelProps;
}

export interface RepoEditorBinding {
  props: EditSessionViewProps;
}
