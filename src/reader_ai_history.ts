import type { ReaderAiMessage } from './components/ReaderAiPanel';
import type { ReaderAiEditProposal, ReaderAiStagedChange, ReaderAiStagedHunk } from './reader_ai';
import type { ReaderAiEditorCheckpoint } from './reader_ai_editor_checkpoints';
import type { ReaderAiStepErrorCode } from './reader_ai_errors';
import type { ReaderAiChangeSetFileRecord, ReaderAiChangeSetRecord, ReaderAiRunRecord } from './reader_ai_ledger';
import type { Route } from './routing';
import type { PublicRepoRef } from './wiki_links';

const READER_AI_HISTORY_KEY = 'reader_ai_history_v2';
const READER_AI_HISTORY_MAX_ENTRIES = 12;
const READER_AI_HISTORY_MAX_MESSAGES = 100;
const READER_AI_HISTORY_MAX_APPLIED_CHANGES = 100;

export interface ReaderAiHistoryEntry {
  messages: ReaderAiMessage[];
  queuedCommands?: string[];
  summary?: string;
  scope?: { kind: 'document' } | { kind: 'selection'; source: string };
  toolLog?: Array<{
    type: 'call' | 'result' | 'progress';
    id?: string;
    name: string;
    detail?: string;
    taskId?: string;
    taskStatus?: 'running' | 'completed' | 'error';
    tone?: 'default' | 'success' | 'error';
  }>;
  editProposals?: ReaderAiEditProposal[];
  proposalStatusesByToolCallId?: Record<string, 'accepted' | 'rejected' | 'ignored'>;
  stagedChanges?: ReaderAiStagedChange[];
  stagedChangesInvalid?: boolean;
  stagedFileContents?: Record<string, string>;
  appliedChanges?: Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>;
  editorCheckpoints?: ReaderAiEditorCheckpoint[];
  activeEditorCheckpointId?: string;
  runs?: ReaderAiRunRecord[];
  activeRunId?: string;
  changeSets?: ReaderAiChangeSetRecord[];
  activeChangeSetId?: string;
}

export interface ReaderAiHistoryStore {
  order: string[];
  entries: Record<string, ReaderAiHistoryEntry>;
}

