import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { initDictionaryFromBuffer } from '../../shared/stream_boundary_dictionary.ts';
import { ClientError } from '../errors.ts';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'input-reader-ai-lab-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'input.db');
process.env.SHARE_TOKEN_SECRET = 'reader-ai-lab-secret';
process.env.OPENROUTER_API_KEY = 'reader-ai-lab-key';

const bloomPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'dictionary.bloom');
initDictionaryFromBuffer(new Uint8Array(readFileSync(bloomPath)));

const { handleApiRequest } = await import('../routes.ts');

test.after.always(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}

class MockRequest extends Readable {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  #body: Buffer;
  #sent = false;

  constructor(method: string, url: string, body?: string, remoteAddress = '127.0.0.1') {
    super();
    this.method = method;
    this.url = url;
    this.headers = {
      host: '127.0.0.1',
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
    this.socket = { remoteAddress };
    this.#body = Buffer.from(body ?? '', 'utf8');
  }

  _read(): void {
    if (this.#sent) {
      this.push(null);
      return;
    }
    this.#sent = true;
    if (this.#body.length > 0) this.push(this.#body);
    this.push(null);
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  #headers = new Map<string, string | number | string[]>();
  #chunks: string[] = [];

  setHeader(name: string, value: string | number | string[]): void {
    this.#headers.set(name.toLowerCase(), value);
  }

  getHeader(name: string): string | number | string[] | undefined {
    return this.#headers.get(name.toLowerCase());
  }

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.headersSent = true;
    this.#chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    return this;
  }

  bodyText(): string {
    return this.#chunks.join('');
  }

  header(name: string): string | number | string[] | undefined {
    return this.getHeader(name);
  }
}

function readSse(text: string): Array<{ event?: string; data: string }> {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event:'));
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      return {
        ...(eventLine ? { event: eventLine.slice('event:'.length).trim() } : {}),
        data,
      };
    });
}

async function requestApi(
  method: string,
  path: string,
  body?: unknown,
  options?: { remoteAddress?: string },
): Promise<{
  status: number;
  text: string;
  header: (name: string) => string | number | string[] | undefined;
}> {
  const req = new MockRequest(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    options?.remoteAddress,
  );
  const res = new MockResponse();
  const url = new URL(path, 'http://127.0.0.1');

  try {
    const handled = await handleApiRequest(req as never, res as never, url, url.pathname);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    if (error instanceof ClientError) {
      res.writeHead(error.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }));
    }
  }

  return {
    status: res.statusCode,
    text: res.bodyText(),
    header: (name) => res.header(name),
  };
}

