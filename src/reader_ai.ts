import { responseToApiError } from './api_error';

export interface ReaderAiModel {
  id: string;
  name: string;
  context_length: number;
  featured?: boolean;
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

interface ReaderAiStreamOptions {
  onDelta: (delta: string) => void;
  onSummary?: (summary: string) => void;
  onToolCall?: (event: ReaderAiToolCallEvent) => void;
  onToolResult?: (event: ReaderAiToolResultEvent) => void;
  onTaskProgress?: (event: ReaderAiTaskProgressEvent) => void;
  onStagedChanges?: (
    changes: ReaderAiStagedChange[],
    suggestedCommitMessage?: string,
    documentContent?: string,
    fileContents?: Record<string, string>,
  ) => void;
  onStreamError?: (message: string) => void;
  onTurnStart?: (iteration: number) => void;
  onTurnEnd?: (iteration: number, reason: string) => void;
  signal?: AbortSignal;
}

/** Returns 0 for featured models, -1 for non-featured. */
export function readerAiModelPriorityRank(model: ReaderAiModel): number {
  return model.featured ? 0 : -1;
}

export async function listReaderAiModels(): Promise<ReaderAiModel[]> {
  const res = await fetch('/api/ai/models', { credentials: 'same-origin' });
  if (!res.ok) throw await responseToApiError(res);
  const data = (await res.json()) as ReaderAiModelsResponse;
  return Array.isArray(data.models) ? data.models : [];
}

function extractStreamDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choice = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || choice.length === 0) return '';
  const first = choice[0] as { delta?: unknown; message?: unknown };
  if (first?.delta && typeof first.delta === 'object') {
    const content = (first.delta as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  if (first?.message && typeof first.message === 'object') {
    const content = (first.message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
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

export async function createReaderAiProjectSession(files: ReaderAiProjectFile[]): Promise<ReaderAiProjectSession> {
  const res = await fetch('/api/ai/project', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw await responseToApiError(res);
  const data = (await res.json()) as { project_id?: string; file_count?: number };
  if (!data.project_id) throw new Error('Missing project_id in response');
  return { projectId: data.project_id, fileCount: data.file_count ?? files.length };
}

export async function resetReaderAiProjectSession(projectId: string): Promise<void> {
  try {
    await fetch(`/api/ai/project/${encodeURIComponent(projectId)}/reset`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    // Best-effort — ignore errors.
  }
}

export async function updateReaderAiProjectSessionFile(
  projectId: string,
  path: string,
  content: string,
): Promise<void> {
  const res = await fetch(`/api/ai/project/${encodeURIComponent(projectId)}/file`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) throw await responseToApiError(res);
}

export async function deleteReaderAiProjectSession(projectId: string): Promise<void> {
  try {
    await fetch(`/api/ai/project/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
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
  // Resolve current_doc_path: projectContext takes precedence when present
  const resolvedDocPath = projectContext?.currentDocPath ?? currentDocPath ?? null;
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model,
      source,
      messages,
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
        if (options.onStreamError) {
          try {
            const parsed = JSON.parse(data) as { message?: string };
            if (typeof parsed.message === 'string') options.onStreamError(parsed.message);
          } catch {
            // Ignore malformed error event.
          }
        }
      } else {
        try {
          const parsed = JSON.parse(data) as unknown;
          const delta = extractStreamDelta(parsed);
          if (delta) options.onDelta(delta);
        } catch {
          // Ignore malformed stream chunks and continue.
        }
      }

      boundary = buffer.indexOf('\n\n');
    }
  }
}

function parseSseFieldValue(line: string, prefix: 'event:' | 'data:'): string {
  let value = line.slice(prefix.length);
  // Per SSE parsing rules, remove at most one leading space after ":".
  if (value.startsWith(' ')) value = value.slice(1);
  return value;
}