export function buildReaderAiHistoryDocumentKey(options: {
  currentRepoDocPath: string | null;
  currentGistId: string | null;
  currentFileName: string | null;
  repoAccessMode: 'installed' | 'shared' | 'public' | null;
  selectedRepo: string | null;
  publicRepoRef: PublicRepoRef | null;
  route: Route;
}): string | null {
  const { currentRepoDocPath, currentGistId, currentFileName, repoAccessMode, selectedRepo, publicRepoRef, route } =
    options;

  if (currentGistId && currentFileName) {
    return `gist:${currentGistId}:${currentFileName}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'installed' && selectedRepo) {
    return `repo:${selectedRepo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'public' && publicRepoRef) {
    return `public:${publicRepoRef.owner.toLowerCase()}/${publicRepoRef.repo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'shared' && (route.name === 'repofile' || route.name === 'repoedit')) {
    return `shared:${route.params.owner.toLowerCase()}/${route.params.repo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (route.name === 'sharefile' && currentRepoDocPath) {
    return `share:${route.params.owner}/${route.params.repo}:${currentRepoDocPath}`;
  }
  if (route.name === 'sharetoken' && currentRepoDocPath) {
    return `share:${route.params.token}:${currentRepoDocPath}`;
  }
  return null;
}

function isReaderAiRole(value: unknown): value is ReaderAiMessage['role'] {
  return value === 'user' || value === 'assistant';
}

export function normalizeReaderAiMessages(value: unknown): ReaderAiMessage[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((item): ReaderAiMessage | null => {
      if (!item || typeof item !== 'object') return null;
      const role = (item as { role?: unknown }).role;
      const content = (item as { content?: unknown }).content;
      const edited = (item as { edited?: unknown }).edited;
      if (!isReaderAiRole(role) || typeof content !== 'string') return null;
      const message: ReaderAiMessage = { role, content };
      if (edited === true) message.edited = true;
      return message;
    })
    .filter((message): message is ReaderAiMessage => message !== null);
  return normalized.slice(-READER_AI_HISTORY_MAX_MESSAGES);
}

function normalizePersistedStagedChanges(value: unknown): {
  changes: NonNullable<ReaderAiHistoryEntry['stagedChanges']>;
  invalid: boolean;
} {
  if (value === undefined) return { changes: [], invalid: false };
  if (!Array.isArray(value)) return { changes: [], invalid: true };
  const changes: NonNullable<ReaderAiHistoryEntry['stagedChanges']> = [];
  let invalid = false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      invalid = true;
      continue;
    }
    const path = typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : '';
    const type = typeof (entry as { type?: unknown }).type === 'string' ? (entry as { type: string }).type : '';
    const diff = typeof (entry as { diff?: unknown }).diff === 'string' ? (entry as { diff: string }).diff : '';
    const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : undefined;
    const revision =
      typeof (entry as { revision?: unknown }).revision === 'number'
        ? (entry as { revision: number }).revision
        : undefined;
    const originalContent =
      (entry as { originalContent?: unknown }).originalContent === null ||
      typeof (entry as { originalContent?: unknown }).originalContent === 'string'
        ? ((entry as { originalContent?: string | null }).originalContent ?? undefined)
        : undefined;
    const modifiedContent =
      (entry as { modifiedContent?: unknown }).modifiedContent === null ||
      typeof (entry as { modifiedContent?: unknown }).modifiedContent === 'string'
        ? ((entry as { modifiedContent?: string | null }).modifiedContent ?? undefined)
        : undefined;
    const hunksRaw = (entry as { hunks?: unknown }).hunks;
    if (!path || (type !== 'edit' && type !== 'create' && type !== 'delete') || !diff) {
      invalid = true;
      continue;
    }
    const hunks = Array.isArray(hunksRaw)
      ? hunksRaw
          .map((hunk): ReaderAiStagedHunk | null => {
            if (!hunk || typeof hunk !== 'object') return null;
            const header =
              typeof (hunk as { header?: unknown }).header === 'string' ? (hunk as { header: string }).header : '';
            const hunkId = typeof (hunk as { id?: unknown }).id === 'string' ? (hunk as { id: string }).id : '';
            const oldStart =
              typeof (hunk as { oldStart?: unknown }).oldStart === 'number'
                ? (hunk as { oldStart: number }).oldStart
                : NaN;
            const oldLines =
              typeof (hunk as { oldLines?: unknown }).oldLines === 'number'
                ? (hunk as { oldLines: number }).oldLines
                : NaN;
            const newStart =
              typeof (hunk as { newStart?: unknown }).newStart === 'number'
                ? (hunk as { newStart: number }).newStart
                : NaN;
            const newLines =
              typeof (hunk as { newLines?: unknown }).newLines === 'number'
                ? (hunk as { newLines: number }).newLines
                : NaN;
            const linesRaw = (hunk as { lines?: unknown }).lines;
            if (
              !hunkId ||
              !header ||
              !Number.isFinite(oldStart) ||
              !Number.isFinite(oldLines) ||
              !Number.isFinite(newStart) ||
              !Number.isFinite(newLines) ||
              !Array.isArray(linesRaw)
            ) {
              return null;
            }
            const lines = linesRaw
              .map((line) => {
                if (!line || typeof line !== 'object') return null;
                const lineType = (line as { type?: unknown }).type;
                const contentValue = (line as { content?: unknown }).content;
                if (
                  (lineType !== 'context' && lineType !== 'add' && lineType !== 'del') ||
                  typeof contentValue !== 'string'
                ) {
                  return null;
                }
                return { type: lineType, content: contentValue } as const;
              })
              .filter((line): line is NonNullable<typeof line> => line !== null);
            if (lines.length === 0) return null;
            return { id: hunkId, header, oldStart, oldLines, newStart, newLines, lines };
          })
          .filter((hunk): hunk is NonNullable<typeof hunk> => hunk !== null)
      : undefined;
    changes.push({
      ...(id ? { id } : {}),
      path,
      type,
      diff,
      ...(typeof revision === 'number' ? { revision } : {}),
      ...(originalContent !== undefined ? { originalContent } : {}),
      ...(modifiedContent !== undefined ? { modifiedContent } : {}),
      ...(hunks && hunks.length > 0 ? { hunks } : {}),
    });
  }
  return { changes, invalid };
}

function normalizePersistedEditProposals(value: unknown): ReaderAiEditProposal[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ReaderAiEditProposal | null => {
      if (!entry || typeof entry !== 'object') return null;
      const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : '';
      const toolCallId =
        typeof (entry as { toolCallId?: unknown }).toolCallId === 'string'
          ? (entry as { toolCallId: string }).toolCallId
          : undefined;
      const statusRaw = (entry as { status?: unknown }).status;
      const status = statusRaw === 'accepted' || statusRaw === 'rejected' ? statusRaw : undefined;
      const selectedHunkIdsRaw = (entry as { selectedHunkIds?: unknown }).selectedHunkIds;
      const selectedHunkIds = Array.isArray(selectedHunkIdsRaw)
        ? selectedHunkIdsRaw.filter((value): value is string => typeof value === 'string')
        : undefined;
      const normalizedChange = normalizePersistedStagedChanges([(entry as { change?: unknown }).change]).changes[0];
      if (!id || !normalizedChange) return null;
      return {
        id,
        ...(toolCallId ? { toolCallId } : {}),
        change: normalizedChange,
        ...(status ? { status } : {}),
        ...(selectedHunkIds ? { selectedHunkIds } : {}),
      };
    })
    .filter((proposal): proposal is ReaderAiEditProposal => proposal !== null);
}

