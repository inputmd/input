import type { WebContainer } from '@webcontainer/api';
import { UPSTREAM_PROXY_SESSION_HEADER, UPSTREAM_PROXY_USER_AGENT_HEADER } from '../shared/upstream_proxy.ts';
import {
  encodeHostBridgeFrame,
  type HostBridgeControlFrame,
  type HostBridgeRequestEndFrame,
  parseHostBridgeFrame,
} from './webcontainer_host_bridge_protocol.ts';

const HOST_BRIDGE_PORT = 4318;
const HOST_BRIDGE_DEFAULT_URL = `http://127.0.0.1:${HOST_BRIDGE_PORT}`;
const HOST_BRIDGE_READY_TIMEOUT_MS = 15_000;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const REQUEST_HEADERS_BLOCKLIST = new Set([...HOP_BY_HOP_HEADERS, 'cookie', 'origin', 'referer', 'user-agent']);

interface SpawnedProcessLike {
  exit: Promise<number>;
  input: WritableStream<string>;
  kill: () => void;
  output: ReadableStream<string>;
}

interface BufferedBridgeRequest {
  abortController: AbortController | null;
  bodyChunks: Uint8Array[];
  headers: Record<string, string>;
  method: string;
  path: string;
  targetHost: string;
}

export interface WebContainerHostBridgeSession {
  env: Record<string, string>;
  stop: () => void;
}

interface StartWebContainerHostBridgeOptions {
  onLog?: (message: string) => void;
  wc: WebContainer;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function joinUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizeRequestHeaders(headers: Record<string, string>): Headers {
  const nextHeaders = new Headers();
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!name || REQUEST_HEADERS_BLOCKLIST.has(name)) continue;
    nextHeaders.set(rawName, value);
  }
  return nextHeaders;
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    normalized[key] = value;
  });
  return normalized;
}

async function readProcessStdout(process: SpawnedProcessLike): Promise<string> {
  const reader = process.output.getReader();
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += value;
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}

async function resolveWebContainerEnvValue(wc: WebContainer, name: string): Promise<string> {
  const process = (await wc.spawn('node', [
    '-e',
    'process.stdout.write(process.env[process.argv[1]] || "")',
    name,
  ])) as SpawnedProcessLike;
  const [output, exitCode] = await Promise.all([readProcessStdout(process), process.exit]);
  if (exitCode !== 0) {
    throw new Error(`node env lookup for ${name} exited with code ${exitCode}`);
  }
  return output.trim();
}

async function resolveWebContainerHomeDirectory(wc: WebContainer): Promise<string> {
  const homeDir = await resolveWebContainerEnvValue(wc, 'HOME');
  if (!homeDir) {
    throw new Error('WebContainer HOME is empty');
  }
  return homeDir;
}

export function buildWebContainerSpawnEnv(homeDir: string, currentPath: string): Record<string, string> {
  const normalizedHomeDir = trimTrailingSlashes(homeDir);
  const localBinDir = `${normalizedHomeDir}/.local/bin`;
  const pathEntries = currentPath
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalizedLocalBinDir = trimTrailingSlashes(localBinDir);
  const hasLocalBinDir = pathEntries.some((entry) => trimTrailingSlashes(entry) === normalizedLocalBinDir);

  return {
    COLORTERM: 'truecolor',
    INPUT_HOST_BRIDGE_URL: HOST_BRIDGE_DEFAULT_URL,
    NODE_OPTIONS: `--require=${normalizedHomeDir}/host_rewrite.mjs`,
    PATH: hasLocalBinDir ? currentPath : [localBinDir, currentPath].filter(Boolean).join(':'),
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'ghostty-web',
  };
}

function createProxyFetchUrl(targetHost: string, path: string): string {
  return new URL(`/api/upstream-proxy/${encodeURIComponent(targetHost)}${path}`, window.location.origin).toString();
}

