import type { ReaderAiMessage } from './components/ReaderAiPanel';
import type { ReaderAiStagedChange } from './reader_ai';
import type {
  ReaderAiChangeSetFileRecord,
  ReaderAiChangeSetRecord,
  ReaderAiRunRecord,
  ReaderAiRunStep,
} from './reader_ai_ledger';

function hashReaderAiContent(content: string): string {
  let hash = 5381;
  for (let index = 0; index < content.length; index++) {
    hash = (hash * 33) ^ content.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

export function buildReaderAiChangeSetFileRecords(options: {
  stagedChanges: ReaderAiStagedChange[];
  stagedFileContents: Record<string, string>;
}): ReaderAiChangeSetFileRecord[] {
  return options.stagedChanges.map((change) => {
    const modifiedContent =
      change.type === 'delete'
        ? null
        : (options.stagedFileContents[change.path] ??
          (typeof change.modifiedContent === 'string' ? change.modifiedContent : null));
    return {
      path: change.path,
      status: change.type === 'delete' || typeof modifiedContent === 'string' ? 'ready' : 'missing_content',
      hasCompleteContent: change.type === 'delete' || typeof modifiedContent === 'string',
      ...(typeof change.revision === 'number' ? { baseRevision: change.revision } : {}),
      ...(typeof change.originalContent === 'string'
        ? { originalHash: hashReaderAiContent(change.originalContent) }
        : {}),
      ...(typeof modifiedContent === 'string' ? { modifiedHash: hashReaderAiContent(modifiedContent) } : {}),
    };
  });
}

export function markReaderAiChangeSetFileStatuses(
  changeSet: ReaderAiChangeSetRecord,
  options: {
    appliedPaths?: string[];
    failedPaths?: Array<{ path: string; error: string }>;
    conflictPaths?: string[];
    stalePaths?: string[];
  },
): ReaderAiChangeSetRecord {
  const applied = new Set(options.appliedPaths ?? []);
  const failed = new Set((options.failedPaths ?? []).map((entry) => entry.path));
  const conflicted = new Set(options.conflictPaths ?? []);
  const stale = new Set(options.stalePaths ?? []);
  return {
    ...changeSet,
    files: changeSet.files.map((file) => ({
      ...file,
      status: applied.has(file.path)
        ? 'applied'
        : conflicted.has(file.path)
          ? 'conflicted'
          : stale.has(file.path)
            ? 'stale'
            : failed.has(file.path)
              ? 'failed'
              : file.status,
    })),
  };
}

export function findReaderAiActiveChangeSet(
  changeSets: ReaderAiChangeSetRecord[],
  activeChangeSetId: string | null,
): ReaderAiChangeSetRecord | null {
  if (!activeChangeSetId) return null;
  return changeSets.find((changeSet) => changeSet.id === activeChangeSetId) ?? null;
}

export function validateReaderAiSelectedChangesForApply(options: {
  activeChangeSet: ReaderAiChangeSetRecord | null;
  currentEditContentRevision: number;
  currentEditingDocPath: string | null;
  currentEditingDocumentContent: string;
  selectedChanges: ReaderAiStagedChange[];
}): Array<{ path: string; reason: 'missing_content' | 'stale' }> {
  const fileRecordByPath = new Map(options.activeChangeSet?.files.map((file) => [file.path, file]) ?? []);
  const invalid: Array<{ path: string; reason: 'missing_content' | 'stale' }> = [];
  for (const change of options.selectedChanges) {
    const fileRecord = fileRecordByPath.get(change.path);
    if (fileRecord && !fileRecord.hasCompleteContent) {
      invalid.push({ path: change.path, reason: 'missing_content' });
      continue;
    }
    if (fileRecord?.status === 'stale') {
      invalid.push({ path: change.path, reason: 'stale' });
      continue;
    }
    if (
      change.path === options.currentEditingDocPath &&
      ((typeof change.revision === 'number' && change.revision !== options.currentEditContentRevision) ||
        (typeof change.originalContent === 'string' &&
          change.originalContent !== options.currentEditingDocumentContent))
    ) {
      invalid.push({ path: change.path, reason: 'stale' });
    }
  }
  return invalid;
}

export function createReaderAiApplyBlockedMessage(
  invalid: Array<{ path: string; reason: 'missing_content' | 'stale' }>,
): string {
  const stalePaths = invalid.filter((entry) => entry.reason === 'stale').map((entry) => entry.path);
  const missingContentPaths = invalid.filter((entry) => entry.reason === 'missing_content').map((entry) => entry.path);
  if (stalePaths.length > 0 && missingContentPaths.length > 0) {
    return `Cannot apply changes. These files are stale: ${stalePaths.join(', ')}. These files are missing full content: ${missingContentPaths.join(', ')}.`;
  }
  if (stalePaths.length > 0) {
    return `Cannot apply changes. These files changed after Reader AI generated them: ${stalePaths.join(', ')}.`;
  }
  return `Cannot apply changes. Reader AI is missing full content for: ${missingContentPaths.join(', ')}.`;
}

export function classifyReaderAiStepRetryPolicy(
  step: Pick<ReaderAiRunStep, 'kind' | 'name'>,
  error?: string,
): Pick<ReaderAiRunStep, 'maxRetries' | 'retryable' | 'retryReason' | 'retryState'> {
  if (!error) return { maxRetries: 0, retryable: false, retryReason: undefined, retryState: 'none' };
  const normalized = error.toLowerCase();
  if (normalized.includes('conflict') || normalized.includes('changed after')) {
    return { maxRetries: 0, retryable: false, retryReason: undefined, retryState: 'none' };
  }
  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('rate limit') ||
    normalized.includes('temporar') ||
    normalized.includes('overloaded')
  ) {
    return { maxRetries: 2, retryable: true, retryReason: 'transient', retryState: 'ready' };
  }
  if (
    normalized.includes('invalid') ||
    normalized.includes('malformed') ||
    normalized.includes('schema') ||
    normalized.includes('argument') ||
    normalized.includes('parameter')
  ) {
    return { maxRetries: 1, retryable: true, retryReason: 'tool-arguments', retryState: 'ready' };
  }
  if (step.kind === 'task' || step.name === 'task') {
    return { maxRetries: 1, retryable: true, retryReason: 'task-failure', retryState: 'ready' };
  }
  return { maxRetries: 1, retryable: true, retryReason: 'unknown', retryState: 'ready' };
}

export function findLatestRetryableReaderAiStep(runs: ReaderAiRunRecord[]): { runId: string; stepId: string } | null {
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
    const run = runs[runIndex];
    for (let stepIndex = run.steps.length - 1; stepIndex >= 0; stepIndex--) {
      const step = run.steps[stepIndex];
      if (step.status !== 'failed' || !step.retryable) continue;
      if (step.retryCount >= step.maxRetries) continue;
      if (step.retryState !== 'ready') continue;
      return { runId: run.id, stepId: step.id };
    }
  }
  return null;
}