function normalizePersistedProposalStatuses(
  value: unknown,
): NonNullable<ReaderAiHistoryEntry['proposalStatusesByToolCallId']> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, 'accepted' | 'rejected' | 'ignored'] =>
        typeof entry[0] === 'string' && (entry[1] === 'accepted' || entry[1] === 'rejected' || entry[1] === 'ignored'),
    ),
  );
}

function normalizePersistedAppliedChanges(value: unknown): NonNullable<ReaderAiHistoryEntry['appliedChanges']> {
  if (!Array.isArray(value)) return [];
  const applied: NonNullable<ReaderAiHistoryEntry['appliedChanges']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const path = typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : '';
    const type = typeof (entry as { type?: unknown }).type === 'string' ? (entry as { type: string }).type : '';
    const appliedAt =
      typeof (entry as { appliedAt?: unknown }).appliedAt === 'string'
        ? (entry as { appliedAt: string }).appliedAt
        : '';
    if (!path || (type !== 'edit' && type !== 'create' && type !== 'delete') || !appliedAt) continue;
    applied.push({ path, type, appliedAt });
  }
  if (applied.length <= READER_AI_HISTORY_MAX_APPLIED_CHANGES) return applied;
  return applied.slice(-READER_AI_HISTORY_MAX_APPLIED_CHANGES);
}

function normalizePersistedQueuedCommands(value: unknown): NonNullable<ReaderAiHistoryEntry['queuedCommands']> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, 10);
}

function normalizePersistedEditorCheckpoints(value: unknown): NonNullable<ReaderAiHistoryEntry['editorCheckpoints']> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ReaderAiEditorCheckpoint | null => {
      if (!entry || typeof entry !== 'object') return null;
      const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : '';
      const path = typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : '';
      const content =
        typeof (entry as { content?: unknown }).content === 'string' ? (entry as { content: string }).content : '';
      const appliedContentRaw = (entry as { appliedContent?: unknown }).appliedContent;
      const revision =
        typeof (entry as { revision?: unknown }).revision === 'number' ? (entry as { revision: number }).revision : NaN;
      const createdAt =
        typeof (entry as { createdAt?: unknown }).createdAt === 'string'
          ? (entry as { createdAt: string }).createdAt
          : '';
      const status = (entry as { status?: unknown }).status;
      if (
        !id ||
        !path ||
        !createdAt ||
        !Number.isFinite(revision) ||
        (status !== 'active' && status !== 'restored' && status !== 'discarded')
      ) {
        return null;
      }
      const selectionRaw = (entry as { selection?: unknown }).selection;
      const selection =
        selectionRaw &&
        typeof selectionRaw === 'object' &&
        typeof (selectionRaw as { anchor?: unknown }).anchor === 'number' &&
        typeof (selectionRaw as { head?: unknown }).head === 'number'
          ? {
              anchor: (selectionRaw as { anchor: number }).anchor,
              head: (selectionRaw as { head: number }).head,
            }
          : null;
      const scrollTopRaw = (entry as { scrollTop?: unknown }).scrollTop;
      return {
        id,
        path,
        content,
        appliedContent: typeof appliedContentRaw === 'string' ? appliedContentRaw : null,
        revision,
        selection,
        scrollTop: typeof scrollTopRaw === 'number' ? scrollTopRaw : null,
        createdAt,
        changeSetId:
          typeof (entry as { changeSetId?: unknown }).changeSetId === 'string'
            ? (entry as { changeSetId: string }).changeSetId
            : null,
        status,
      };
    })
    .filter((checkpoint): checkpoint is ReaderAiEditorCheckpoint => checkpoint !== null);
}

