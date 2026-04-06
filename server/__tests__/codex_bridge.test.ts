import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type ExecutionContext } from 'ava';
import { WebSocketServer } from 'ws';
import { createSseParser } from '../../shared/sse.ts';

let localhostBindingAvailable = true;
type FakeCodexResponse = { deltas: string[]; requestApprovalWithStringId?: boolean };
type FakeCodexResponder = (
  inputText: string,
  params?: { threadStart?: Record<string, unknown>; turnStart?: Record<string, unknown> },
) => FakeCodexResponse;

let sharedFakeServer: http.Server | null = null;
let sharedBridgeProcess: ChildProcess | null = null;
let sharedBridgePort: number | null = null;
let currentFakeResponder: FakeCodexResponder = () => ({ deltas: ['ok'] });

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve listening port');
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isLocalhostBindError(error: unknown): boolean {
  return error instanceof Error && /listen EPERM: operation not permitted 127\.0\.0\.1/.test(error.message);
}

function skipIfLocalhostBindingUnavailable(t: ExecutionContext): boolean {
  if (!localhostBindingAvailable) {
    t.pass('Skipping codex bridge test because localhost binding is unavailable in this environment.');
    return true;
  }
  return false;
}

test.before(async () => {
  const server = http.createServer();
  try {
    await listen(server);
    await closeServer(server);
  } catch (error) {
    if (isLocalhostBindError(error)) {
      localhostBindingAvailable = false;
      return;
    }
    throw error;
  }

  const fake = startFakeCodexServer((inputText, params) => currentFakeResponder(inputText, params));
  sharedFakeServer = fake.server;
  sharedBridgePort = await reservePort();
  sharedBridgeProcess = startBridgeProcess(await fake.urlPromise, sharedBridgePort);
  await waitForBridge(sharedBridgePort);
});

test.afterEach.always(() => {
  currentFakeResponder = () => ({ deltas: ['ok'] });
});

test.after.always(async () => {
  sharedBridgeProcess?.kill('SIGTERM');
  sharedBridgeProcess = null;
  if (sharedFakeServer) {
    await closeServer(sharedFakeServer);
    sharedFakeServer = null;
  }
  sharedBridgePort = null;
});

async function waitForBridge(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ai/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Bridge did not become healthy in time');
}

function startBridgeProcess(codexUrl: string, port: number, envOverrides: Record<string, string> = {}): ChildProcess {
  const cliPath = new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url);
  return spawn(process.execPath, [fileURLToPath(cliPath), 'server/codex_bridge.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      CODEX_APP_SERVER_URL: codexUrl,
      CODEX_BRIDGE_PORT: String(port),
      ...envOverrides,
    },
    stdio: 'pipe',
  });
}

async function readSse(res: Response): Promise<Array<{ event: string; data: string }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: string }> = [];
  const parser = createSseParser({
    onEvent: (event) => {
      events.push({ event: event.event.trim(), data: event.data });
    },
  });
  parser.feed(text);
  parser.end();
  return events;
}

function startFakeCodexServer(responder: FakeCodexResponder): {
  server: http.Server;
  urlPromise: Promise<string>;
} {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let threadId = 0;
  let turnId = 0;

  wss.on('connection', (ws) => {
    let lastThreadStartParams: Record<string, unknown> | undefined;
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.method === 'initialize') {
        ws.send(
          JSON.stringify({
            id: message.id,
            result: { userAgent: 'fake', platformOs: 'macos', platformFamily: 'unix' },
          }),
        );
        return;
      }
      if (message.method === 'model/list') {
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              data: [
                {
                  id: 'model-1',
                  displayName: 'GPT-5.4',
                  model: 'gpt-5.4',
                  isDefault: true,
                  hidden: false,
                  description: 'fake',
                  defaultReasoningEffort: 'medium',
                  supportedReasoningEfforts: [],
                },
              ],
            },
          }),
        );
        return;
      }
      if (message.method === 'thread/start') {
        lastThreadStartParams = message.params;
        threadId += 1;
        ws.send(JSON.stringify({ id: message.id, result: { thread: { id: `thread-${threadId}` } } }));
        return;
      }
      if (message.method === 'turn/start') {
        turnId += 1;
        const turn = `turn-${turnId}`;
        const input = Array.isArray(message.params?.input) ? message.params.input : [];
        const inputText = typeof input[0]?.text === 'string' ? input[0].text : '';
        const { deltas, requestApprovalWithStringId } = responder(inputText, {
          threadStart: lastThreadStartParams,
          turnStart: message.params,
        });
        if (requestApprovalWithStringId) {
          ws.send(JSON.stringify({ id: 'approval-1', method: 'permissions/request', params: { reason: 'noop' } }));
        }
        ws.send(JSON.stringify({ id: message.id, result: { turn: { id: turn } } }));
        for (const delta of deltas) {
          ws.send(
            JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: `thread-${threadId}`, turnId: turn, itemId: `item-${turnId}`, delta },
            }),
          );
        }
        ws.send(
          JSON.stringify({ method: 'turn/completed', params: { threadId: `thread-${threadId}`, turn: { id: turn } } }),
        );
      }
    });
  });

  const urlPromise = listen(server).then((port) => `ws://127.0.0.1:${port}`);
  return { server, urlPromise };
}