export function markReaderAiRunStepRetryAttempt(run: ReaderAiRunRecord, stepId: string): ReaderAiRunRecord {
  return {
    ...run,
    steps: run.steps.map((step) =>
      step.id !== stepId
        ? step
        : {
            ...step,
            retryCount: step.retryCount + 1,
            retryState: 'in_progress',
          },
    ),
  };
}

export function completeReaderAiRunStepRetry(
  run: ReaderAiRunRecord,
  stepId: string,
  success: boolean,
): ReaderAiRunRecord {
  return {
    ...run,
    steps: run.steps.map((step) =>
      step.id !== stepId
        ? step
        : {
            ...step,
            retryState: success ? 'none' : step.retryCount >= step.maxRetries ? 'exhausted' : 'ready',
          },
    ),
  };
}

export function buildReaderAiRetryRequestFromRuns(runs: ReaderAiRunRecord[]): {
  baseMessages: ReaderAiMessage[];
  modelId: string | null;
  parentRunId: string | null;
  retryStepId?: string;
} | null {
  const retryTarget = findLatestRetryableReaderAiStep(runs);
  if (retryTarget) {
    const run = runs.find((entry) => entry.id === retryTarget.runId) ?? null;
    if (run && run.baseMessages.length > 0) {
      return {
        baseMessages: run.baseMessages,
        modelId: run.modelId,
        parentRunId: run.id,
        retryStepId: retryTarget.stepId,
      };
    }
  }
  const latestRun = runs[runs.length - 1] ?? null;
  if (!latestRun || latestRun.baseMessages.length === 0) return null;
  return {
    baseMessages: latestRun.baseMessages,
    modelId: latestRun.modelId,
    parentRunId: latestRun.id,
  };
}