function normalizePersistedToolLog(value: unknown): NonNullable<ReaderAiHistoryEntry['toolLog']> {
  if (!Array.isArray(value)) return [];
  return value
    .map((toolEntry): NonNullable<ReaderAiHistoryEntry['toolLog']>[number] | null => {
      if (!toolEntry || typeof toolEntry !== 'object') return null;
      const type = (toolEntry as { type?: unknown }).type;
      const name = (toolEntry as { name?: unknown }).name;
      if ((type !== 'call' && type !== 'result' && type !== 'progress') || typeof name !== 'string' || !name.trim()) {
        return null;
      }
      const taskStatus = (toolEntry as { taskStatus?: unknown }).taskStatus;
      const tone = (toolEntry as { tone?: unknown }).tone;
      return {
        type,
        name,
        id: typeof (toolEntry as { id?: unknown }).id === 'string' ? (toolEntry as { id: string }).id : undefined,
        detail:
          typeof (toolEntry as { detail?: unknown }).detail === 'string'
            ? (toolEntry as { detail: string }).detail
            : undefined,
        taskId:
          typeof (toolEntry as { taskId?: unknown }).taskId === 'string'
            ? (toolEntry as { taskId: string }).taskId
            : undefined,
        taskStatus:
          taskStatus === 'running' || taskStatus === 'completed' || taskStatus === 'error' ? taskStatus : undefined,
        tone: tone === 'default' || tone === 'success' || tone === 'error' ? tone : undefined,
      };
    })
    .filter((toolEntry): toolEntry is NonNullable<ReaderAiHistoryEntry['toolLog']>[number] => toolEntry !== null);
}

