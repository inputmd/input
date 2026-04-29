import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.INPUT_HOST_BRIDGE_PORT ?? '4318', 10);
const RESPONSE_HEADERS_BLOCKLIST = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

let nextRequestId = 0;
const activeRequests = new Map();
let shuttingDown = false;
let stdinBuffer = '';

function writeFrame(frame) {
  try {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  } catch {
    // ignore
  }
}

function requestStateHeaders(headers) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return normalized;
}

function parseProxyUrl(rawUrl) {
  const url = new URL(rawUrl || '/', `http://${HOST}:${PORT}`);
  if (!url.pathname.startsWith('/proxy/')) return null;
  const subPath = url.pathname.slice('/proxy/'.length);
  if (!subPath) return null;
  const schemeSlashIndex = subPath.indexOf('/');
  if (schemeSlashIndex === -1) return null;
  const targetScheme = decodeURIComponent(subPath.slice(0, schemeSlashIndex));
  if (targetScheme !== 'http' && targetScheme !== 'https') return null;
  const hostAndPath = subPath.slice(schemeSlashIndex + 1);
  const hostSlashIndex = hostAndPath.indexOf('/');
  const targetHost = decodeURIComponent(hostSlashIndex === -1 ? hostAndPath : hostAndPath.slice(0, hostSlashIndex));
  if (!targetHost) return null;
  const restPath = hostSlashIndex === -1 ? '/' : hostAndPath.slice(hostSlashIndex);
  return {
    path: `${restPath}${url.search}`,
    targetScheme,
    targetHost,
  };
}

function finishRequest(requestId) {
  activeRequests.delete(requestId);
}

function handleResponseStart(frame) {
  const state = activeRequests.get(frame.requestId);
  if (!state || state.res.headersSent) return;
  const headers = {};
  for (const [name, value] of Object.entries(frame.headers || {})) {
    if (!name || RESPONSE_HEADERS_BLOCKLIST.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  state.res.writeHead(frame.status, frame.statusText || undefined, headers);
}

function handleResponseBody(frame) {
  const state = activeRequests.get(frame.requestId);
  if (!state || state.res.writableEnded) return;
  try {
    state.res.write(Buffer.from(frame.chunkBase64, 'base64'));
  } catch {
    // ignore malformed chunks and let the response finish with an error frame.
  }
}

function handleResponseEnd(frame) {
  const state = activeRequests.get(frame.requestId);
  if (!state) return;
  if (!state.res.writableEnded) state.res.end();
  finishRequest(frame.requestId);
}

function handleResponseError(frame) {
  const state = activeRequests.get(frame.requestId);
  if (!state) return;
  if (!state.res.headersSent) {
    state.res.writeHead(frame.status || 502, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    state.res.end(`${frame.message || 'Proxy request failed'}\n`);
  } else if (!state.res.writableEnded) {
    state.res.end();
  }
  finishRequest(frame.requestId);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [requestId, state] of activeRequests) {
    if (!state.res.writableEnded) {
      state.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      state.res.end('Host bridge is shutting down\n');
    }
    finishRequest(requestId);
  }
  server.close(() => process.exit(0));
}

const server = http.createServer((req, res) => {
  const parsed = parseProxyUrl(req.url);
  if (!parsed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
    return;
  }

  const requestId = String(++nextRequestId);
  activeRequests.set(requestId, { req, res });

  let aborted = false;
  const sendAbort = () => {
    if (aborted) return;
    aborted = true;
    writeFrame({ requestId, type: 'request-abort' });
  };

  req.on('aborted', sendAbort);
  res.on('close', () => {
    if (!res.writableEnded) sendAbort();
  });

  writeFrame({
    headers: requestStateHeaders(req.headers),
    method: req.method || 'GET',
    path: parsed.path,
    requestId,
    targetScheme: parsed.targetScheme,
    targetHost: parsed.targetHost,
    type: 'request-start',
  });

  req.on('data', (chunk) => {
    writeFrame({
      chunkBase64: Buffer.from(chunk).toString('base64'),
      requestId,
      type: 'request-body',
    });
  });
  req.on('end', () => {
    writeFrame({ requestId, type: 'request-end' });
  });
});

server.on('error', (err) => {
  writeFrame({ message: err instanceof Error ? err.message : String(err), type: 'fatal' });
  process.exit(1);
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  while (true) {
    const newlineIndex = stdinBuffer.indexOf('\n');
    if (newlineIndex === -1) break;
    const line = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (!frame || typeof frame.type !== 'string') continue;
    switch (frame.type) {
      case 'response-start':
        handleResponseStart(frame);
        break;
      case 'response-body':
        handleResponseBody(frame);
        break;
      case 'response-end':
        handleResponseEnd(frame);
        break;
      case 'response-error':
        handleResponseError(frame);
        break;
      case 'shutdown':
        shutdown();
        break;
      default:
        break;
    }
  }
});

process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  writeFrame({ port: PORT, type: 'ready' });
});
