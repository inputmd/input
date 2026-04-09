import type { SidebarProps } from '../components/Sidebar';
import type { RepoSidebarBinding, RepoWorkspaceState } from './types';

interface UseRepoSidebarBindingArgs
  extends Omit<SidebarProps, 'workspaceKey' | 'files' | 'markdownFileCount' | 'textFileCount' | 'totalFileCount'> {
  workspace: RepoWorkspaceState;
}

// This hook is intentionally a thin adapter. `useRepoWorkspace` owns the
// workspace-facing state and derived file lists; the binding just reshapes that
// domain data into the exact prop contract expected by `Sidebar` so `app.tsx`
// stays at a single composition hop instead of rebuilding those props inline.
export function useRepoSidebarBinding({ workspace, ...rest }: UseRepoSidebarBindingArgs): RepoSidebarBinding {
  return {
    props: {
      ...rest,
      workspaceKey: workspace.sidebarWorkspaceKey,
      files: workspace.sidebarFiles,
      markdownFileCount: workspace.sidebarFileCounts.markdown,
      textFileCount: workspace.sidebarFileCounts.text,
      totalFileCount: workspace.sidebarFileCounts.total,
    },
  };
}