export async function startWebContainerHostBridge({
  wc,
  onLog,
}: StartWebContainerHostBridgeOptions): Promise<WebContainerHostBridgeSession> {
  const proxySessionId = crypto.randomUUID();
  const homeDir = await resolveWebContainerHomeDirectory(wc);
  const currentPath = await resolveWebContainerEnvValue(wc, 'PATH');
  const daemonPath = `${trimTrailingSlashes(homeDir)}/host_bridge.mjs`;
  const daemon = (await wc.spawn('node', [daemonPath], {
    env: {
      INPUT_HOST_BRIDGE_PORT: String(HOST_BRIDGE_PORT),
    },
  })) as SpawnedProcessLike;
  const writer = daemon.input.getWriter();
  const requests = new Map<string, BufferedBridgeRequest>();
  const activeFetches = new Map<string, AbortController>();
  let stopped = false;
  let readyResolved = false;
  let writeQueue = Promise.resolve();
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimeoutId = window.setTimeout(() => {
    if (readyResolved || stopped) return;
    readyReject?.(new Error(`host bridge daemon did not become ready within ${HOST_BRIDGE_READY_TIMEOUT_MS}ms`));
  }, HOST_BRIDGE_READY_TIMEOUT_MS);

  const sendFrame = (frame: HostBridgeControlFrame) => {
    writeQueue = writeQueue
      .then(async () => {
        if (stopped) return;
        await writer.write(encodeHostBridgeFrame(frame));
      })
      .catch((err) => {
        if (stopped) return;
        onLog?.(`[terminal] host bridge write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  const finishRequest = (requestId: string) => {
    const request = requests.get(requestId);
    if (!request) return;
    request.abortController?.abort();
    activeFetches.delete(requestId);
    requests.delete(requestId);
  };

  const forwardRequest = async (frame: HostBridgeRequestEndFrame) => {
    const request = requests.get(frame.requestId);
    if (!request) return;
    const abortController = new AbortController();
    request.abortController = abortController;
    activeFetches.set(frame.requestId, abortController);

    try {
      const requestBody =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : toArrayBuffer(joinUint8Arrays(request.bodyChunks));
      const requestHeaders = normalizeRequestHeaders(request.headers);
      const originalUserAgent =
        request.headers['user-agent'] ?? request.headers['User-Agent'] ?? request.headers['USER-AGENT'] ?? null;
      requestHeaders.set(UPSTREAM_PROXY_SESSION_HEADER, proxySessionId);
      if (typeof originalUserAgent === 'string' && originalUserAgent.trim()) {
        requestHeaders.set(UPSTREAM_PROXY_USER_AGENT_HEADER, originalUserAgent.trim());
      }
      const response = await fetch(createProxyFetchUrl(request.targetHost, request.path), {
        body: requestBody,
        headers: requestHeaders,
        method: request.method,
        signal: abortController.signal,
      });
      sendFrame({
        headers: normalizeResponseHeaders(response.headers),
        requestId: frame.requestId,
        status: response.status,
        statusText: response.statusText,
        type: 'response-start',
      });
      if (!response.body) {
        sendFrame({ requestId: frame.requestId, type: 'response-end' });
        finishRequest(frame.requestId);
        return;
      }

      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength === 0) continue;
          sendFrame({
            chunkBase64: bytesToBase64(value),
            requestId: frame.requestId,
            type: 'response-body',
          });
        }
      } finally {
        reader.releaseLock();
      }
      sendFrame({ requestId: frame.requestId, type: 'response-end' });
    } catch (err) {
      if (!abortController.signal.aborted) {
        sendFrame({
          message: err instanceof Error ? err.message : String(err),
          requestId: frame.requestId,
          status: 502,
          type: 'response-error',
        });
      }
    } finally {
      finishRequest(frame.requestId);
    }
  };

  const handleFrame = (frame: HostBridgeControlFrame) => {
    switch (frame.type) {
      case 'ready': {
        if (readyResolved) return;
        readyResolved = true;
        window.clearTimeout(readyTimeoutId);
        readyResolve?.();
        return;
      }
      case 'fatal': {
        const message = frame.message || 'host bridge daemon failed';
        if (!readyResolved) {
          window.clearTimeout(readyTimeoutId);
          readyReject?.(new Error(message));
          return;
        }
        onLog?.(`[terminal] host bridge daemon failed: ${message}`);
        return;
      }
      case 'request-start': {
        requests.set(frame.requestId, {
          abortController: null,
          bodyChunks: [],
          headers: frame.headers,
          method: frame.method,
          path: frame.path,
          targetHost: frame.targetHost,
        });
        return;
      }
      case 'request-body': {
        const request = requests.get(frame.requestId);
        if (!request) return;
        request.bodyChunks.push(base64ToBytes(frame.chunkBase64));
        return;
      }
      case 'request-end': {
        void forwardRequest(frame);
        return;
      }
      case 'request-abort': {
        const request = requests.get(frame.requestId);
        if (!request) return;
        request.abortController?.abort();
        finishRequest(frame.requestId);
        return;
      }
      default:
        return;
    }
  };

  let outputBuffer = '';
  void daemon.output
    .pipeTo(
      new WritableStream({
        write(chunk) {
          outputBuffer += chunk;
          while (true) {
            const newlineIndex = outputBuffer.indexOf('\n');
            if (newlineIndex === -1) break;
            const line = outputBuffer.slice(0, newlineIndex).trim();
            outputBuffer = outputBuffer.slice(newlineIndex + 1);
            if (!line) continue;
            const frame = parseHostBridgeFrame(line);
            if (!frame) {
              onLog?.(`[terminal] host bridge daemon: ${line}`);
              continue;
            }
            handleFrame(frame);
          }
        },
      }),
    )
    .catch((err) => {
      if (stopped) return;
      onLog?.(`[terminal] host bridge output closed: ${err instanceof Error ? err.message : String(err)}`);
    });

  void daemon.exit.then((code) => {
    if (stopped) return;
    const message = `host bridge daemon exited with code ${code}`;
    if (!readyResolved) {
      window.clearTimeout(readyTimeoutId);
      readyReject?.(new Error(message));
      return;
    }
    onLog?.(`[terminal] ${message}`);
  });

  await readyPromise;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(readyTimeoutId);
    for (const controller of activeFetches.values()) {
      controller.abort();
    }
    activeFetches.clear();
    requests.clear();
    try {
      void writer.close().catch(() => {
        // ignore
      });
    } catch {
      // ignore
    }
    try {
      writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      daemon.kill();
    } catch {
      // ignore
    }
  };

  return {
    env: buildWebContainerSpawnEnv(homeDir, currentPath),
    stop,
  };
}