async function writeFakeCodexCli(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'input-fake-codex-'));
  const filePath = path.join(dir, 'codex');
  const wsModulePath = fileURLToPath(new URL('../../node_modules/ws/index.js', import.meta.url));
  const script = `#!/usr/bin/env node
const http = require('node:http');
const { WebSocketServer } = require(${JSON.stringify(wsModulePath)});
const args = process.argv.slice(2);
if (args[0] !== 'app-server' || args[1] !== '--listen' || !args[2]) process.exit(2);
const listenUrl = new URL(args[2]);
const server = http.createServer((req, res) => {
  if (req.url === '/readyz' || req.url === '/healthz') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
const wss = new WebSocketServer({ server });
let threadId = 0;
let turnId = 0;
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === 'initialize') {
      ws.send(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformOs: 'macos', platformFamily: 'unix' } }));
      return;
    }
    if (message.method === 'model/list') {
      ws.send(JSON.stringify({ id: message.id, result: { data: [{ id: 'model-1', displayName: 'GPT-5.4', model: 'gpt-5.4', isDefault: true, hidden: false, description: 'fake', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] }] } }));
      return;
    }
    if (message.method === 'thread/start') {
      threadId += 1;
      ws.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-' + threadId } } }));
      return;
    }
    if (message.method === 'turn/start') {
      turnId += 1;
      const turn = 'turn-' + turnId;
      ws.send(JSON.stringify({ id: message.id, result: { turn: { id: turn } } }));
      ws.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-' + threadId, turnId: turn, itemId: 'item-' + turnId, delta: 'auto started ok' } }));
      ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-' + threadId, turn: { id: turn } } }));
    }
  });
});
server.listen(Number(listenUrl.port), listenUrl.hostname);
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
  await writeFile(filePath, script, 'utf8');
  await chmod(filePath, 0o755);
  return dir;
}

function requireSharedBridgePort(t: ExecutionContext): number {
  if (skipIfLocalhostBindingUnavailable(t)) return -1;
  if (sharedBridgePort === null) throw new Error('Shared Codex bridge did not start');
  return sharedBridgePort;
}

test.serial('bridge lists local Codex models', async (t) => {
  const bridgePort = requireSharedBridgePort(t);
  if (bridgePort < 0) return;

  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/models`);
  const data = (await res.json()) as { models: Array<{ id: string; name: string; provider?: string }> };
  t.true(res.ok);
  t.is(data.models[0]?.id, 'gpt-5.4');
  t.is(data.models[0]?.provider, 'codex_local');
});