function normalizePersistedRuns(value: unknown): NonNullable<ReaderAiHistoryEntry['runs']> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ReaderAiRunRecord | null => {
      if (!entry || typeof entry !== 'object') return null;
      const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : '';
      const modelId =
        typeof (entry as { modelId?: unknown }).modelId === 'string' ? (entry as { modelId: string }).modelId : '';
      const createdAt =
        typeof (entry as { createdAt?: unknown }).createdAt === 'string'
          ? (entry as { createdAt: string }).createdAt
          : '';
      const updatedAt =
        typeof (entry as { updatedAt?: unknown }).updatedAt === 'string'
          ? (entry as { updatedAt: string }).updatedAt
          : createdAt;
      const status = (entry as { status?: unknown }).status;
      if (
        !id ||
        !modelId ||
        !createdAt ||
        (status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'aborted')
      ) {
        return null;
      }
      const baseMessages = normalizeReaderAiMessages((entry as { baseMessages?: unknown }).baseMessages);
      const scopeRaw = (entry as { scope?: unknown }).scope;
      let scope: ReaderAiRunRecord['scope'] | undefined;
      if (scopeRaw && typeof scopeRaw === 'object') {
        const kind = (scopeRaw as { kind?: unknown }).kind;
        const source = (scopeRaw as { source?: unknown }).source;
        if (kind === 'document') scope = { kind: 'document' };
        else if (kind === 'selection' && typeof source === 'string' && source) scope = { kind: 'selection', source };
      }
      const stepsRaw = (entry as { steps?: unknown }).steps;
      const steps = Array.isArray(stepsRaw)
        ? stepsRaw
            .map((step): ReaderAiRunRecord['steps'][number] | null => {
              if (!step || typeof step !== 'object') return null;
              const stepId = typeof (step as { id?: unknown }).id === 'string' ? (step as { id: string }).id : '';
              const kind = (step as { kind?: unknown }).kind;
              const name = typeof (step as { name?: unknown }).name === 'string' ? (step as { name: string }).name : '';
              const stepStatus = (step as { status?: unknown }).status;
              const startedAt =
                typeof (step as { startedAt?: unknown }).startedAt === 'string'
                  ? (step as { startedAt: string }).startedAt
                  : '';
              if (
                !stepId ||
                (kind !== 'tool' && kind !== 'task') ||
                !name ||
                (stepStatus !== 'running' && stepStatus !== 'completed' && stepStatus !== 'failed') ||
                !startedAt
              ) {
                return null;
              }
              return {
                id: stepId,
                kind,
                name,
                status: stepStatus,
                startedAt,
                retryCount:
                  typeof (step as { retryCount?: unknown }).retryCount === 'number'
                    ? (step as { retryCount: number }).retryCount
                    : 0,
                maxRetries:
                  typeof (step as { maxRetries?: unknown }).maxRetries === 'number'
                    ? (step as { maxRetries: number }).maxRetries
                    : 0,
                retryable: (step as { retryable?: unknown }).retryable === true,
                retryState:
                  (step as { retryState?: unknown }).retryState === 'ready' ||
                  (step as { retryState?: unknown }).retryState === 'in_progress' ||
                  (step as { retryState?: unknown }).retryState === 'exhausted'
                    ? ((step as { retryState: 'ready' | 'in_progress' | 'exhausted' }).retryState as
                        | 'ready'
                        | 'in_progress'
                        | 'exhausted')
                    : 'none',
                retryReason:
                  (step as { retryReason?: unknown }).retryReason === 'transient' ||
                  (step as { retryReason?: unknown }).retryReason === 'tool-arguments' ||
                  (step as { retryReason?: unknown }).retryReason === 'task-failure' ||
                  (step as { retryReason?: unknown }).retryReason === 'unknown'
                    ? ((
                        step as {
                          retryReason: 'transient' | 'tool-arguments' | 'task-failure' | 'unknown';
                        }
                      ).retryReason as 'transient' | 'tool-arguments' | 'task-failure' | 'unknown')
                    : undefined,
                toolCallId:
                  typeof (step as { toolCallId?: unknown }).toolCallId === 'string'
                    ? (step as { toolCallId: string }).toolCallId
                    : undefined,
                taskId:
                  typeof (step as { taskId?: unknown }).taskId === 'string'
                    ? (step as { taskId: string }).taskId
                    : undefined,
                detail:
                  typeof (step as { detail?: unknown }).detail === 'string'
                    ? (step as { detail: string }).detail
                    : undefined,
                args:
                  typeof (step as { args?: unknown }).args === 'string' ? (step as { args: string }).args : undefined,
                error:
                  typeof (step as { error?: unknown }).error === 'string'
                    ? (step as { error: string }).error
                    : undefined,
                errorCode:
                  (step as { errorCode?: unknown }).errorCode === 'invalid_arguments' ||
                  (step as { errorCode?: unknown }).errorCode === 'conflict' ||
                  (step as { errorCode?: unknown }).errorCode === 'not_found' ||
                  (step as { errorCode?: unknown }).errorCode === 'timeout' ||
                  (step as { errorCode?: unknown }).errorCode === 'rate_limited' ||
                  (step as { errorCode?: unknown }).errorCode === 'network' ||
                  (step as { errorCode?: unknown }).errorCode === 'task_failed' ||
                  (step as { errorCode?: unknown }).errorCode === 'unknown_tool' ||
                  (step as { errorCode?: unknown }).errorCode === 'unknown'
                    ? ((step as { errorCode: ReaderAiStepErrorCode }).errorCode as ReaderAiStepErrorCode)
                    : undefined,
                finishedAt:
                  typeof (step as { finishedAt?: unknown }).finishedAt === 'string'
                    ? (step as { finishedAt: string }).finishedAt
                    : undefined,
              };
            })
            .filter((step): step is ReaderAiRunRecord['steps'][number] => step !== null)
        : [];
      return {
        id,
        modelId,
        createdAt,
        updatedAt,
        status,
        baseMessages,
        toolLog: normalizePersistedToolLog((entry as { toolLog?: unknown }).toolLog),
        steps,
        ...(scope ? { scope } : {}),
        ...(typeof (entry as { parentRunId?: unknown }).parentRunId === 'string'
          ? { parentRunId: (entry as { parentRunId: string }).parentRunId }
          : {}),
        ...(typeof (entry as { completedAt?: unknown }).completedAt === 'string'
          ? { completedAt: (entry as { completedAt: string }).completedAt }
          : {}),
        ...(typeof (entry as { summary?: unknown }).summary === 'string'
          ? { summary: (entry as { summary: string }).summary }
          : {}),
        ...(typeof (entry as { response?: unknown }).response === 'string'
          ? { response: (entry as { response: string }).response }
          : {}),
        ...(typeof (entry as { error?: unknown }).error === 'string'
          ? { error: (entry as { error: string }).error }
          : {}),
      };
    })
    .filter((run): run is ReaderAiRunRecord => run !== null);
}

