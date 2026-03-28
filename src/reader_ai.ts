import {
  appendStreamText,
  initDictionary,
  shouldInsertStreamBoundarySpace,
} from '../shared/stream_boundary_dictionary';
import { responseToApiError } from './api_error';

export interface ReaderAiModel {
  id: string;
  name: string;
  context_length: number;
  featured?: boolean;
  provider?: 'cloud' | 'codex_local';
}

export function formatReaderAiModelDisplayName(model: Pick<ReaderAiModel, 'name' | 'id' | 'provider'>): string {
  const baseName = model.name
    .replace(/\s+\((free|local codex|paid)\)\s*$/i, '')
    .replace(/^Claude\s+/i, '')
    .replace(/\s+30B A3B\s*$/i, '');
  if (model.provider === 'codex_local') return baseName.toLowerCase();
  return baseName.replace(/^[^:]+:\s*/, '');
}

type ReaderAiModelsResponse = {
  models?: ReaderAiModel[];
};

export interface ReaderAiStagedChange {
  path: string;
  type: 'edit' | 'create' | 'delete';
  diff: string;
}

export interface ReaderAiToolCallEvent {
  id?: string;
  name: string;
  arguments?: Record<string, unknown> | string;
}

export interface ReaderAiToolResultEvent {
  id?: string;
  name: string;
  preview?: string;
}

export interface ReaderAiTaskProgressEvent {
  id?: string;
  name?: string;
  phase: 'started' | 'iteration_start' | 'tool_call' | 'tool_result' | 'completed' | 'error';
  iteration?: number;
  detail?: string;
}

