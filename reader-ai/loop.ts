// ── Core Agentic Tool-Calling Loop ──

import {
  buildReaderAiPromptListSystemPrompt,
  buildReaderAiSystemPrompt,
  READER_AI_DOC_PREVIEW_CHARS,
} from './prompts.ts';
import { parseUpstreamStream } from './stream.ts';
import { executeSubagent } from './subagent.ts';
import { READER_AI_CONTEXT_WINDOW_MESSAGES, READER_AI_MAX_SUMMARY_CHARS, summarizeConversation } from './summarize.ts';
import {
  compactToolResults,
  estimateMessagesTokens,
  executeReaderAiEditDocumentTool,
  executeReaderAiSyncTool,
  parseToolArgumentsWithRepair,
  parseUnifiedDiffHunks,
  READER_AI_MAX_CONCURRENT_TASKS,
  READER_AI_TOOLS,
} from './tools.ts';
import type {
  DocumentEditState,
  OpenRouterMessage,
  ReaderAiChatOptions,
  ReaderAiEvent,
  ReaderAiMessage,
  ReaderAiSessionConfig,
  ReaderAiStagedChangeSnapshot,
  ToolCall,
} from './types.ts';
import { callUpstream, isFreeTierModel, readUpstreamError, readUpstreamRateLimitMessage } from './upstream.ts';

const DEFAULT_TOTAL_TIMEOUT_MS = 360_000;
const DEFAULT_PER_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_CONTEXT_TOKENS = 32_000;

// ── Async event queue for real-time streaming ──
// Allows the parseUpstreamStream callback to push events that the generator
// can yield immediately, preserving token-by-token streaming behavior.

interface AsyncEventQueue<T> {
  push: (event: T) => void;
  finish: () => void;
  error: (err: unknown) => void;
  [Symbol.asyncIterator]: () => AsyncIterator<T>;
}

function createEventQueue<T>(): AsyncEventQueue<T> {
  const pending: T[] = [];
  let resolve: (() => void) | null = null;
  let done = false;
  let queueError: unknown = null;

  return {
    push(event: T) {
      pending.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    },
    finish() {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    },
    error(err: unknown) {
      queueError = err;
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          while (true) {
            if (pending.length > 0) {
              return { value: pending.shift()!, done: false };
            }
            if (queueError) throw queueError;
            if (done) return { value: undefined as unknown as T, done: true };
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
        },
      };
    },
  };
}

