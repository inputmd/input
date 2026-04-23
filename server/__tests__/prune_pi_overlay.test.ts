import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import { rewritePiCliEntrypointSource } from '../../scripts/prune_pi_overlay.mjs';

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
