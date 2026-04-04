import { applyReaderAiChanges, type ReaderAiApplyResult, type ReaderAiStagedChange } from './reader_ai';

export type ReaderAiHostApplyTarget =
  | { kind: 'gist'; gistId: string }
  | { kind: 'repo'; installationId: string; repoFullName: string };

interface ResolveReaderAiHostApplyTargetOptions {
  activeInstalledRepoInstallationId: string | null;
  currentGistId: string | null;
  hasCompleteStagedContent: boolean;
  isGistContext: boolean;
  repoAccessMode: string | null;
  selectedRepo: string | null;
  stagedChangesInvalid: boolean;
  userPresent: boolean;
}

export function resolveReaderAiHostApplyTarget(
  options: ResolveReaderAiHostApplyTargetOptions,
): ReaderAiHostApplyTarget | null {
  if (options.stagedChangesInvalid || !options.hasCompleteStagedContent) return null;
  if (options.isGistContext && options.currentGistId && options.userPresent) {
    return { kind: 'gist', gistId: options.currentGistId };
  }
  if (options.repoAccessMode === 'installed' && options.activeInstalledRepoInstallationId && options.selectedRepo) {
    return {
      kind: 'repo',
      installationId: options.activeInstalledRepoInstallationId,
      repoFullName: options.selectedRepo,
    };
  }
  return null;
}

export async function applyReaderAiHostChanges(
  target: ReaderAiHostApplyTarget,
  changes: ReaderAiStagedChange[],
  fileContents: Record<string, string>,
  commitMessage?: string,
): Promise<ReaderAiApplyResult> {
  return applyReaderAiChanges(target, changes, fileContents, commitMessage);
}

export function invalidateReaderAiHostCaches(
  target: ReaderAiHostApplyTarget,
  options: { clearGitHubAppCaches: () => void; clearGitHubCaches: () => void },
): void {
  options.clearGitHubAppCaches();
  if (target.kind === 'gist') options.clearGitHubCaches();
}

interface ResolveReaderAiEditorApplyPlanOptions {
  activeView: string;
  currentEditingDocPath: string | null;
  documentEditedContent: string | null;
  modifiedFileContents: ReadonlyMap<string, string>;
}

export interface ReaderAiEditorApplyPlan {
  appliedPaths: string[];
  nextContent: string;
}

interface PerformReaderAiApplyOptions {
  activeInstalledRepoInstallationId: string | null;
  activeView: string;
  commitMessage?: string;
  currentEditingDocPath: string | null;
  currentGistId: string | null;
  documentEditedContent: string | null;
  isGistContext: boolean;
  mode: 'without-saving' | 'commit';
  repoAccessMode: string | null;
  selectedChanges: ReaderAiStagedChange[];
  selectedFileContents: Record<string, string>;
  selectedRepo: string | null;
  stagedChangesInvalid: boolean;
  userPresent: boolean;
}

type ReaderAiHostApplyOutcome =
  | {
      kind: 'editor';
      appliedPaths: string[];
      nextContent: string;
    }
  | {
      kind: 'remote';
      target: ReaderAiHostApplyTarget;
      result: ReaderAiApplyResult;
    };

export type ReaderAiHostApplyExecution =
  | {
      kind: 'editor_applied';
      appliedPaths: string[];
      nextContent: string;
    }
  | {
      kind: 'remote_conflict';
      conflict: NonNullable<ReaderAiApplyResult['conflict']>;
    }
  | {
      kind: 'remote_applied';
      appliedPaths: string[];
      target: ReaderAiHostApplyTarget;
    }
  | {
      kind: 'remote_partial';
      appliedPaths: string[];
      failedPaths: Array<{ path: string; error: string }>;
      conflictPaths: string[];
      target: ReaderAiHostApplyTarget;
    }
  | {
      kind: 'remote_failed';
      failedPaths: Array<{ path: string; error: string }>;
      conflictPaths: string[];
    };