function normalizePersistedChangeSets(value: unknown): NonNullable<ReaderAiHistoryEntry['changeSets']> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ReaderAiChangeSetRecord | null => {
      if (!entry || typeof entry !== 'object') return null;
      const id = typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : '';
      const runId = typeof (entry as { runId?: unknown }).runId === 'string' ? (entry as { runId: string }).runId : '';
      const createdAt =
        typeof (entry as { createdAt?: unknown }).createdAt === 'string'
          ? (entry as { createdAt: string }).createdAt
          : '';
      const updatedAt =
        typeof (entry as { updatedAt?: unknown }).updatedAt === 'string'
          ? (entry as { updatedAt: string }).updatedAt
          : createdAt;
      const status = (entry as { status?: unknown }).status;
      if (
        !id ||
        !runId ||
        !createdAt ||
        !updatedAt ||
        (status !== 'draft' &&
          status !== 'ready' &&
          status !== 'applying' &&
          status !== 'applied' &&
          status !== 'partial' &&
          status !== 'failed' &&
          status !== 'conflicted' &&
          status !== 'superseded')
      ) {
        return null;
      }
      const stagedChanges = normalizePersistedStagedChanges(
        (entry as { stagedChanges?: unknown }).stagedChanges,
      ).changes;
      const editProposals = normalizePersistedEditProposals((entry as { editProposals?: unknown }).editProposals);
      const proposalStatuses = normalizePersistedProposalStatuses(
        (entry as { proposalStatusesByToolCallId?: unknown }).proposalStatusesByToolCallId,
      );
      const stagedFileContentsRaw = (entry as { stagedFileContents?: unknown }).stagedFileContents;
      const stagedFileContents =
        stagedFileContentsRaw && typeof stagedFileContentsRaw === 'object'
          ? Object.fromEntries(
              Object.entries(stagedFileContentsRaw).filter(
                (item): item is [string, string] => typeof item[0] === 'string' && typeof item[1] === 'string',
              ),
            )
          : {};
      const appliedPathsRaw = (entry as { appliedPaths?: unknown }).appliedPaths;
      const failedPathsRaw = (entry as { failedPaths?: unknown }).failedPaths;
      const filesRaw = (entry as { files?: unknown }).files;
      const files = Array.isArray(filesRaw)
        ? filesRaw
            .map((file): ReaderAiChangeSetFileRecord | null => {
              if (!file || typeof file !== 'object') return null;
              const path = typeof (file as { path?: unknown }).path === 'string' ? (file as { path: string }).path : '';
              const status = (file as { status?: unknown }).status;
              if (
                !path ||
                (status !== 'ready' &&
                  status !== 'missing_content' &&
                  status !== 'stale' &&
                  status !== 'applied' &&
                  status !== 'failed' &&
                  status !== 'conflicted')
              ) {
                return null;
              }
              return {
                path,
                status,
                hasCompleteContent: (file as { hasCompleteContent?: unknown }).hasCompleteContent === true,
                ...(typeof (file as { baseRevision?: unknown }).baseRevision === 'number'
                  ? { baseRevision: (file as { baseRevision: number }).baseRevision }
                  : {}),
                ...(typeof (file as { originalHash?: unknown }).originalHash === 'string'
                  ? { originalHash: (file as { originalHash: string }).originalHash }
                  : {}),
                ...(typeof (file as { modifiedHash?: unknown }).modifiedHash === 'string'
                  ? { modifiedHash: (file as { modifiedHash: string }).modifiedHash }
                  : {}),
              };
            })
            .filter((file): file is ReaderAiChangeSetFileRecord => file !== null)
        : [];
      return {
        id,
        runId,
        createdAt,
        updatedAt,
        status,
        editProposals,
        proposalStatusesByToolCallId: proposalStatuses,
        stagedChanges,
        stagedFileContents,
        documentEditedContent:
          typeof (entry as { documentEditedContent?: unknown }).documentEditedContent === 'string'
            ? (entry as { documentEditedContent: string }).documentEditedContent
            : null,
        files,
        appliedPaths: Array.isArray(appliedPathsRaw)
          ? appliedPathsRaw.filter((path): path is string => typeof path === 'string')
          : [],
        failedPaths: Array.isArray(failedPathsRaw)
          ? failedPathsRaw
              .map((failed) => {
                if (!failed || typeof failed !== 'object') return null;
                const path =
                  typeof (failed as { path?: unknown }).path === 'string' ? (failed as { path: string }).path : '';
                const error =
                  typeof (failed as { error?: unknown }).error === 'string' ? (failed as { error: string }).error : '';
                return path && error ? { path, error } : null;
              })
              .filter((failed): failed is ReaderAiChangeSetRecord['failedPaths'][number] => failed !== null)
          : [],
      };
    })
    .filter((changeSet): changeSet is ReaderAiChangeSetRecord => changeSet !== null);
}