test.serial('reader ai lab retries transient OpenRouter model listing failures', async (t) => {
  const originalFetch = globalThis.fetch;
  let modelsCallCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://openrouter.ai/api/v1/models') {
      modelsCallCount += 1;
      if (modelsCallCount === 1) {
        return makeJsonResponse({ error: 'timeout' }, 408);
      }
      return makeJsonResponse({
        data: [
          {
            id: 'test/nemotron-20b:free',
            name: 'Test Nemotron 20B',
            description: '20b tools model',
            context_length: 32_000,
            supported_parameters: ['tools'],
          },
        ],
      });
    }
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }

    return makeSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Retry succeeded.' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }) as typeof globalThis.fetch;

  try {
    const createRes = await requestApi('POST', '/api/test/reader-ai/documents', {
      path: 'retry.md',
      source: 'Alpha\n\nBeta',
    });
    t.is(createRes.status, 201);
    const createPayload = JSON.parse(createRes.text) as { document: { id: string } };

    const runRes = await requestApi('POST', `/api/test/reader-ai/documents/${createPayload.document.id}/runs`, {
      model: 'test/nemotron-20b:free',
      messages: [{ role: 'user', content: 'Summarize this document in one sentence.' }],
      allow_document_edits: false,
      allowed_tools: ['read_document'],
    });

    t.is(runRes.status, 200);
    t.is(modelsCallCount, 2);
    const events = readSse(runRes.text);
    t.true(events.some((event) => event.data.includes('Retry succeeded.')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.serial('reader ai lab can create, run, apply, reset, and retry documents locally', async (t) => {
  const originalFetch = globalThis.fetch;
  let completionCallCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://openrouter.ai/api/v1/models') {
      return makeJsonResponse({
        data: [
          {
            id: 'test/nemotron-20b:free',
            name: 'Test Nemotron 20B',
            description: '20b tools model',
            context_length: 32_000,
            supported_parameters: ['tools'],
          },
        ],
      });
    }
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }

    completionCallCount += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<{ role?: string; content?: string }>;
    };
    const toolNames = Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name).filter(Boolean) : [];
    const latestMessage = body.messages?.at(-1);

    if (!toolNames.includes('propose_edit_document')) {
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Read-only retry complete.' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }

    if (completionCallCount === 1) {
      return makeSseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_read', function: { name: 'read_document', arguments: '{}' } }],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }

    if (completionCallCount === 2) {
      t.true(
        Array.isArray(body.messages) &&
          body.messages.some((message) => message.role === 'tool' && String(message.content).includes('1: Alpha')),
      );
      return makeSseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_edit',
                    function: {
                      name: 'propose_edit_document',
                      arguments: '{"old_text":"Alpha","new_text":"Gamma","dry_run":false}',
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }

    t.is(latestMessage?.role, 'tool');
    t.true(String(latestMessage?.content ?? '').includes('"ok":true'));
    return makeSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Updated the first line.' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }) as typeof globalThis.fetch;

  t.teardown(() => {
    globalThis.fetch = originalFetch;
  });

  const createRes = await requestApi('POST', '/api/test/reader-ai/documents', {
    path: 'doc.md',
    source: 'Alpha\nBeta',
  });
  t.is(createRes.status, 201);
  const createPayload = JSON.parse(createRes.text) as {
    document: { id: string; current_source: string; original_source: string; path: string };
  };
  const documentId = createPayload.document.id;
  t.is(createPayload.document.path, 'doc.md');
  t.is(createPayload.document.current_source, 'Alpha\nBeta');
  t.is(createPayload.document.original_source, 'Alpha\nBeta');

  const runRes = await requestApi('POST', `/api/test/reader-ai/documents/${documentId}/runs`, {
    model: 'test/nemotron-20b:free',
    messages: [{ role: 'user', content: 'Rewrite the first line.' }],
    current_doc_path: 'doc.md',
  });
  t.is(runRes.status, 200);
  const runId = runRes.header('x-reader-ai-lab-run-id');
  t.truthy(runId);
  const events = readSse(runRes.text);
  t.truthy(events.find((event) => event.event === 'staged_changes'));
  const deltaText = events
    .filter((event) => !event.event && event.data !== '[DONE]')
    .map((event) => {
      const payload = JSON.parse(event.data) as { choices?: Array<{ delta?: { content?: string } }> };
      return payload.choices?.[0]?.delta?.content ?? '';
    })
    .join('');
  t.true(deltaText.includes('Updated the first line.'));

  const runLookupRes = await requestApi('GET', `/api/test/reader-ai/runs/${runId}`);
  t.is(runLookupRes.status, 200);
  const runLookupPayload = JSON.parse(runLookupRes.text) as {
    run: {
      status: string;
      source_at_start: string;
      staged_document_content: string | null;
      assistant_text: string;
      request: { current_doc_path: string | null; allowed_tools: string[] | null };
    };
  };
  t.is(runLookupPayload.run.status, 'completed');
  t.is(runLookupPayload.run.source_at_start, 'Alpha\nBeta');
  t.is(runLookupPayload.run.staged_document_content, 'Gamma\nBeta');
  t.true(runLookupPayload.run.assistant_text.includes('Updated the first line.'));
  t.is(runLookupPayload.run.request.current_doc_path, 'doc.md');
  t.is(runLookupPayload.run.request.allowed_tools, null);

  const applyRes = await requestApi('POST', `/api/test/reader-ai/runs/${runId}/apply`);
  t.is(applyRes.status, 200);
  const applyPayload = JSON.parse(applyRes.text) as { document: { current_source: string } };
  t.is(applyPayload.document.current_source, 'Gamma\nBeta');

  const documentAfterApplyRes = await requestApi('GET', `/api/test/reader-ai/documents/${documentId}`);
  const documentAfterApply = JSON.parse(documentAfterApplyRes.text) as {
    document: { current_source: string; original_source: string; latest_run_id: string | null };
    runs: Array<{ id: string }>;
  };
  t.is(documentAfterApply.document.current_source, 'Gamma\nBeta');
  t.is(documentAfterApply.document.original_source, 'Alpha\nBeta');
  t.is(documentAfterApply.document.latest_run_id, runId);
  t.true(documentAfterApply.runs.some((run) => run.id === runId));

  const resetRes = await requestApi('POST', `/api/test/reader-ai/documents/${documentId}/reset`);
  t.is(resetRes.status, 200);
  const resetPayload = JSON.parse(resetRes.text) as { document: { current_source: string } };
  t.is(resetPayload.document.current_source, 'Alpha\nBeta');

  const retryRes = await requestApi('POST', `/api/test/reader-ai/runs/${runId}/retry`, {
    allowed_tools: ['read_document'],
    messages: [{ role: 'user', content: 'Answer without editing.' }],
  });
  t.is(retryRes.status, 200);
  const retryRunId = retryRes.header('x-reader-ai-lab-run-id');
  t.truthy(retryRunId);
  t.not(retryRunId, runId);
  const retryEvents = readSse(retryRes.text);
  const retryText = retryEvents
    .filter((event) => !event.event && event.data !== '[DONE]')
    .map((event) => {
      const payload = JSON.parse(event.data) as { choices?: Array<{ delta?: { content?: string } }> };
      return payload.choices?.[0]?.delta?.content ?? '';
    })
    .join('');
  t.true(retryText.includes('Read-only retry complete.'));
  const retryStaged = retryEvents.find((event) => event.event === 'staged_changes');
  t.truthy(retryStaged);
  t.deepEqual(JSON.parse(retryStaged!.data), {
    changes: [],
    file_contents: {},
    suggested_commit_message: 'Apply AI-suggested changes',
  });

  const retryLookupRes = await requestApi('GET', `/api/test/reader-ai/runs/${retryRunId}`);
  const retryLookup = JSON.parse(retryLookupRes.text) as {
    run: {
      source_at_start: string;
      staged_document_content: string | null;
      request: { allowed_tools: string[] | null };
      assistant_text: string;
    };
  };
  t.is(retryLookup.run.source_at_start, 'Alpha\nBeta');
  t.is(retryLookup.run.staged_document_content, null);
  t.deepEqual(retryLookup.run.request.allowed_tools, ['read_document']);
  t.true(retryLookup.run.assistant_text.includes('Read-only retry complete.'));
});

test.serial('reader ai lab rejects non-loopback access', async (t) => {
  const res = await requestApi(
    'POST',
    '/api/test/reader-ai/documents',
    { path: 'doc.md', source: 'Alpha\nBeta' },
    { remoteAddress: '10.0.0.8' },
  );

  t.is(res.status, 404);
  t.deepEqual(JSON.parse(res.text), { error: 'Not found' });
});
