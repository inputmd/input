import './env';
import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import { pathToFileURL, URL } from 'node:url';
import {
  buildCodexBridgeDeveloperInstructions,
  buildCodexBridgeInput,
  parseCodexBridgeStructuredOutput,
} from './codex_bridge_prompts.ts';
import { CodexBridgeClient } from './codex_bridge_protocol.ts';
import { ClientError } from './errors.ts';
import { json, readJson } from './http_helpers.ts';
import { generateUnifiedDiff } from './reader_ai_tools.ts';

const DEFAULT_CODEX_BRIDGE_PORT = Number.parseInt(process.env.CODEX_BRIDGE_PORT ?? '8788', 10);
const DEFAULT_CODEX_APP_SERVER_URL = (process.env.CODEX_APP_SERVER_URL ?? 'ws://127.0.0.1:8765').trim();
const CODEX_BRIDGE_START_APP_SERVER_RAW = process.env.CODEX_BRIDGE_START_APP_SERVER?.trim() ?? '';
const DEFAULT_CODEX_BRIDGE_ALLOWED_ORIGINS = new Set([
  'https://input.md',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  ...(process.env.CODEX_BRIDGE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
]);

const STAGED_CHANGES_START_TAG = '<input-staged-changes>';

interface ReaderAiChatBody {
  model?: unknown;
  source?: unknown;
  messages?: unknown;
  mode?: unknown;
  summary?: unknown;
  current_doc_path?: unknown;
  edit_mode_current_doc_only?: unknown;
  allow_document_edits?: unknown;
}

interface CreateCodexBridgeServerOptions {
  port?: number;
  codexAppServerUrl?: string;
  startCodexAppServer?: boolean;
  allowedOrigins?: Iterable<string>;
}

function applyBridgeCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): void {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function writeSseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
}

function writeSse(res: http.ServerResponse, data: unknown, event?: string): void {
  if (event) res.write(`event: ${event}\n`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of payload.split('\n')) res.write(`data: ${line}\n`);
  res.write('\n');
}

function writeDelta(res: http.ServerResponse, delta: string): void {
  writeSse(res, {
    choices: [
      {
        delta: {
          content: delta,
        },
      },
    ],
  });
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function trailingMarkerPrefixLength(text: string, marker: string): number {
  const maxLen = Math.min(text.length, marker.length - 1);
  for (let len = maxLen; len > 0; len -= 1) {
    if (text.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

function parseMessages(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(raw)) throw new ClientError('messages must be an array', 400);
  return raw
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const role = (message as { role?: unknown }).role;
      const content = (message as { content?: unknown }).content;
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null;
      return { role, content };
    })
    .filter((message): message is { role: 'user' | 'assistant'; content: string } => message !== null);
}

function lookupOriginalFile(path: string, source: string, currentDocPath: string | null): string | null {
  const fallbackPath = currentDocPath || 'current-document.md';
  if (path === fallbackPath || (!currentDocPath && path === 'current-document.md')) return source;
  return null;
}

function codexAppServerHealthUrl(appServerUrl: string): string {
  const url = new URL(appServerUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}/readyz`;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function isCodexAppServerReady(appServerUrl: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(codexAppServerHealthUrl(appServerUrl), 750);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCodexAppServerReady(appServerUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCodexAppServerReady(appServerUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for Codex app-server at ${appServerUrl}`);
}

function shouldAutoStartCodexAppServer(options: CreateCodexBridgeServerOptions): boolean {
  if (options.startCodexAppServer !== undefined) return options.startCodexAppServer;
  if (CODEX_BRIDGE_START_APP_SERVER_RAW === '0') return false;
  if (CODEX_BRIDGE_START_APP_SERVER_RAW === '1' || CODEX_BRIDGE_START_APP_SERVER_RAW.toLowerCase() === 'true') {
    return true;
  }
  if (process.env.CODEX_APP_SERVER_URL?.trim()) return false;
  return !options.codexAppServerUrl;
}