export interface ReaderAiEditProposal {
  editId: string;
  toolCallId: string;
  path: string;
  type: 'edit' | 'create' | 'delete';
  diff: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ReaderAiToolCallDeltaEvent {
  id: string;
  name: string;
  argumentsDelta: string;
  argumentsSoFar: string;
}

interface ReaderAiStreamOptions {
  onDelta: (delta: string) => void;
  onSummary?: (summary: string) => void;
  onToolCall?: (event: ReaderAiToolCallEvent) => void;
  onToolResult?: (event: ReaderAiToolResultEvent) => void;
  onTaskProgress?: (event: ReaderAiTaskProgressEvent) => void;
  onEditProposal?: (proposal: Omit<ReaderAiEditProposal, 'status'>) => void;
  onToolCallDelta?: (event: ReaderAiToolCallDeltaEvent) => void;
  onStagedChanges?: (
    changes: ReaderAiStagedChange[],
    suggestedCommitMessage?: string,
    documentContent?: string,
    fileContents?: Record<string, string>,
  ) => void;
  onStreamError?: (message: string) => void;
  onTurnStart?: (iteration: number) => void;
  onTurnEnd?: (iteration: number, reason: string) => void;
  mode?: 'default' | 'prompt_list';
  signal?: AbortSignal;
}

const LOCAL_CODEX_MODEL_PREFIX = 'codex_local::';
const LOCAL_CODEX_BRIDGE_DEFAULT_URL = 'http://127.0.0.1:8788';
const LOCAL_CODEX_BRIDGE_STORAGE_KEY = 'input.localCodexBridgeUrl';
const LOCAL_CODEX_ENABLED_STORAGE_KEY = 'input.localCodexEnabled';

export function localCodexEnabledByPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(LOCAL_CODEX_ENABLED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setLocalCodexEnabledByPreference(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.localStorage.setItem(LOCAL_CODEX_ENABLED_STORAGE_KEY, 'true');
      return;
    }
    window.localStorage.removeItem(LOCAL_CODEX_ENABLED_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function getLocalCodexBridgeBaseUrl(): string {
  if (typeof window === 'undefined') return LOCAL_CODEX_BRIDGE_DEFAULT_URL;
  try {
    const raw = window.localStorage.getItem(LOCAL_CODEX_BRIDGE_STORAGE_KEY)?.trim();
    if (raw) return raw.replace(/\/+$/, '');
  } catch {
    // ignore
  }
  return LOCAL_CODEX_BRIDGE_DEFAULT_URL;
}

function isLocalCodexModel(modelId: string): boolean {
  return modelId.startsWith(LOCAL_CODEX_MODEL_PREFIX);
}

function stripLocalCodexModelPrefix(modelId: string): string {
  return isLocalCodexModel(modelId) ? modelId.slice(LOCAL_CODEX_MODEL_PREFIX.length) : modelId;
}

function modelRequestBaseUrl(modelId: string): string {
  return isLocalCodexModel(modelId) ? getLocalCodexBridgeBaseUrl() : '';
}

function shouldRepairStreamBoundaries(modelId: string): boolean {
  return !isLocalCodexModel(modelId) && modelId.trim().toLowerCase().endsWith(':free');
}

function withBaseUrl(baseUrl: string, path: string): string {
  return baseUrl ? `${baseUrl}${path}` : path;
}

async function fetchJsonWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 1200,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return await fetch(input, { ...init, signal });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function listLocalCodexModels(): Promise<ReaderAiModel[]> {
  const res = await fetchJsonWithTimeout(withBaseUrl(getLocalCodexBridgeBaseUrl(), '/api/ai/models'));
  if (!res.ok) throw await responseToApiError(res);
  const data = (await res.json()) as ReaderAiModelsResponse;
  return (Array.isArray(data.models) ? data.models : [])
    .map((model, originalIndex) => ({
      ...model,
      id: `${LOCAL_CODEX_MODEL_PREFIX}${model.id}`,
      provider: 'codex_local' as const,
      originalIndex,
    }))
    .sort((a, b) => {
      const aNormalized = `${a.id} ${a.name}`.toLowerCase();
      const bNormalized = `${b.id} ${b.name}`.toLowerCase();
      const aCodexVariant = aNormalized.includes('-codex');
      const bCodexVariant = bNormalized.includes('-codex');
      if (aCodexVariant !== bCodexVariant) return aCodexVariant ? 1 : -1;
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    })
    .slice(0, 3)
    .map(({ originalIndex: _originalIndex, ...model }) => model);
}

/** Returns 0 for featured models, -1 for non-featured. */
export function readerAiModelPriorityRank(model: ReaderAiModel): number {
  return model.featured ? 0 : -1;
}

export async function listReaderAiModels(): Promise<ReaderAiModel[]> {
  const localCodexEnabled = localCodexEnabledByPreference();
  const [local, cloud] = await Promise.allSettled([
    localCodexEnabled ? listLocalCodexModels() : Promise.resolve([]),
    (async () => {
      const res = await fetch('/api/ai/models', { credentials: 'same-origin' });
      if (!res.ok) throw await responseToApiError(res);
      const data = (await res.json()) as ReaderAiModelsResponse;
      return (Array.isArray(data.models) ? data.models : []).map((model) => ({ ...model, provider: 'cloud' as const }));
    })(),
  ]);

  const models: ReaderAiModel[] = [];
  if (local.status === 'fulfilled') models.push(...local.value);
  if (cloud.status === 'fulfilled') models.push(...cloud.value);
  if (models.length > 0) return models;

  if (local.status === 'rejected') throw local.reason;
  throw cloud.status === 'rejected' ? cloud.reason : new Error('No Reader AI models available');
}

function shouldRepairConversationalBoundary(
  mode: ReaderAiStreamOptions['mode'],
  editModeCurrentDocOnly?: boolean,
): boolean {
  return editModeCurrentDocOnly !== true && mode !== undefined;
}

function joinStructuredContentSegments(segments: string[]): string {
  let result = '';
  for (const segment of segments) {
    if (!segment) continue;
    result = appendStreamText(result, segment);
  }
  return result;
}

function extractStreamDelta(payload: unknown): string {
  const extractContentText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return joinStructuredContentSegments(content.map((part) => extractContentText(part)));
    if (!content || typeof content !== 'object') return '';

    const value = content as { text?: unknown; value?: unknown };
    if (typeof value.text === 'string') return value.text;
    if (typeof value.value === 'string') return value.value;
    if (value.text && typeof value.text === 'object') return extractContentText(value.text);
    return '';
  };

  if (!payload || typeof payload !== 'object') return '';
  const choice = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || choice.length === 0) return '';
  const first = choice[0] as { delta?: unknown; message?: unknown };
  if (first?.delta && typeof first.delta === 'object') {
    const content = (first.delta as { content?: unknown }).content;
    return extractContentText(content);
  }
  if (first?.message && typeof first.message === 'object') {
    const content = (first.message as { content?: unknown }).content;
    return extractContentText(content);
  }
  return '';
}

export interface ReaderAiProjectFile {
  path: string;
  content: string;
  size: number;
}

export interface ReaderAiProjectSession {
  projectId: string;
  fileCount: number;
}

export async function createReaderAiProjectSession(
  files: ReaderAiProjectFile[],
  modelId?: string,
): Promise<ReaderAiProjectSession> {
  const baseUrl = modelId ? modelRequestBaseUrl(modelId) : '';
  const res = await fetch(withBaseUrl(baseUrl, '/api/ai/project'), {
    method: 'POST',
    credentials: baseUrl ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw await responseToApiError(res);
  const data = (await res.json()) as { project_id?: string; file_count?: number };
  if (!data.project_id) throw new Error('Missing project_id in response');
  return { projectId: data.project_id, fileCount: data.file_count ?? files.length };
}

export async function resetReaderAiProjectSession(projectId: string, modelId?: string): Promise<void> {
  try {
    const baseUrl = modelId ? modelRequestBaseUrl(modelId) : '';
    await fetch(withBaseUrl(baseUrl, `/api/ai/project/${encodeURIComponent(projectId)}/reset`), {
      method: 'POST',
      credentials: baseUrl ? 'omit' : 'same-origin',
    });
  } catch {
    // Best-effort — ignore errors.
  }
}

export async function updateReaderAiProjectSessionFile(
  projectId: string,
  path: string,
  content: string,
  modelId?: string,
): Promise<void> {
  const baseUrl = modelId ? modelRequestBaseUrl(modelId) : '';
  const res = await fetch(withBaseUrl(baseUrl, `/api/ai/project/${encodeURIComponent(projectId)}/file`), {
    method: 'POST',
    credentials: baseUrl ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) throw await responseToApiError(res);
}

export async function deleteReaderAiProjectSession(projectId: string, modelId?: string): Promise<void> {
  try {
    const baseUrl = modelId ? modelRequestBaseUrl(modelId) : '';
    await fetch(withBaseUrl(baseUrl, `/api/ai/project/${encodeURIComponent(projectId)}`), {
      method: 'DELETE',
      credentials: baseUrl ? 'omit' : 'same-origin',
    });
  } catch {
    // Best-effort cleanup — ignore errors.
  }
}

export interface ReaderAiApplyResult {
  applied: string[];
  failed: Array<{ path: string; error: string }>;
}

type ReaderAiApplyContext =
  | { kind: 'gist'; gistId: string }
  | { kind: 'repo'; installationId: string; repoFullName: string };

export async function applyReaderAiChanges(
  context: ReaderAiApplyContext,
  changes: ReaderAiStagedChange[],
  fileContents: Record<string, string>,
  commitMessage?: string,
): Promise<ReaderAiApplyResult> {
  const body =
    context.kind === 'gist'
      ? {
          context: { kind: 'gist' as const, gist_id: context.gistId },
          changes,
          file_contents: fileContents,
          commit_message: commitMessage,
        }
      : {
          context: {
            kind: 'repo' as const,
            installation_id: context.installationId,
            repo_full_name: context.repoFullName,
          },
          changes,
          file_contents: fileContents,
          commit_message: commitMessage,
        };
  const res = await fetch('/api/ai/apply', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseToApiError(res);
  const data = (await res.json()) as {
    applied?: string[];
    failed?: Array<{ path?: string; error?: string }>;
  };
  return {
    applied: Array.isArray(data.applied) ? data.applied.filter((path): path is string => typeof path === 'string') : [],
    failed: Array.isArray(data.failed)
      ? data.failed
          .map((entry) => ({
            path: typeof entry.path === 'string' ? entry.path : '',
            error: typeof entry.error === 'string' ? entry.error : 'Unknown error',
          }))
          .filter((entry) => entry.path.length > 0)
      : [],
  };
}

export async function askReaderAiStream(
  model: string,
  source: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  options: ReaderAiStreamOptions,
  summary?: string,
  projectContext?: { projectId: string; currentDocPath: string | null },
  currentDocPath?: string | null,
  editModeCurrentDocOnly?: boolean,
): Promise<void> {
  // Ensure the stream boundary dictionary is loaded before processing chunks.
  await initDictionary().catch(() => {});
  // Resolve current_doc_path: projectContext takes precedence when present
  const resolvedDocPath = projectContext?.currentDocPath ?? currentDocPath ?? null;
  const baseUrl = modelRequestBaseUrl(model);
  const res = await fetch(withBaseUrl(baseUrl, '/api/ai/chat'), {
    method: 'POST',
    credentials: baseUrl ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model: stripLocalCodexModelPrefix(model),
      source,
      messages,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(summary ? { summary } : {}),
      ...(typeof resolvedDocPath === 'string' && resolvedDocPath ? { current_doc_path: resolvedDocPath } : {}),
      ...(editModeCurrentDocOnly ? { edit_mode_current_doc_only: true } : {}),
      ...(projectContext ? { project_id: projectContext.projectId } : {}),
    }),
  });
  if (!res.ok) throw await responseToApiError(res);

  const body = res.body;
  if (!body) throw new Error('Reader AI stream is unavailable');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  const repairStreamBoundaries = shouldRepairStreamBoundaries(model);
  let pendingVisibleDelta = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const lines = event.split('\n');
      const eventTypeLine = lines.find((line) => line.startsWith('event:'));
      const eventType = eventTypeLine ? parseSseFieldValue(eventTypeLine, 'event:').trim() : '';
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => parseSseFieldValue(line, 'data:'));
      const data = dataLines.join('\n');
      if (!data || data === '[DONE]') {
        // skip
      } else if (eventType === 'summary' && options.onSummary) {
        try {
          const parsed = JSON.parse(data) as { summary?: string };
          if (typeof parsed.summary === 'string' && parsed.summary) options.onSummary(parsed.summary);
        } catch {
          // Ignore malformed summary event.
        }
      } else if (eventType === 'tool_call') {
        if (options.onToolCall) {
          try {
            const parsed = JSON.parse(data) as {
              id?: string;
              name?: string;
              arguments?: Record<string, unknown> | string;
            };
            if (typeof parsed.name === 'string')
              options.onToolCall({ name: parsed.name, id: parsed.id, arguments: parsed.arguments });
          } catch {
            // Ignore malformed tool_call event.
          }
        }
      } else if (eventType === 'tool_result') {
        if (options.onToolResult) {
          try {
            const parsed = JSON.parse(data) as { id?: string; name?: string; preview?: string };
            if (typeof parsed.name === 'string')
              options.onToolResult({ name: parsed.name, id: parsed.id, preview: parsed.preview });
          } catch {
            // Ignore malformed tool_result event.
          }
        }
      } else if (eventType === 'tool_call_delta') {
        if (options.onToolCallDelta) {
          try {
            const parsed = JSON.parse(data) as {
              id?: string;
              name?: string;
              arguments_delta?: string;
              arguments_so_far?: string;
            };
            if (typeof parsed.id === 'string' && typeof parsed.name === 'string') {
              options.onToolCallDelta({
                id: parsed.id,
                name: parsed.name,
                argumentsDelta: typeof parsed.arguments_delta === 'string' ? parsed.arguments_delta : '',
                argumentsSoFar: typeof parsed.arguments_so_far === 'string' ? parsed.arguments_so_far : '',
              });
            }
          } catch {
            // Ignore malformed tool_call_delta event.
          }
        }
      } else if (eventType === 'edit_proposal') {
        if (options.onEditProposal) {
          try {
            const parsed = JSON.parse(data) as {
              edit_id?: string;
              tool_call_id?: string;
              path?: string;
              type?: string;
              diff?: string;
            };
            if (
              typeof parsed.edit_id === 'string' &&
              typeof parsed.path === 'string' &&
              typeof parsed.diff === 'string' &&
              (parsed.type === 'edit' || parsed.type === 'create' || parsed.type === 'delete')
            ) {
              options.onEditProposal({
                editId: parsed.edit_id,
                toolCallId: parsed.tool_call_id ?? parsed.edit_id,
                path: parsed.path,
                type: parsed.type,
                diff: parsed.diff,
              });
            }
          } catch {
            // Ignore malformed edit_proposal event.
          }
        }
      } else if (eventType === 'task_progress') {
        if (options.onTaskProgress) {
          try {
            const parsed = JSON.parse(data) as {
              id?: string;
              name?: string;
              phase?: ReaderAiTaskProgressEvent['phase'];
              iteration?: number;
              detail?: string;
            };
            if (
              parsed.phase === 'started' ||
              parsed.phase === 'iteration_start' ||
              parsed.phase === 'tool_call' ||
              parsed.phase === 'tool_result' ||
              parsed.phase === 'completed' ||
              parsed.phase === 'error'
            ) {
              options.onTaskProgress({
                id: parsed.id,
                name: parsed.name,
                phase: parsed.phase,
                iteration: typeof parsed.iteration === 'number' ? parsed.iteration : undefined,
                detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
              });
            }
          } catch {
            // Ignore malformed task_progress event.
          }
        }
      } else if (eventType === 'staged_changes') {
        if (options.onStagedChanges) {
          try {
            const parsed = JSON.parse(data) as {
              changes?: ReaderAiStagedChange[];
              suggested_commit_message?: string;
              document_content?: string;
              file_contents?: Record<string, unknown>;
            };
            if (Array.isArray(parsed.changes)) {
              const fileContents =
                parsed.file_contents && typeof parsed.file_contents === 'object'
                  ? Object.fromEntries(
                      Object.entries(parsed.file_contents).filter(
                        (entry): entry is [string, string] =>
                          typeof entry[0] === 'string' && typeof entry[1] === 'string',
                      ),
                    )
                  : undefined;
              options.onStagedChanges(
                parsed.changes,
                parsed.suggested_commit_message,
                typeof parsed.document_content === 'string' ? parsed.document_content : undefined,
                fileContents,
              );
            }
          } catch {
            // Ignore malformed staged_changes event.
          }
        }
      } else if (eventType === 'turn_start') {
        if (options.onTurnStart) {
          try {
            const parsed = JSON.parse(data) as { iteration?: number };
            if (typeof parsed.iteration === 'number') options.onTurnStart(parsed.iteration);
          } catch {
            // Ignore malformed turn_start event.
          }
        }
      } else if (eventType === 'turn_end') {
        if (options.onTurnEnd) {
          try {
            const parsed = JSON.parse(data) as { iteration?: number; reason?: string };
            if (typeof parsed.iteration === 'number') options.onTurnEnd(parsed.iteration, parsed.reason ?? 'unknown');
          } catch {
            // Ignore malformed turn_end event.
          }
        }
      } else if (eventType === 'error') {
        let streamErrorMessage = 'Reader AI stream failed';
        try {
          const parsed = JSON.parse(data) as { message?: string };
          if (typeof parsed.message === 'string' && parsed.message.trim()) {
            streamErrorMessage = parsed.message;
          }
        } catch {
          // Ignore malformed error event payloads.
        }
        options.onStreamError?.(streamErrorMessage);
        throw new Error(streamErrorMessage);
      } else {
        try {
          const parsed = JSON.parse(data) as unknown;
          const delta = extractStreamDelta(parsed);
          if (typeof delta === 'string') {
            const repairBoundary = shouldRepairConversationalBoundary(options.mode, editModeCurrentDocOnly);
            if (repairBoundary) {
              if (!pendingVisibleDelta) {
                pendingVisibleDelta = delta;
              } else {
                const emittedDelta = shouldInsertStreamBoundarySpace(pendingVisibleDelta, delta)
                  ? `${pendingVisibleDelta} `
                  : pendingVisibleDelta;
                streamedText += emittedDelta;
                if (emittedDelta) options.onDelta(emittedDelta);
                pendingVisibleDelta = delta;
              }
            } else {
              const nextText =
                editModeCurrentDocOnly === true
                  ? streamedText + delta
                  : repairStreamBoundaries
                    ? appendStreamText(streamedText, delta)
                    : streamedText + delta;
              const emittedDelta = nextText.slice(streamedText.length);
              streamedText = nextText;
              if (emittedDelta) options.onDelta(emittedDelta);
            }
          }
        } catch {
          // Ignore malformed stream chunks and continue.
        }
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  if (pendingVisibleDelta) {
    streamedText += pendingVisibleDelta;
    options.onDelta(pendingVisibleDelta);
  }
}

function parseSseFieldValue(line: string, prefix: 'event:' | 'data:'): string {
  let value = line.slice(prefix.length);
  // Per SSE parsing rules, remove at most one leading space after ":".
  if (value.startsWith(' ')) value = value.slice(1);
  return value;
}