export function resolveReaderAiEditorApplyPlan(
  options: ResolveReaderAiEditorApplyPlanOptions,
): ReaderAiEditorApplyPlan {
  if (options.activeView !== 'edit') {
    throw new Error('Cannot apply without saving outside edit view');
  }
  const currentPath = options.currentEditingDocPath;
  const nextContent =
    currentPath && typeof options.modifiedFileContents.get(currentPath) === 'string'
      ? options.modifiedFileContents.get(currentPath)
      : typeof options.documentEditedContent === 'string'
        ? options.documentEditedContent
        : undefined;
  if (typeof nextContent !== 'string') {
    throw new Error('No staged document content to apply');
  }
  return {
    appliedPaths: currentPath ? [currentPath] : [],
    nextContent,
  };
}

export function createReaderAiApplyConflictMessage(conflict: { path?: string; currentContent: string | null }): string {
  return conflict.currentContent !== null
    ? 'The document changed after Reader AI generated this edit. The conflicting file remains staged for review.'
    : 'The document changed after Reader AI generated this edit. The conflicting file remains staged for review.';
}

export function createReaderAiNoWriteAccessError(): Error {
  return new Error('Cannot apply changes: no write access');
}

function classifyReaderAiRemoteApplyFailure(error: string): 'conflict' | 'failed' {
  const normalized = error.toLowerCase();
  if (
    normalized.includes('conflict') ||
    normalized.includes('changed after') ||
    normalized.includes('old_text not found')
  ) {
    return 'conflict';
  }
  return 'failed';
}

async function performReaderAiHostApply(options: PerformReaderAiApplyOptions): Promise<ReaderAiHostApplyOutcome> {
  if (options.mode === 'without-saving') {
    const editorApplyPlan = resolveReaderAiEditorApplyPlan({
      activeView: options.activeView,
      currentEditingDocPath: options.currentEditingDocPath,
      documentEditedContent: options.documentEditedContent,
      modifiedFileContents: new Map(Object.entries(options.selectedFileContents)),
    });
    return {
      kind: 'editor',
      appliedPaths: editorApplyPlan.appliedPaths,
      nextContent: editorApplyPlan.nextContent,
    };
  }

  const hasCompleteStagedContent = options.selectedChanges.every(
    (change) => change.type === 'delete' || typeof options.selectedFileContents[change.path] === 'string',
  );
  const applyTarget = resolveReaderAiHostApplyTarget({
    activeInstalledRepoInstallationId: options.activeInstalledRepoInstallationId,
    currentGistId: options.currentGistId,
    hasCompleteStagedContent,
    isGistContext: options.isGistContext,
    repoAccessMode: options.repoAccessMode,
    selectedRepo: options.selectedRepo,
    stagedChangesInvalid: options.stagedChangesInvalid,
    userPresent: options.userPresent,
  });
  if (!applyTarget) throw createReaderAiNoWriteAccessError();
  return {
    kind: 'remote',
    target: applyTarget,
    result: await applyReaderAiHostChanges(
      applyTarget,
      options.selectedChanges,
      options.selectedFileContents,
      options.commitMessage,
    ),
  };
}

export async function executeReaderAiHostApply(
  options: PerformReaderAiApplyOptions,
): Promise<ReaderAiHostApplyExecution> {
  const outcome = await performReaderAiHostApply(options);
  if (outcome.kind === 'editor') {
    return {
      kind: 'editor_applied',
      appliedPaths: outcome.appliedPaths,
      nextContent: outcome.nextContent,
    };
  }
  if (outcome.result.conflict) {
    return {
      kind: 'remote_conflict',
      conflict: outcome.result.conflict,
    };
  }
  if (outcome.result.failed.length > 0 && outcome.result.applied.length > 0) {
    const conflictPaths = outcome.result.failed
      .filter((entry) => classifyReaderAiRemoteApplyFailure(entry.error) === 'conflict')
      .map((entry) => entry.path);
    return {
      kind: 'remote_partial',
      appliedPaths: outcome.result.applied,
      failedPaths: outcome.result.failed,
      conflictPaths,
      target: outcome.target,
    };
  }
  if (outcome.result.failed.length > 0) {
    const conflictPaths = outcome.result.failed
      .filter((entry) => classifyReaderAiRemoteApplyFailure(entry.error) === 'conflict')
      .map((entry) => entry.path);
    return {
      kind: 'remote_failed',
      failedPaths: outcome.result.failed,
      conflictPaths,
    };
  }
  return {
    kind: 'remote_applied',
    appliedPaths: outcome.result.applied,
    target: outcome.target,
  };
}