test.serial('bridge can start codex app-server itself', async (t) => {
  if (skipIfLocalhostBindingUnavailable(t)) return;
  const codexBinDir = await writeFakeCodexCli();
  const bridgePort = await reservePort();
  const appServerPort = await reservePort();
  const bridge = startBridgeProcess(`ws://127.0.0.1:${appServerPort}`, bridgePort, {
    PATH: `${codexBinDir}:${process.env.PATH ?? ''}`,
    CODEX_BRIDGE_START_APP_SERVER: '1',
  });
  await waitForBridge(bridgePort);

  t.teardown(() => {
    bridge.kill('SIGTERM');
  });

  const modelsRes = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/models`);
  t.true(modelsRes.ok);

  const chatRes = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      source: 'hello',
      messages: [{ role: 'user', content: 'reply' }],
      current_doc_path: 'doc.md',
    }),
  });
  const events = await readSse(chatRes);
  const delta = events.find((event) => !event.event && event.data !== '[DONE]');
  t.truthy(delta);
  const payload = JSON.parse(delta!.data) as { choices: Array<{ delta: { content: string } }> };
  t.is(payload.choices[0]?.delta.content, 'auto started ok');
});

test.serial('bridge streams inline editor output', async (t) => {
  const bridgePort = requireSharedBridgePort(t);
  if (bridgePort < 0) return;
  currentFakeResponder = () => ({ deltas: ['rewritten ', 'text'] });

  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      source: 'old text',
      messages: [{ role: 'user', content: 'Rewrite this.' }],
      current_doc_path: 'doc.md',
      edit_mode_current_doc_only: true,
    }),
  });

  const events = await readSse(res);
  const deltas = events
    .filter((event) => !event.event && event.data !== '[DONE]')
    .map((event) => JSON.parse(event.data));
  t.deepEqual(
    deltas.map((entry) => entry.choices[0].delta.content),
    ['rewritten ', 'text'],
  );
});

test.serial('bridge answers string-id server requests from Codex app-server', async (t) => {
  const bridgePort = requireSharedBridgePort(t);
  if (bridgePort < 0) return;
  currentFakeResponder = () => ({ deltas: ['ok'], requestApprovalWithStringId: true });

  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      source: 'hello',
      messages: [{ role: 'user', content: 'Reply ok' }],
      current_doc_path: 'doc.md',
    }),
  });

  const events = await readSse(res);
  const delta = events.find((event) => !event.event && event.data !== '[DONE]');
  t.truthy(delta);
  const payload = JSON.parse(delta!.data) as { choices: Array<{ delta: { content: string } }> };
  t.is(payload.choices[0]?.delta.content, 'ok');
});

test.serial('bridge emits staged changes for structured Codex output', async (t) => {
  const bridgePort = requireSharedBridgePort(t);
  if (bridgePort < 0) return;
  currentFakeResponder = () => ({
    deltas: [
      'Applied the update.\n',
      '<input-staged-changes>{"assistant_message":"Applied the update.","suggested_commit_message":"fix: rewrite document","changes":[{"path":"doc.md","type":"edit","content":"new body"}]}</input-staged-changes>',
    ],
  });

  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      source: 'old body',
      messages: [{ role: 'user', content: 'Rewrite the document.' }],
      current_doc_path: 'doc.md',
    }),
  });

  const events = await readSse(res);
  const staged = events.find((event) => event.event === 'staged_changes');
  t.truthy(staged);
  const payload = JSON.parse(staged!.data) as {
    changes: Array<{ path: string; type: string; diff: string }>;
    file_contents: Record<string, string>;
    suggested_commit_message?: string;
    document_content?: string;
  };
  t.is(payload.suggested_commit_message, 'fix: rewrite document');
  t.is(payload.document_content, 'new body');
  t.is(payload.file_contents['doc.md'], 'new body');
  t.true(payload.changes[0]?.diff.includes('+new body'));

  const finalDelta = events.find((event) => !event.event && event.data !== '[DONE]');
  t.truthy(finalDelta);
  const deltaPayload = JSON.parse(finalDelta!.data) as { choices: Array<{ delta: { content: string } }> };
  t.is(deltaPayload.choices[0]?.delta.content.trim(), 'Applied the update.');
});

test.serial('bridge suppresses staged changes when document edits are disabled', async (t) => {
  const bridgePort = requireSharedBridgePort(t);
  if (bridgePort < 0) return;
  currentFakeResponder = () => ({
    deltas: [
      'Applied the update.\n',
      '<input-staged-changes>{"assistant_message":"Applied the update.","suggested_commit_message":"fix: rewrite document","changes":[{"path":"doc.md","type":"edit","content":"new body"}]}</input-staged-changes>',
    ],
  });

  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      source: 'old body',
      messages: [{ role: 'user', content: 'Rewrite the document.' }],
      current_doc_path: 'doc.md',
      allow_document_edits: false,
    }),
  });

  const events = await readSse(res);
  t.falsy(events.find((event) => event.event === 'staged_changes'));
  const finalDelta = events.find((event) => !event.event && event.data !== '[DONE]');
  t.truthy(finalDelta);
  const deltaPayload = JSON.parse(finalDelta!.data) as { choices: Array<{ delta: { content: string } }> };
  t.is(deltaPayload.choices[0]?.delta.content.trim(), 'Applied the update.');
});

test.serial('bridge streams reader output before completion when no staged block is present', async (t) => {
  const bridgePort = requireSharedBridgePort(t);
  if (bridgePort < 0) return;
  currentFakeResponder = () => ({
    deltas: ['first chunk ', 'second chunk'],
  });

  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      source: 'hello',
      messages: [{ role: 'user', content: 'Reply in two chunks' }],
      current_doc_path: 'doc.md',
    }),
  });

  const events = await readSse(res);
  const deltas = events
    .filter((event) => !event.event && event.data !== '[DONE]')
    .map((event) => JSON.parse(event.data) as { choices: Array<{ delta: { content: string } }> });
  t.deepEqual(
    deltas.map((entry) => entry.choices[0]?.delta.content),
    ['first chunk ', 'second chunk'],
  );
});

test.serial('bridge enables live web search for prompt-list mode', async (t) => {
  const bridgePort = requireSharedBridgePort(t);
  if (bridgePort < 0) return;
  let seenThreadStart: Record<string, unknown> | undefined;
  let seenTurnStart: Record<string, unknown> | undefined;
  currentFakeResponder = (_inputText, params) => {
    seenThreadStart = params?.threadStart;
    seenTurnStart = params?.turnStart;
    return { deltas: ['looked it up'] };
  };

  const res = await fetch(`http://127.0.0.1:${bridgePort}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      source: '',
      mode: 'prompt_list',
      messages: [{ role: 'user', content: 'What happened today?' }],
    }),
  });
  const events = await readSse(res);
  const delta = events.find((event) => !event.event && event.data !== '[DONE]');
  t.truthy(delta);
  t.is((seenThreadStart?.config as { web_search?: string } | undefined)?.web_search, 'live');
  t.is((seenTurnStart?.sandboxPolicy as { networkAccess?: boolean } | undefined)?.networkAccess ?? null, true);
});
