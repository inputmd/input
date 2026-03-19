import WebSocket from 'ws';

type JsonRpcId = number | string;

interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface CodexModelSummary {
  id: string;
  displayName: string;
  model: string;
  isDefault: boolean;
  hidden: boolean;
}

export interface CodexBridgeTurnOptions {
  model?: string | null;
  developerInstructions: string;
  input: string;
  webSearch?: 'disabled' | 'live';
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface CodexBridgeTurnResult {
  outputText: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readResponseError(response: JsonRpcResponse): Error | null {
  if (!response.error) return null;
  const message = typeof response.error.message === 'string' ? response.error.message : 'Codex app-server error';
  return new Error(message);
}

function defaultServerRequestResult(method: string): unknown {
  if (
    method === 'execCommand/approval' ||
    method === 'applyPatch/approval' ||
    method === 'fileChangeRequest/approval'
  ) {
    return { decision: 'denied' };
  }
  if (method === 'commandExecutionRequest/approval') {
    return { decision: 'decline' };
  }
  if (method === 'permissions/request') {
    return { permissions: {} };
  }
  if (method === 'dynamicToolCall') {
    return { success: false, contentItems: [] };
  }
  if (method === 'tool/requestUserInput' || method === 'mcpServer/elicit') {
    return { canceled: true };
  }
  return null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

export class CodexBridgeClient {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async listModels(signal?: AbortSignal): Promise<CodexModelSummary[]> {
    return this.withSession(signal, async (session) => {
      await session.initialize();
      const result = (await session.request('model/list', {})) as {
        data?: Array<{
          id?: unknown;
          displayName?: unknown;
          model?: unknown;
          isDefault?: unknown;
          hidden?: unknown;
        }>;
      } | null;

      if (!Array.isArray(result?.data)) return [];
      return result.data
        .map((entry) => ({
          id: typeof entry.id === 'string' ? entry.id : '',
          displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          isDefault: entry.isDefault === true,
          hidden: entry.hidden === true,
        }))
        .filter((entry) => entry.model && entry.displayName);
    });
  }

  async runTurn(options: CodexBridgeTurnOptions): Promise<CodexBridgeTurnResult> {
    return this.withSession(options.signal, async (session) => {
      await session.initialize();
      const thread = (await session.request('thread/start', {
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        personality: 'pragmatic',
        ...(options.model ? { model: options.model } : {}),
        ...(options.webSearch ? { config: { web_search: options.webSearch } } : {}),
        developerInstructions: options.developerInstructions,
      })) as { thread?: { id?: unknown } };
      const threadId = typeof thread?.thread?.id === 'string' ? thread.thread.id : '';
      if (!threadId) throw new Error('Codex app-server did not return a thread id');

      let output = '';
      let settled = false;

      const completion = new Promise<CodexBridgeTurnResult>((resolve, reject) => {
        const cleanupAbort = session.bindAbort(options.signal, () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });

        session.onNotification = (message) => {
          if (message.method === 'item/agentMessage/delta') {
            const params = isObject(message.params) ? message.params : {};
            const delta = typeof params.delta === 'string' ? params.delta : '';
            if (!delta) return;
            output += delta;
            options.onDelta?.(delta);
            return;
          }

          if (message.method === 'error') {
            const params = isObject(message.params) ? message.params : {};
            const error = isObject(params.error) ? params.error : {};
            const messageText = typeof error.message === 'string' ? error.message : 'Codex app-server turn failed';
            settled = true;
            cleanupAbort();
            reject(new Error(messageText));
            return;
          }

          if (message.method === 'turn/completed') {
            settled = true;
            cleanupAbort();
            resolve({ outputText: output });
          }
        };
      });

      await session.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: options.input }],
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: options.webSearch === 'live',
          access: {
            type: 'restricted',
            includePlatformDefaults: false,
            readableRoots: [],
          },
        },
        approvalPolicy: 'never',
        ...(options.model ? { model: options.model } : {}),
      });

      try {
        return await completion;
      } finally {
        if (!settled && !session.closed) {
          session.close();
        }
      }
    });
  }

  private async withSession<T>(
    signal: AbortSignal | undefined,
    fn: (session: CodexRpcSession) => Promise<T>,
  ): Promise<T> {
    const session = new CodexRpcSession(this.url);
    try {
      await session.connect(signal);
      return await fn(session);
    } finally {
      session.close();
    }
  }
}

class CodexRpcSession {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  public onNotification: ((message: JsonRpcNotification) => void) | null = null;
  public closed = false;

  constructor(url: string) {
    this.url = url;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.ws) return;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onAbort = () => {
        ws.close();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      ws.once('open', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });

      ws.once('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Failed to connect to Codex app-server'));
      });

      ws.on('message', (buf) => this.handleMessage(String(buf)));
      ws.on('close', () => {
        this.closed = true;
        for (const pending of this.pending.values()) pending.reject(new Error('Codex app-server connection closed'));
        this.pending.clear();
      });
    });
  }

  bindAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
    if (!signal) return () => {};
    const listener = () => {
      onAbort();
      this.close();
    };
    signal.addEventListener('abort', listener, { once: true });
    return () => signal.removeEventListener('abort', listener);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'input-codex-bridge',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.ws) throw new Error('Codex app-server is not connected');
    const id = this.nextId++;
    const request: JsonRpcRequest = { id, method, ...(params === undefined ? {} : { params }) };
    const payload = JSON.stringify(request);
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Failed to send request to Codex app-server'));
      });
    });
  }

  close(): void {
    if (!this.ws || this.closed) return;
    this.closed = true;
    this.ws.close();
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (isObject(message) && isJsonRpcId((message as { id?: unknown }).id)) {
      if (typeof (message as { method?: unknown }).method === 'string') {
        this.respondToServerRequest(message as JsonRpcRequest);
        return;
      }
      const response = message as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      const error = readResponseError(response);
      if (error) {
        pending.reject(error);
        return;
      }
      pending.resolve(response.result);
      return;
    }

    if (isObject(message) && typeof (message as JsonRpcNotification).method === 'string') {
      this.onNotification?.(message as JsonRpcNotification);
    }
  }

  private respondToServerRequest(request: JsonRpcRequest): void {
    if (!this.ws) return;
    const result = defaultServerRequestResult(request.method);
    this.ws.send(JSON.stringify({ id: request.id, result }));
  }
}
