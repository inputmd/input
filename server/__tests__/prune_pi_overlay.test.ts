import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import { rewritePiCliEntrypointSource, rewritePiSdkRecursiveImportSource } from '../../scripts/patch_pi_compat.mjs';

const PI_CLI_SOURCE = `#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";
process.emitWarning = (() => { });
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";
setGlobalDispatcher(new EnvHttpProxyAgent());
main(process.argv.slice(2));
//# sourceMappingURL=cli.js.map
`;

const PI_SDK_SOURCE = `import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
export * from "./agent-session-runtime.js";
export { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.js";
export async function createAgentSession(options = {}) {
    return options;
}
`;

const PARTIALLY_PATCHED_PI_SDK_SOURCE = `import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
export { AgentSessionRuntime, createAgentSessionRuntime } from "./agent-session-runtime.js";
export async function createAgentSession(options = {}) {
    return options;
}
`;

test('rewritePiCliEntrypointSource injects cwd sync from PWD and stays idempotent', (t) => {
  const rewritten = rewritePiCliEntrypointSource(PI_CLI_SOURCE);

  t.true(rewritten.includes('import { existsSync } from "node:fs";'));
  t.true(rewritten.includes('const shellPwd = process.env.PWD;'));
  t.true(rewritten.includes('process.chdir(shellPwd);'));
  t.true(rewritten.includes('syncCwdFromPwdEnv();'));
  t.is(rewritePiCliEntrypointSource(rewritten), rewritten);
});

test('vendored pi cli includes cwd sync patch', async (t) => {
  const cliSource = await readFile(
    path.resolve('vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'),
    'utf8',
  );

  t.true(cliSource.includes('process.env.PWD'));
  t.true(cliSource.includes('process.chdir(shellPwd);'));
});

test('rewritePiSdkRecursiveImportSource replaces recursive runtime export and stays idempotent', (t) => {
  const rewritten = rewritePiSdkRecursiveImportSource(PI_SDK_SOURCE);

  t.false(rewritten.includes('export * from "./agent-session-runtime.js";'));
  t.true(
    rewritten.includes('export { AgentSessionRuntime, createAgentSessionRuntime } from "./agent-session-runtime.js";'),
  );
  t.true(
    rewritten.includes(
      'export { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.js";',
    ),
  );
  t.is(rewritePiSdkRecursiveImportSource(rewritten), rewritten);
});

test('rewritePiSdkRecursiveImportSource restores service exports after partial patch', (t) => {
  const rewritten = rewritePiSdkRecursiveImportSource(PARTIALLY_PATCHED_PI_SDK_SOURCE);

  t.true(
    rewritten.includes(
      'export { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.js";',
    ),
  );
  t.is(rewritePiSdkRecursiveImportSource(rewritten), rewritten);
});

test('vendored pi sdk includes recursive import fix', async (t) => {
  const sdkSource = await readFile(
    path.resolve('vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.js'),
    'utf8',
  );

  t.false(sdkSource.includes('export * from "./agent-session-runtime.js";'));
  t.true(
    sdkSource.includes('export { AgentSessionRuntime, createAgentSessionRuntime } from "./agent-session-runtime.js";'),
  );
  t.true(
    sdkSource.includes(
      'export { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.js";',
    ),
  );
});