export async function* runReaderAiLoop(
  config: ReaderAiSessionConfig,
  messages: ReaderAiMessage[],
  options: ReaderAiChatOptions = {},
): AsyncGenerator<ReaderAiEvent> {
  const totalTimeoutMs = config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const perCallTimeoutMs = config.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const mode = config.mode ?? 'default';
  const allowEdits = config.allowEdits ?? true;
  const allowSubagents = config.allowSubagents ?? true;
  const editModeCurrentDocOnly = config.editModeCurrentDocOnly ?? false;
  const contextTokens = config.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const provider = config.provider;

  // -- Strip CriticMarkup if a stripping function is provided (#4) --
  const rawSource = config.stripCriticMarkup
    ? config.stripCriticMarkup(config.document.content)
    : config.document.content;
  const source = rawSource.trim();
  const currentDocPath = config.document.path ?? null;
  const aiLines = source.split('\n');

  // -- Conversation management / summarization --
  const allMessages = messages;
  const existingSummary = options.summary?.trim().slice(0, READER_AI_MAX_SUMMARY_CHARS) ?? '';

  let chatMessages: ReaderAiMessage[];
  let newSummary: string | null = null;
  let summarizationFailed = false;

  if (mode === 'prompt_list') {
    chatMessages = allMessages;
  } else if (allMessages.length <= READER_AI_CONTEXT_WINDOW_MESSAGES) {
    if (existingSummary) {
      chatMessages = [
        { role: 'user', content: `[Summary of earlier conversation]\n${existingSummary}` },
        { role: 'assistant', content: 'Understood, I have the context from our earlier conversation.' },
        ...allMessages,
      ];
    } else {
      chatMessages = allMessages;
    }
  } else {
    const evicted = allMessages.slice(0, -READER_AI_CONTEXT_WINDOW_MESSAGES);
    const kept = allMessages.slice(-READER_AI_CONTEXT_WINDOW_MESSAGES);
    try {
      newSummary = await summarizeConversation(provider, evicted, existingSummary, options.signal);
    } catch {
      newSummary = existingSummary || null;
      if (!existingSummary) summarizationFailed = true;
    }
    const summaryText = newSummary || existingSummary;
    if (summaryText) {
      chatMessages = [
        { role: 'user', content: `[Summary of earlier conversation]\n${summaryText}` },
        { role: 'assistant', content: 'Understood, I have the context from our earlier conversation.' },
        ...kept,
      ];
    } else {
      chatMessages = kept;
    }
  }

  if (newSummary) {
    yield { type: 'summary', summary: newSummary };
  }

  // -- Issue #7: Emit summarization failure warning --
  if (summarizationFailed) {
    yield { type: 'error', message: 'Earlier conversation context could not be summarized and may be lost.' };
  }

  // -- Document edit state --
  const documentEditState: DocumentEditState = {
    source: rawSource,
    lines: rawSource.split('\n'),
    currentDocPath,
    stagedContent: null,
    stagedDiff: null,
    stagedRevision: 0,
  };

  // -- Build system prompt and tool set --
  let systemPrompt: string;
  let tools: Array<(typeof READER_AI_TOOLS)[number]>;
  if (mode === 'prompt_list') {
    systemPrompt = buildReaderAiPromptListSystemPrompt();
    tools = [];
  } else {
    const maxPreviewChars =
      contextTokens > 0
        ? Math.min(READER_AI_DOC_PREVIEW_CHARS, Math.floor(contextTokens * 3 * 0.25))
        : READER_AI_DOC_PREVIEW_CHARS;
    systemPrompt = buildReaderAiSystemPrompt(source, aiLines, maxPreviewChars, currentDocPath, allowEdits);

    // -- Issue #2/#3: Tool filtering matches original whitelist/blacklist logic --
    if (!allowEdits) {
      // Read-only mode: whitelist only read + search + task
      tools = READER_AI_TOOLS.filter((tool) => {
        const name = tool.function.name;
        return name === 'read_document' || name === 'search_document' || name === 'task';
      });
    } else if (editModeCurrentDocOnly) {
      // Edit-only mode: read + search + edit (no subagents)
      tools = READER_AI_TOOLS.filter((tool) => {
        const name = tool.function.name;
        return name === 'read_document' || name === 'search_document' || name === 'propose_edit_document';
      });
    } else {
      // Full mode: filter based on individual flags
      tools = READER_AI_TOOLS.filter((tool) => {
        const name = tool.function.name;
        if (!allowSubagents && name === 'task') return false;
        return true;
      });
    }
  }

  // -- Build messages for upstream --
  const openRouterMessages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    ...chatMessages.map((m): OpenRouterMessage => ({ role: m.role, content: m.content })),
  ];

  const requestStart = Date.now();
  const externalSignal = options.signal;
  const abortController = new AbortController();

  // Link external signal to our controller
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortController.abort();
    } else {
      externalSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
  }

  const remainingMs = () => Math.max(0, totalTimeoutMs - (Date.now() - requestStart));
  const callTimeout = () => Math.min(perCallTimeoutMs, remainingMs());

  // -- Issue #5: Use contextTokens from config for budget management --
  const maxContextTokens = contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS;
  const conversationBudgetTokens = Math.floor(maxContextTokens * 0.6);

  const executeSyncToolCall = (tc: ToolCall, argsJsonOverride?: string): string => {
    const toolArgsJson = argsJsonOverride ?? tc.arguments;
    if (tc.name === 'propose_edit_document') return executeReaderAiEditDocumentTool(toolArgsJson, documentEditState);
    return executeReaderAiSyncTool(tc.name, toolArgsJson, aiLines);
  };

  // -- Staged changes tracking --
  let stagedChangesRevision = 0;
  let lastStagedChangesSignature: string | null = null;

  const serializeChange = (change: {
    id: string;
    path: string;
    type: 'edit' | 'create' | 'delete';
    diff: string;
    revision?: number;
    original: string | null;
    modified: string | null;
  }): ReaderAiStagedChangeSnapshot => ({
    id: change.id,
    path: change.path,
    type: change.type,
    diff: change.diff,
    revision: change.revision,
    originalContent: change.original,
    modifiedContent: change.modified,
    hunks: parseUnifiedDiffHunks(change.diff),
  });

  const getCurrentDocumentStagedChange = () =>
    documentEditState.stagedContent && documentEditState.stagedDiff
      ? {
          id: `change:${currentDocPath || 'current-document.md'}`,
          path: currentDocPath || 'current-document.md',
          type: 'edit' as const,
          original: source,
          modified: documentEditState.stagedContent,
          diff: documentEditState.stagedDiff,
          revision: documentEditState.stagedRevision,
        }
      : null;

  function* emitEditProposal(toolCallId: string): Generator<ReaderAiEvent> {
    const change = getCurrentDocumentStagedChange();
    if (!change) return;
    yield {
      type: 'edit_proposal',
      proposalId: `proposal:${stagedChangesRevision}:${toolCallId}`,
      toolCallId,
      revision: stagedChangesRevision,
      change: serializeChange(change),
    };
  }

  function* emitStagedChangesSnapshot(): Generator<ReaderAiEvent> {
    const hasDocumentStagedChange = Boolean(documentEditState.stagedContent && documentEditState.stagedDiff);
    const allChanges = hasDocumentStagedChange ? [getCurrentDocumentStagedChange()!] : [];
    const changes = allChanges.map((change) => serializeChange({ ...change, revision: stagedChangesRevision }));
    const fileContents = Object.fromEntries(
      allChanges.filter((c) => typeof c.modified === 'string').map((c) => [c.path, c.modified as string]),
    );
    const suggestedCommitMessage =
      allChanges.length === 1 ? `Update ${allChanges[0].path}` : 'Apply AI-suggested changes';
    const payload = {
      changes,
      fileContents,
      suggestedCommitMessage,
      ...(documentEditState.stagedContent ? { documentContent: documentEditState.stagedContent } : {}),
    };
    const signature = JSON.stringify(payload);
    if (signature === lastStagedChangesSignature) return;
    lastStagedChangesSignature = signature;
    yield {
      type: 'staged_changes',
      ...payload,
    };
  }

  // -- First upstream call --
  let firstUpstream: Response;
  try {
    firstUpstream = await callUpstream(
      provider,
      openRouterMessages,
      tools,
      AbortSignal.any([AbortSignal.timeout(callTimeout()), abortController.signal]),
    );
  } catch (err) {
    // -- Issue #6: Handle DOMException for first call --
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      yield { type: 'error', message: 'Request timed out' };
      return;
    }
    throw err;
  }

  if (!firstUpstream.ok) {
    const rateLimitMsg = readUpstreamRateLimitMessage(firstUpstream.headers);
    if (rateLimitMsg) {
      yield { type: 'error', message: rateLimitMsg };
      return;
    }
    const payload = (await firstUpstream.json().catch(() => null)) as unknown;
    const upstreamError = readUpstreamError(payload);
    yield { type: 'error', message: upstreamError || `Upstream request failed (${firstUpstream.status})` };
    return;
  }
  if (!firstUpstream.body) {
    yield { type: 'error', message: 'Upstream did not return a stream' };
    return;
  }

  // -- Agentic tool-call loop --
  let currentBody: ReadableStream<Uint8Array> | null = firstUpstream.body;

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      yield { type: 'turn_start', iteration };

      // -- Issue #1: Use async event queue for real-time token streaming --
      // The queue allows parseUpstreamStream's callback to push text deltas
      // that we yield immediately, preserving token-by-token streaming.
      const queue = createEventQueue<ReaderAiEvent>();
      let streamResult: Awaited<ReturnType<typeof parseUpstreamStream>> | null = null;
      let streamError: unknown = null;

      const streamPromise = parseUpstreamStream(
        currentBody!,
        (delta) => {
          queue.push({ type: 'text_delta', delta });
        },
        { repairBoundaries: isFreeTierModel(provider.model) },
      )
        .then((result) => {
          streamResult = result;
          queue.finish();
        })
        .catch((err) => {
          streamError = err;
          queue.error(err);
        });

      // Yield text deltas in real-time as they arrive from the stream
      try {
        for await (const event of queue) {
          yield event;
        }
      } catch {
        // Stream error will be handled below
      }

      await streamPromise;
      currentBody = null;

      if (streamError) {
        // -- Issue #6: Handle stream parse errors gracefully --
        if (
          streamError instanceof DOMException &&
          ((streamError as DOMException).name === 'TimeoutError' || (streamError as DOMException).name === 'AbortError')
        ) {
          yield { type: 'error', message: 'Request timed out' };
          yield* emitStagedChangesSnapshot();
          return;
        }
        const message = streamError instanceof Error ? streamError.message : 'Stream parsing failed';
        yield { type: 'error', message };
        yield* emitStagedChangesSnapshot();
        return;
      }

      const result = streamResult!;

      if (result.toolCalls.length === 0) {
        yield { type: 'turn_end', iteration, reason: 'done' };
        break;
      }

      // Add assistant message with tool calls
      openRouterMessages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Separate task calls from sync calls
      const taskCalls: Array<{ tc: ToolCall; parsedArgs: Record<string, unknown> }> = [];
      const syncCalls: Array<{
        tc: ToolCall;
        parsedArgs: Record<string, unknown> | undefined;
        parseError?: string;
        repaired?: boolean;
      }> = [];

      for (const tc of result.toolCalls) {
        const parsedArgsResult = parseToolArgumentsWithRepair(tc.arguments);
        const parsedArgs = parsedArgsResult.parsedArgs;

        yield {
          type: 'tool_call',
          id: tc.id,
          name: tc.name,
          arguments: parsedArgs ?? tc.arguments,
          parseError: parsedArgsResult.error,
          repaired: parsedArgsResult.repaired || undefined,
        };

        if (tc.name === 'task') {
          if (parsedArgs) {
            taskCalls.push({ tc, parsedArgs });
          } else {
            const retryMessage =
              'Arguments could not be parsed as JSON. Retry the task call with a valid JSON object that includes a "prompt" field.';
            openRouterMessages.push({ role: 'tool', tool_call_id: tc.id, content: retryMessage });
            yield {
              type: 'tool_result',
              id: tc.id,
              name: 'task',
              preview: '(invalid JSON arguments)',
              error: parsedArgsResult.error ?? 'Invalid JSON arguments',
            };
          }
        } else {
          syncCalls.push({
            tc,
            parsedArgs,
            parseError: parsedArgsResult.error ?? undefined,
            repaired: parsedArgsResult.repaired || undefined,
          });
        }
      }

      // Run sync tools
      for (const { tc, parsedArgs, parseError, repaired } of syncCalls) {
        if (!parsedArgs && parseError) {
          const retryMessage = `Tool arguments could not be parsed as JSON. Retry ${tc.name} with valid JSON arguments.`;
          openRouterMessages.push({ role: 'tool', tool_call_id: tc.id, content: retryMessage });
          yield {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            preview: '(invalid JSON arguments)',
            error: parseError,
            repaired,
          };
          continue;
        }

        const toolResult = executeSyncToolCall(tc, repaired && parsedArgs ? JSON.stringify(parsedArgs) : undefined);
        openRouterMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });

        const resultPreview = toolResult.length > 200 ? `${toolResult.slice(0, 200)}...` : toolResult;
        const toolFailed =
          /^\((invalid JSON|unknown tool|file not found|old_text not found|path is required|content is required|new_text is required|old_text is required)/.test(
            toolResult,
          );
        yield {
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          preview: resultPreview,
          ...(toolFailed ? { error: toolResult } : {}),
          ...(repaired ? { repaired: true } : {}),
        };

        if (tc.name === 'propose_edit_document') {
          stagedChangesRevision += 1;
          yield* emitEditProposal(tc.id);
          yield* emitStagedChangesSnapshot();
        }
      }

      // Run task calls in parallel
      if (taskCalls.length > 0) {
        const batches: Array<typeof taskCalls> = [];
        for (let i = 0; i < taskCalls.length; i += READER_AI_MAX_CONCURRENT_TASKS) {
          batches.push(taskCalls.slice(i, i + READER_AI_MAX_CONCURRENT_TASKS));
        }
        for (const batch of batches) {
          const taskPromises = batch.map(async ({ tc, parsedArgs }) => {
            const taskPrompt = typeof parsedArgs.prompt === 'string' ? parsedArgs.prompt : '';
            const taskSystemPrompt =
              typeof parsedArgs.system_prompt === 'string' ? parsedArgs.system_prompt : undefined;

            if (!taskPrompt) {
              return { id: tc.id, result: '(task tool requires a "prompt" argument)', progressEvents: [] };
            }

            const progressEvents: ReaderAiEvent[] = [];
            try {
              const taskResult = await executeSubagent({
                config: provider,
                prompt: taskPrompt,
                systemPrompt: taskSystemPrompt,
                lines: aiLines,
                source,
                signal: abortController.signal,
                onProgress: (event) => {
                  progressEvents.push({
                    type: 'task_progress',
                    id: tc.id,
                    phase: event.phase,
                    iteration: event.iteration,
                    detail: event.detail,
                  });
                },
              });
              return { id: tc.id, result: taskResult, progressEvents };
            } catch (taskErr) {
              const message =
                taskErr instanceof DOMException && (taskErr.name === 'TimeoutError' || taskErr.name === 'AbortError')
                  ? 'Subagent timed out'
                  : taskErr instanceof Error
                    ? taskErr.message
                    : 'Subagent failed';
              progressEvents.push({
                type: 'task_progress',
                id: tc.id,
                phase: 'error',
                detail: message,
              });
              return { id: tc.id, result: `[Subagent error: ${message}]`, progressEvents };
            }
          });

          const taskResults = await Promise.all(taskPromises);
          for (const { id, result: taskResult, progressEvents } of taskResults) {
            for (const event of progressEvents) {
              yield event;
            }
            openRouterMessages.push({ role: 'tool', tool_call_id: id, content: taskResult });
            const resultPreview = taskResult.length > 200 ? `${taskResult.slice(0, 200)}...` : taskResult;
            yield { type: 'tool_result', id, name: 'task', preview: resultPreview };
          }
        }
      }

      // Check context budget
      const currentTokens = estimateMessagesTokens(openRouterMessages);
      if (currentTokens > conversationBudgetTokens) {
        const reclaimed = compactToolResults(openRouterMessages, 4);
        if (reclaimed > 0) {
          const afterCompaction = estimateMessagesTokens(openRouterMessages);
          if (afterCompaction > conversationBudgetTokens) {
            yield { type: 'turn_end', iteration, reason: 'context_budget' };
            break;
          }
        } else {
          yield { type: 'turn_end', iteration, reason: 'context_budget' };
          break;
        }
      }

      // Check remaining time
      if (remainingMs() <= 0) {
        yield { type: 'error', message: 'Request timed out during tool execution' };
        yield { type: 'turn_end', iteration, reason: 'timeout' };
        break;
      }

      yield { type: 'turn_end', iteration, reason: 'tool_calls' };

      // Make next upstream call
      let nextUpstream: Response;
      try {
        nextUpstream = await callUpstream(
          provider,
          openRouterMessages,
          tools,
          AbortSignal.any([AbortSignal.timeout(callTimeout()), abortController.signal]),
        );
      } catch (err) {
        // -- Issue #6: Handle DOMException for subsequent calls --
        if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          yield { type: 'error', message: 'Request timed out' };
          yield* emitStagedChangesSnapshot();
          break;
        }
        throw err;
      }
      if (!nextUpstream.ok || !nextUpstream.body) {
        const rateLimitMsg = readUpstreamRateLimitMessage(nextUpstream.headers);
        const status = nextUpstream.status ?? 0;
        const payload = rateLimitMsg ? null : ((await nextUpstream.json().catch(() => null)) as unknown);
        const detail = rateLimitMsg || readUpstreamError(payload) || `Model returned an error (${status})`;
        yield { type: 'error', message: detail };
        break;
      }
      currentBody = nextUpstream.body;
    }
  } catch (err) {
    // -- Issue #6: Top-level DOMException handling --
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      yield { type: 'error', message: 'Request timed out' };
      yield* emitStagedChangesSnapshot();
      return;
    }
    throw err;
  } finally {
    if (currentBody) await currentBody.cancel().catch(() => {});
  }

  // Emit final staged changes snapshot
  yield* emitStagedChangesSnapshot();
}
