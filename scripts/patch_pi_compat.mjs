import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_PI_PACKAGE_ROOT = path.resolve(
  process.cwd(),
  'vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent',
);

const SDK_RELATIVE_PATH = 'dist/core/sdk.js';
const CLI_RELATIVE_PATH = 'dist/cli.js';
const RECURSIVE_RUNTIME_EXPORT = 'export * from "./agent-session-runtime.js";';
const EXPLICIT_RUNTIME_EXPORT =
  'export { AgentSessionRuntime, createAgentSessionRuntime } from "./agent-session-runtime.js";';
const EXPLICIT_SERVICES_EXPORT =
  'export { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.js";';
const FIXED_RUNTIME_EXPORT = `${EXPLICIT_RUNTIME_EXPORT}\n${EXPLICIT_SERVICES_EXPORT}`;
const PI_CLI_IMPORT_MARKER = 'import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";';
const PI_CLI_EMIT_WARNING_MARKER = 'process.emitWarning = (() => { });\n';
const PI_CLI_DISPATCHER_MARKER = 'setGlobalDispatcher(new EnvHttpProxyAgent());\n';
const PI_CLI_CWD_PATCH = `function syncCwdFromPwdEnv() {
    const shellPwd = process.env.PWD;
    if (!shellPwd)
        return;
    try {
        if (shellPwd !== process.cwd() && existsSync(shellPwd)) {
            process.chdir(shellPwd);
        }
    }
    catch { }
}
`;

export function rewritePiSdkRecursiveImportSource(source) {
  if (source.includes(RECURSIVE_RUNTIME_EXPORT)) {
    return source.replace(
      RECURSIVE_RUNTIME_EXPORT,
      source.includes(EXPLICIT_SERVICES_EXPORT) ? EXPLICIT_RUNTIME_EXPORT : FIXED_RUNTIME_EXPORT,
    );
  }

  if (source.includes(FIXED_RUNTIME_EXPORT)) return source;

  if (source.includes(EXPLICIT_RUNTIME_EXPORT) && !source.includes(EXPLICIT_SERVICES_EXPORT)) {
    return source.replace(EXPLICIT_RUNTIME_EXPORT, FIXED_RUNTIME_EXPORT);
  }

  throw new Error('Failed to find pi sdk recursive runtime export while applying recursive import fix.');
}

export function rewritePiCliEntrypointSource(source) {
  if (source.includes('process.env.PWD')) return source;
  let nextSource = source;

  if (!nextSource.includes(PI_CLI_IMPORT_MARKER)) {
    throw new Error('Failed to find pi cli import marker while applying cwd patch.');
  }
  nextSource = nextSource.replace(
    PI_CLI_IMPORT_MARKER,
    `import { existsSync } from "node:fs";\n${PI_CLI_IMPORT_MARKER}`,
  );

  if (!nextSource.includes(PI_CLI_EMIT_WARNING_MARKER)) {
    throw new Error('Failed to find pi cli emitWarning marker while applying cwd patch.');
  }
  nextSource = nextSource.replace(PI_CLI_EMIT_WARNING_MARKER, `${PI_CLI_EMIT_WARNING_MARKER}${PI_CLI_CWD_PATCH}`);

  if (!nextSource.includes(PI_CLI_DISPATCHER_MARKER)) {
    throw new Error('Failed to find pi cli dispatcher marker while applying cwd patch.');
  }
  nextSource = nextSource.replace(PI_CLI_DISPATCHER_MARKER, `syncCwdFromPwdEnv();\n${PI_CLI_DISPATCHER_MARKER}`);

  return nextSource;
}

export async function applyPiRecursiveImportFix(options = {}) {
  const packageRoot = options.packageRoot ?? DEFAULT_PI_PACKAGE_ROOT;
  const sdkPath = path.join(packageRoot, SDK_RELATIVE_PATH);
  const source = await readFile(sdkPath, 'utf8');
  const rewrittenSource = rewritePiSdkRecursiveImportSource(source);

  if (rewrittenSource !== source) {
    await writeFile(sdkPath, rewrittenSource);
  }

  return { changed: rewrittenSource !== source, path: sdkPath };
}

export async function applyPiCwdSyncPatch(options = {}) {
  const packageRoot = options.packageRoot ?? DEFAULT_PI_PACKAGE_ROOT;
  const cliPath = path.join(packageRoot, CLI_RELATIVE_PATH);
  const source = await readFile(cliPath, 'utf8');
  const rewrittenSource = rewritePiCliEntrypointSource(source);

  if (rewrittenSource !== source) {
    await writeFile(cliPath, rewrittenSource);
  }

  return { changed: rewrittenSource !== source, path: cliPath };
}

export async function applyPiVendorPatches(options = {}) {
  return {
    recursiveImport: await applyPiRecursiveImportFix(options),
    cwdSync: await applyPiCwdSyncPatch(options),
  };
}

async function main() {
  const result = await applyPiVendorPatches();
  console.info('[patch-pi-overlay] completed', result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