export function loadReaderAiHistoryStore(): ReaderAiHistoryStore {
  if (typeof window === 'undefined') return { order: [], entries: {} };
  try {
    const raw = localStorage.getItem(READER_AI_HISTORY_KEY);
    if (!raw) return { order: [], entries: {} };
    const parsed = JSON.parse(raw) as { order?: unknown; entries?: unknown };
    const rawEntries = parsed.entries;
    if (!rawEntries || typeof rawEntries !== 'object') return { order: [], entries: {} };
    const entries: Record<string, ReaderAiHistoryEntry> = {};
    for (const [key, value] of Object.entries(rawEntries)) {
      // Support both old format (ReaderAiMessage[]) and new format (ReaderAiHistoryEntry)
      if (Array.isArray(value)) {
        entries[key] = { messages: normalizeReaderAiMessages(value) };
      } else if (value && typeof value === 'object') {
        const entry = value as {
          messages?: unknown;
          summary?: unknown;
          scope?: unknown;
          toolLog?: unknown;
          stagedChanges?: unknown;
          stagedFileContents?: unknown;
          appliedChanges?: unknown;
        };
        const parsed: ReaderAiHistoryEntry = {
          messages: normalizeReaderAiMessages(entry.messages),
        };
        const queuedCommands = normalizePersistedQueuedCommands((entry as { queuedCommands?: unknown }).queuedCommands);
        if (queuedCommands.length > 0) parsed.queuedCommands = queuedCommands;
        if (typeof entry.summary === 'string' && entry.summary) parsed.summary = entry.summary;
        if (entry.scope && typeof entry.scope === 'object') {
          const kind = (entry.scope as { kind?: unknown }).kind;
          const source = (entry.scope as { source?: unknown }).source;
          if (kind === 'document') {
            parsed.scope = { kind: 'document' };
          } else if (kind === 'selection' && typeof source === 'string' && source.length > 0) {
            parsed.scope = { kind: 'selection', source };
          }
        }
        const normalizedToolLog = normalizePersistedToolLog(entry.toolLog);
        if (normalizedToolLog.length > 0) parsed.toolLog = normalizedToolLog;
        const editProposals = normalizePersistedEditProposals((entry as { editProposals?: unknown }).editProposals);
        if (editProposals.length > 0) parsed.editProposals = editProposals;
        const proposalStatuses = normalizePersistedProposalStatuses(
          (entry as { proposalStatusesByToolCallId?: unknown }).proposalStatusesByToolCallId,
        );
        if (Object.keys(proposalStatuses).length > 0) parsed.proposalStatusesByToolCallId = proposalStatuses;
        const normalizedStagedChanges = normalizePersistedStagedChanges(entry.stagedChanges);
        if (normalizedStagedChanges.changes.length > 0) parsed.stagedChanges = normalizedStagedChanges.changes;
        if (normalizedStagedChanges.invalid) parsed.stagedChangesInvalid = true;
        if (entry.stagedFileContents && typeof entry.stagedFileContents === 'object') {
          const contents = Object.fromEntries(
            Object.entries(entry.stagedFileContents).filter(
              (item): item is [string, string] => typeof item[0] === 'string' && typeof item[1] === 'string',
            ),
          );
          if (Object.keys(contents).length > 0) parsed.stagedFileContents = contents;
        }
        const normalizedAppliedChanges = normalizePersistedAppliedChanges(entry.appliedChanges);
        if (normalizedAppliedChanges.length > 0) parsed.appliedChanges = normalizedAppliedChanges;
        const editorCheckpoints = normalizePersistedEditorCheckpoints(
          (entry as { editorCheckpoints?: unknown }).editorCheckpoints,
        );
        if (editorCheckpoints.length > 0) parsed.editorCheckpoints = editorCheckpoints;
        const activeEditorCheckpointId =
          typeof (entry as { activeEditorCheckpointId?: unknown }).activeEditorCheckpointId === 'string'
            ? (entry as { activeEditorCheckpointId: string }).activeEditorCheckpointId
            : undefined;
        if (activeEditorCheckpointId) parsed.activeEditorCheckpointId = activeEditorCheckpointId;
        const runs = normalizePersistedRuns((entry as { runs?: unknown }).runs);
        if (runs.length > 0) parsed.runs = runs;
        const activeRunId =
          typeof (entry as { activeRunId?: unknown }).activeRunId === 'string'
            ? (entry as { activeRunId: string }).activeRunId
            : undefined;
        if (activeRunId && runs.some((run) => run.id === activeRunId)) parsed.activeRunId = activeRunId;
        const changeSets = normalizePersistedChangeSets((entry as { changeSets?: unknown }).changeSets);
        if (changeSets.length > 0) parsed.changeSets = changeSets;
        const activeChangeSetId =
          typeof (entry as { activeChangeSetId?: unknown }).activeChangeSetId === 'string'
            ? (entry as { activeChangeSetId: string }).activeChangeSetId
            : undefined;
        if (activeChangeSetId && changeSets.some((changeSet) => changeSet.id === activeChangeSetId))
          parsed.activeChangeSetId = activeChangeSetId;
        entries[key] = parsed;
      }
    }
    const rawOrder = Array.isArray(parsed.order)
      ? parsed.order.filter((key): key is string => typeof key === 'string')
      : [];
    const order = rawOrder.filter((key, index) => index < READER_AI_HISTORY_MAX_ENTRIES && key in entries);
    for (const key of Object.keys(entries)) {
      if (!order.includes(key)) delete entries[key];
    }
    return { order, entries };
  } catch {
    return { order: [], entries: {} };
  }
}

