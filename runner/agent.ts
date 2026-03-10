import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const AUTH_TOKEN = process.env.RUNNER_AUTH_TOKEN ?? '';
const WORK_DIR = process.env.WORK_DIR ?? '/workspace';

// Build a sanitized copy of process.env that excludes the auth token.
// This is used for child processes so user commands cannot read the token.
const SANITIZED_ENV: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k !== 'RUNNER_AUTH_TOKEN' && v !== undefined) SANITIZED_ENV[k] = v;
}
// Keep in sync with server/sandboxes/limits.ts if changing these values
const MAX_OUTPUT_BYTES = 1024 * 1024;
const HARD_MAX_COMMAND_TIMEOUT_MS = 120_000;

function authenticate(req: http.IncomingMessage): boolean {
  if (!AUTH_TOKEN) {
    console.error('[agent] RUNNER_AUTH_TOKEN is not set — rejecting all requests');
    return false;
  }
  const auth = req.headers.authorization;
  return auth === `Bearer ${AUTH_TOKEN}`;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function handleExec(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: { argv?: string[]; command?: string; timeout_ms?: number; env?: Record<string, string> };
  try {
    body = JSON.parse(await readBody(req)) as {
      argv?: string[];
      command?: string;
      timeout_ms?: number;
      env?: Record<string, string>;
    };
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }

  // Accept either an argv array (preferred, no shell) or a legacy command string (via /bin/sh -c).
  const argv = Array.isArray(body.argv) && body.argv.every((a) => typeof a === 'string') ? body.argv : null;
  const command = !argv ? body.command?.trim() : null;
  if (!argv && !command) {
    jsonResponse(res, 400, { error: 'argv (array) or command (string) is required' });
    return;
  }

  // Merge caller-provided env vars (e.g. SANDBOX_GIT_TOKEN) into the child process env.
  // These appear only in the process environment, never in command strings or process args.
  const extraEnv: Record<string, string> = {};
  if (body.env && typeof body.env === 'object') {
    for (const [k, v] of Object.entries(body.env)) {
      if (typeof k === 'string' && typeof v === 'string') extraEnv[k] = v;
    }
  }

  const timeoutMs =
    typeof body.timeout_ms === 'number' ? Math.min(body.timeout_ms, HARD_MAX_COMMAND_TIMEOUT_MS) : 45_000;
  const startedAt = Date.now();

  // When argv is provided, execute directly without a shell. This avoids shell injection.
  // Legacy command strings still go through /bin/sh -c for backwards compatibility.
  const execArgs: [string, string[]] = argv ? [argv[0], argv.slice(1)] : ['/bin/sh', ['-c', command!]];
  const label = argv ? argv.join(' ') : command!;

  try {
    const { stdout, stderr } = await execFileAsync(execArgs[0], execArgs[1], {
      cwd: WORK_DIR,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...SANITIZED_ENV, HOME: WORK_DIR, ...extraEnv },
    });
    jsonResponse(res, 200, {
      command: label,
      cwd: WORK_DIR,
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      truncated: false,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: NodeJS.Signals;
      message?: string;
    };
    const timedOut = e.killed === true && e.signal === 'SIGTERM';
    const truncated = Boolean(e.message && /maxBuffer/i.test(e.message));
    const code = typeof e.status === 'number' ? e.status : 1;

    jsonResponse(res, 200, {
      command: label,
      cwd: WORK_DIR,
      exitCode: code,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? 'Command failed',
      durationMs: Date.now() - startedAt,
      timedOut,
      truncated,
    });
  }
}

async function handleClone(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: { repo_url?: string; branch?: string; token?: string; use_credential_helper?: boolean };
  try {
    body = JSON.parse(await readBody(req)) as {
      repo_url?: string;
      branch?: string;
      token?: string;
      use_credential_helper?: boolean;
    };
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const { repo_url, branch, token } = body;
  if (!repo_url || !branch) {
    jsonResponse(res, 400, { error: 'repo_url and branch are required' });
    return;
  }

  // Use credential helper so the token never appears in URLs, process args, or git remote config.
  // The token is passed via SANDBOX_GIT_TOKEN env var and read by the helper.
  const args = ['clone', '--depth', '1', '--branch', branch];
  const env: Record<string, string> = { ...SANITIZED_ENV, HOME: WORK_DIR };

  if (token) {
    args.push(
      '-c',
      'credential.helper=!f() { echo "username=x-access-token"; echo "password=$SANDBOX_GIT_TOKEN"; }; f',
    );
    env.SANDBOX_GIT_TOKEN = token;
  }

  args.push(repo_url, WORK_DIR);

  try {
    await execFileAsync('git', args, {
      timeout: 120_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      env,
    });
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    jsonResponse(res, 500, { error: `Clone failed: ${e.stderr ?? e.message ?? ''}` });
  }
}

async function handleGitStatus(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const [branchResult, statusResult, headResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: WORK_DIR }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: WORK_DIR }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: WORK_DIR }),
    ]);

    const changedFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => line.slice(3));

    jsonResponse(res, 200, {
      branch: branchResult.stdout.trim(),
      changedFiles,
      headSha: headResult.stdout.trim(),
    });
  } catch (err) {
    const e = err as Error;
    jsonResponse(res, 500, { error: `Git status failed: ${e.message}` });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Health check is unauthenticated so Fly health checks work without a token
    if (pathname === '/health' && req.method === 'GET') {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (!authenticate(req)) {
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (pathname === '/exec' && req.method === 'POST') {
      await handleExec(req, res);
      return;
    }

    if (pathname === '/clone' && req.method === 'POST') {
      await handleClone(req, res);
      return;
    }

    if (pathname === '/git/status' && req.method === 'GET') {
      await handleGitStatus(req, res);
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Runner agent listening on http://0.0.0.0:${PORT}`);
});
