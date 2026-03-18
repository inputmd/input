import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'ava';

const liveCodexUrl = process.env.CODEX_APP_SERVER_URL?.trim() ?? '';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve port');
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

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

async function readSseText(res: Response): Promise<string> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => {
      try {
        const payload = JSON.parse(line) as { choices?: Array<{ delta?: { content?: string } }> };
        return payload.choices?.[0]?.delta?.content ?? '';
      } catch {
        return '';
      }
    })
    .join('');
}

function startBridgeProcess(codexUrl: string, port: number): ChildProcess {
  const cliPath = new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url);
  return spawn(process.execPath, [fileURLToPath(cliPath), 'server/codex_bridge.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      CODEX_APP_SERVER_URL: codexUrl,
      CODEX_BRIDGE_PORT: String(port),
    },
    stdio: 'pipe',
  });
}

(liveCodexUrl ? test.serial : test.serial.skip)('bridge works against a live Codex app-server', async (t) => {
  const port = await reservePort();
  const bridge = startBridgeProcess(liveCodexUrl, port);
  await waitForBridge(port);

  t.teardown(async () => {
    bridge.kill('SIGTERM');
  });

  const modelsRes = await fetch(`http://127.0.0.1:${port}/api/ai/models`);
  t.true(modelsRes.ok);
  const models = (await modelsRes.json()) as { models: Array<{ id: string }> };
  t.true(models.models.length > 0);

  const chatRes = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'hello world',
      messages: [{ role: 'user', content: 'Reply with exactly: live bridge ok' }],
      current_doc_path: 'doc.md',
      model: models.models[0]?.id ?? null,
    }),
  });

  t.true(chatRes.ok);
  const text = await readSseText(chatRes);
  t.true(text.toLowerCase().includes('live bridge ok'));
});