export function loadReaderAiEntryFromHistory(historyKey: string): ReaderAiHistoryEntry {
  const store = loadReaderAiHistoryStore();
  const entry = store.entries[historyKey] ?? { messages: [] };
  return entry;
}

export function persistReaderAiMessagesToHistory(
  historyKey: string,
  messages: ReaderAiMessage[],
  queuedCommands?: string[],
  summary?: string,
  scope?: ReaderAiHistoryEntry['scope'],
  toolLog?: Array<{
    type: 'call' | 'result' | 'progress';
    id?: string;
    name: string;
    detail?: string;
    taskId?: string;
  }>,
  editProposals?: ReaderAiEditProposal[],
  proposalStatusesByToolCallId?: Record<string, 'accepted' | 'rejected' | 'ignored'>,
  stagedChanges?: ReaderAiStagedChange[],
  stagedChangesInvalid?: boolean,
  stagedFileContents?: Record<string, string>,
  appliedChanges?: Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>,
  runs?: ReaderAiRunRecord[],
  activeRunId?: string,
  changeSets?: ReaderAiChangeSetRecord[],
  activeChangeSetId?: string,
): void {
  if (typeof window === 'undefined') return;
  const store = loadReaderAiHistoryStore();
  const nextEntries = { ...store.entries };
  const nextOrder = store.order.filter((key) => key !== historyKey);
  const normalizedMessages = normalizeReaderAiMessages(messages);
  if (normalizedMessages.length === 0) {
    return;
  }
  const entry: ReaderAiHistoryEntry = { messages: normalizedMessages };
  if (queuedCommands && queuedCommands.length > 0) entry.queuedCommands = queuedCommands.slice(0, 10);
  if (summary) entry.summary = summary;
  if (scope) entry.scope = scope;
  if (toolLog && toolLog.length > 0) entry.toolLog = toolLog;
  if (editProposals && editProposals.length > 0) entry.editProposals = editProposals;
  if (proposalStatusesByToolCallId && Object.keys(proposalStatusesByToolCallId).length > 0)
    entry.proposalStatusesByToolCallId = proposalStatusesByToolCallId;
  if (stagedChanges && stagedChanges.length > 0) entry.stagedChanges = stagedChanges;
  if (stagedChangesInvalid === true) entry.stagedChangesInvalid = true;
  if (stagedFileContents && Object.keys(stagedFileContents).length > 0) entry.stagedFileContents = stagedFileContents;
  if (appliedChanges && appliedChanges.length > 0)
    entry.appliedChanges = appliedChanges.slice(-READER_AI_HISTORY_MAX_APPLIED_CHANGES);
  if (runs && runs.length > 0) entry.runs = runs.slice(-12);
  if (activeRunId && runs?.some((run) => run.id === activeRunId)) entry.activeRunId = activeRunId;
  if (changeSets && changeSets.length > 0) entry.changeSets = changeSets.slice(-12);
  if (activeChangeSetId && changeSets?.some((changeSet) => changeSet.id === activeChangeSetId))
    entry.activeChangeSetId = activeChangeSetId;
  nextEntries[historyKey] = entry;
  nextOrder.unshift(historyKey);
  const trimmedOrder = nextOrder.slice(0, READER_AI_HISTORY_MAX_ENTRIES);
  for (const key of Object.keys(nextEntries)) {
    if (!trimmedOrder.includes(key)) delete nextEntries[key];
  }
  try {
    if (trimmedOrder.length === 0) {
      localStorage.removeItem(READER_AI_HISTORY_KEY);
      return;
    }
    localStorage.setItem(READER_AI_HISTORY_KEY, JSON.stringify({ order: trimmedOrder, entries: nextEntries }));
  } catch {
    return;
  }
}

export function clearReaderAiMessagesFromHistory(historyKey: string): void {
  if (typeof window === 'undefined') return;
  const store = loadReaderAiHistoryStore();
  if (!(historyKey in store.entries)) return;
  const nextEntries = { ...store.entries };
  delete nextEntries[historyKey];
  const trimmedOrder = store.order.filter((key) => key !== historyKey).slice(0, READER_AI_HISTORY_MAX_ENTRIES);
  for (const key of Object.keys(nextEntries)) {
    if (!trimmedOrder.includes(key)) delete nextEntries[key];
  }
  try {
    if (trimmedOrder.length === 0) {
      localStorage.removeItem(READER_AI_HISTORY_KEY);
      return;
    }
    localStorage.setItem(READER_AI_HISTORY_KEY, JSON.stringify({ order: trimmedOrder, entries: nextEntries }));
  } catch {
    return;
  }
}