async function ensureCodexAppServer(
  appServerUrl: string,
  options: CreateCodexBridgeServerOptions,
): Promise<ChildProcess | null> {
  if (await isCodexAppServerReady(appServerUrl)) return null;
  if (!shouldAutoStartCodexAppServer(options)) return null;

  const child = spawn('codex', ['app-server', '--listen', appServerUrl], {
    stdio: 'inherit',
  });

  try {
    await waitForCodexAppServerReady(appServerUrl);
    return child;
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

export async function createCodexBridgeServer(options: CreateCodexBridgeServerOptions = {}): Promise<{
  server: http.Server;
  closeManagedResources: () => void;
}> {
  const appServerUrl = options.codexAppServerUrl ?? DEFAULT_CODEX_APP_SERVER_URL;
  const managedCodexAppServer = await ensureCodexAppServer(appServerUrl, options);
  const codex = new CodexBridgeClient(appServerUrl);
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_CODEX_BRIDGE_ALLOWED_ORIGINS);

  const handleModels = async (_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const models = await codex.listModels();
    json(res, 200, {
      models: models
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.model,
          name: model.displayName,
          context_length: 0,
          featured: model.isDefault,
          provider: 'codex_local',
        })),
    });
  };

  const handleChat = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = (await readJson(req)) as ReaderAiChatBody | null;
    const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const source = typeof body?.source === 'string' ? body.source : '';
    const messages = parseMessages(body?.messages);
    const mode = body?.mode === 'prompt_list' ? 'prompt_list' : 'default';
    const summary = typeof body?.summary === 'string' ? body.summary : undefined;
    const currentDocPath =
      typeof body?.current_doc_path === 'string' && body.current_doc_path ? body.current_doc_path : null;
    const editModeCurrentDocOnly = body?.edit_mode_current_doc_only === true;
    const allowDocumentEdits = body?.allow_document_edits !== false;

    writeSseHeaders(res);
    writeSse(res, { iteration: 1 }, 'turn_start');

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
      const developerInstructions = buildCodexBridgeDeveloperInstructions({
        source,
        messages,
        mode,
        summary,
        currentDocPath,
        editModeCurrentDocOnly,
        allowDocumentEdits,
      });
      const input = buildCodexBridgeInput({
        source,
        messages,
        mode,
        summary,
        currentDocPath,
        editModeCurrentDocOnly,
      });

      if (editModeCurrentDocOnly) {
        await codex.runTurn({
          model,
          developerInstructions,
          input,
          webSearch: mode === 'prompt_list' ? 'live' : 'disabled',
          signal: abortController.signal,
          onDelta: (delta) => writeDelta(res, delta),
        });
        writeSse(res, { iteration: 1, reason: 'completed' }, 'turn_end');
        writeSse(res, '[DONE]');
        res.end();
        return;
      }

      let incrementalRaw = '';
      let streamedVisibleChars = 0;
      let streamedVisibleText = '';
      const result = await codex.runTurn({
        model,
        developerInstructions,
        input,
        webSearch: mode === 'prompt_list' ? 'live' : 'disabled',
        signal: abortController.signal,
        onDelta: (delta) => {
          incrementalRaw += delta;
          const markerIndex = incrementalRaw.indexOf(STAGED_CHANGES_START_TAG);
          if (markerIndex >= 0) {
            if (markerIndex > streamedVisibleChars) {
              const safe = incrementalRaw.slice(streamedVisibleChars, markerIndex);
              if (safe) {
                streamedVisibleChars = markerIndex;
                streamedVisibleText += safe;
                writeDelta(res, safe);
              }
            }
            return;
          }

          const safeEnd = Math.max(
            streamedVisibleChars,
            incrementalRaw.length - trailingMarkerPrefixLength(incrementalRaw, STAGED_CHANGES_START_TAG),
          );
          if (safeEnd <= streamedVisibleChars) return;
          const safe = incrementalRaw.slice(streamedVisibleChars, safeEnd);
          if (!safe) return;
          streamedVisibleChars = safeEnd;
          streamedVisibleText += safe;
          writeDelta(res, safe);
        },
      });

      const structured = parseCodexBridgeStructuredOutput(result.outputText);
      const assistantMessage = structured?.assistantMessage ?? result.outputText.trim();

      if (structured && allowDocumentEdits) {
        const changes = structured.changes.map((change) => {
          const original =
            lookupOriginalFile(change.path, source, currentDocPath) ?? (change.type === 'create' ? '' : null);
          if (change.type !== 'delete' && original === null) {
            throw new ClientError(`Model proposed changes for unknown path: ${change.path}`, 400);
          }
          const diff =
            change.type === 'delete'
              ? generateUnifiedDiff(change.path, original ?? '', '')
              : generateUnifiedDiff(change.path, original ?? '', change.content ?? '');
          return {
            path: change.path,
            type: change.type,
            diff,
          };
        });

        const fileContents = Object.fromEntries(
          structured.changes
            .filter((change) => change.type !== 'delete' && typeof change.content === 'string')
            .map((change) => [change.path, change.content as string]),
        );

        writeSse(
          res,
          {
            changes,
            file_contents: fileContents,
            suggested_commit_message: structured.suggestedCommitMessage,
            document_content:
              structured.changes.length === 1 &&
              structured.changes[0].type !== 'delete' &&
              structured.changes[0].path === (currentDocPath || 'current-document.md')
                ? structured.changes[0].content
                : undefined,
          },
          'staged_changes',
        );
      }

      if (!structured && result.outputText.length > streamedVisibleChars) {
        const remainder = result.outputText.slice(streamedVisibleChars);
        if (remainder) {
          streamedVisibleChars = result.outputText.length;
          streamedVisibleText += remainder;
          writeDelta(res, remainder);
        }
      }

      if (assistantMessage) {
        const prefix = commonPrefixLength(streamedVisibleText, assistantMessage);
        const remainder = assistantMessage.slice(prefix);
        if (remainder) writeDelta(res, remainder);
      }
      writeSse(res, { iteration: 1, reason: 'completed' }, 'turn_end');
      writeSse(res, '[DONE]');
      res.end();
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Request cancelled'
          : error instanceof Error
            ? error.message
            : 'Codex bridge request failed';
      writeSse(res, { message }, 'error');
      writeSse(res, { iteration: 1, reason: 'error' }, 'turn_end');
      writeSse(res, '[DONE]');
      res.end();
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      applyBridgeCors(req, res, allowedOrigins);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/api/ai/health') {
        json(res, 200, { ok: true, app_server_url: options.codexAppServerUrl ?? DEFAULT_CODEX_APP_SERVER_URL });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/ai/models') {
        await handleModels(req, res);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/ai/chat') {
        await handleChat(req, res);
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof ClientError) {
        json(res, error.statusCode, { error: error.message });
        return;
      }
      console.error('Unhandled Codex bridge error:', error);
      json(res, 500, { error: 'Internal server error' });
    }
  });

  return {
    server,
    closeManagedResources: () => {
      managedCodexAppServer?.kill('SIGTERM');
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const managed = await createCodexBridgeServer();
  managed.server.listen(DEFAULT_CODEX_BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`Codex bridge listening on http://127.0.0.1:${DEFAULT_CODEX_BRIDGE_PORT}`);
    console.log(`[codex-bridge] app-server=${DEFAULT_CODEX_APP_SERVER_URL}`);
  });

  const shutdown = () => {
    managed.closeManagedResources();
    managed.server.close();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
