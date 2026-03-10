import type http from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { getSession } from '../session';
import { runCommandOnRunner } from './fly_runtime';
import { DEFAULT_COMMAND_TIMEOUT_MS } from './limits';
import { getSandboxByUserRepo, touchSandboxActivity } from './store';

const MAX_COMMAND_LENGTH = 3_000;

const TERMINAL_PATH_RE = /^\/api\/sandboxes\/repos\/([^/]+)\/([^/]+)\/terminal$/;

let wss: WebSocketServer | null = null;

export function handleTerminalUpgrade(
  req: http.IncomingMessage,
  socket: import('node:net').Socket,
  head: Buffer,
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = url.pathname.match(TERMINAL_PATH_RE);
  if (!match) return false;

  if (!wss) {
    wss = new WebSocketServer({ noServer: true });
  }

  const owner = match[1];
  const repo = match[2];

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleTerminalConnection(ws, req, owner, repo);
  });

  return true;
}

function handleTerminalConnection(ws: WebSocket, req: http.IncomingMessage, owner: string, repo: string): void {
  const session = getSession(req);
  if (!session) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const userId = session.githubUserId;
  const repoFullName = `${owner}/${repo}`;

  // Validate sandbox is ready at connection time
  const initial = getSandboxByUserRepo(userId, repoFullName);
  if (!initial || initial.state !== 'ready' || !initial.flyMachineId) {
    ws.close(4002, 'Sandbox not ready');
    return;
  }

  let running = false;

  // Per-connection message rate limiting: max 30 messages per 60s window
  const MSG_RATE_LIMIT = 30;
  const MSG_RATE_WINDOW_MS = 60_000;
  let msgCount = 0;
  let msgWindowStart = Date.now();

  ws.on('message', async (data) => {
    // Rate limiting
    const now = Date.now();
    if (now - msgWindowStart >= MSG_RATE_WINDOW_MS) {
      msgCount = 0;
      msgWindowStart = now;
    }
    msgCount++;
    if (msgCount > MSG_RATE_LIMIT) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limited — too many messages' }));
      return;
    }

    if (running) {
      ws.send(JSON.stringify({ type: 'error', message: 'Command already running' }));
      return;
    }

    // Re-lookup sandbox on each message to get current machineId and state
    const sandbox = getSandboxByUserRepo(userId, repoFullName);
    if (!sandbox || sandbox.state !== 'ready' || !sandbox.flyMachineId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Sandbox is no longer running' }));
      ws.close(4002, 'Sandbox not ready');
      return;
    }

    let command: string;
    try {
      const msg = JSON.parse(data.toString()) as { type?: string; command?: string };
      if (msg.type !== 'exec' || typeof msg.command !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        return;
      }
      command = msg.command.trim();
      if (!command) {
        ws.send(JSON.stringify({ type: 'error', message: 'Empty command' }));
        return;
      }
      if (command.length > MAX_COMMAND_LENGTH) {
        ws.send(JSON.stringify({ type: 'error', message: 'Command is too long' }));
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    running = true;
    touchSandboxActivity(sandbox.id);
    ws.send(JSON.stringify({ type: 'start', command }));

    try {
      const result = await runCommandOnRunner(sandbox.flyMachineId, command, DEFAULT_COMMAND_TIMEOUT_MS);
      ws.send(JSON.stringify({ type: 'result', ...result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Command failed';
      ws.send(JSON.stringify({ type: 'error', message }));
    } finally {
      running = false;
      touchSandboxActivity(sandbox.id);
    }
  });

  ws.on('close', () => {
    // Connection cleanup if needed
  });

  ws.send(JSON.stringify({ type: 'connected', repo: repoFullName, branch: initial.branch }));
}
