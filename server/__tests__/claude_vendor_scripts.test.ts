import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import { collectClaudeOverlayCompatReport } from '../../scripts/check-claude-overlay-compat.mjs';
import { ensureClaudeRipgrepLinks, prepareClaudeVendorPackage } from '../../scripts/update-claude-vendor.mjs';

test('collectClaudeOverlayCompatReport passes for the current repo state', async (t) => {
  const report = await collectClaudeOverlayCompatReport();

  t.deepEqual(report.issues, []);
  t.true(report.runtimeRelevantCliHosts.includes('api.anthropic.com'));
});

test('prepareClaudeVendorPackage preserves cli.js contents and recreates ripgrep symlinks', async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'input-claude-vendor-script-'));
  const sourcePackageDir = path.join(repoRoot, 'source', 'package');
  const destinationPackageDir = path.join(
    repoRoot,
    'vendor',
    'overlay',
    '.local',
    'lib',
    'node_modules',
    '@anthropic-ai',
    'claude-code.__staging-test',
  );
  const overlayRgPath = path.join(repoRoot, 'vendor', 'overlay', '.local', 'bin', 'rg');

  t.teardown(async () => {
    await rm(repoRoot, { force: true, recursive: true });
  });

  await mkdir(path.dirname(overlayRgPath), { recursive: true });
  await writeFile(overlayRgPath, '#!/usr/bin/env node\n', 'utf8');

  await mkdir(path.join(sourcePackageDir, 'vendor', 'ripgrep'), { recursive: true });
  await mkdir(path.join(sourcePackageDir, 'vendor', 'seccomp', 'arm64'), { recursive: true });
  await mkdir(path.join(sourcePackageDir, 'vendor', 'seccomp', 'x64'), { recursive: true });
  await writeFile(
    path.join(sourcePackageDir, 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-code', version: '9.9.9' }, null, 2),
    'utf8',
  );
  await writeFile(path.join(sourcePackageDir, 'cli.js'), '// Version: 9.9.9\nconsole.log("cli");\n', 'utf8');
  await writeFile(path.join(sourcePackageDir, 'README.md'), 'README\n', 'utf8');
  await writeFile(path.join(sourcePackageDir, 'LICENSE.md'), 'LICENSE\n', 'utf8');
  await writeFile(path.join(sourcePackageDir, 'sdk-tools.d.ts'), 'export {};\n', 'utf8');
  await writeFile(path.join(sourcePackageDir, 'vendor', 'ripgrep', 'COPYING'), 'COPYING\n', 'utf8');
  await writeFile(path.join(sourcePackageDir, 'vendor', 'seccomp', 'arm64', 'apply-seccomp'), 'arm64\n', 'utf8');
  await writeFile(path.join(sourcePackageDir, 'vendor', 'seccomp', 'x64', 'apply-seccomp'), 'x64\n', 'utf8');

  await prepareClaudeVendorPackage({
    destinationPackageDir,
    repoRoot,
    sourcePackageDir,
  });

  const cliSource = await readFile(path.join(destinationPackageDir, 'cli.js'), 'utf8');
  t.is(cliSource, '// Version: 9.9.9\nconsole.log("cli");\n');

  const linkResults = await ensureClaudeRipgrepLinks({
    packageDir: destinationPackageDir,
    repoRoot,
  });
  const sampleLink = linkResults.find((entry) => entry.relativePath === 'vendor/ripgrep/x64-linux/rg');
  const actualLinkTarget = await readlink(path.join(destinationPackageDir, 'vendor', 'ripgrep', 'x64-linux', 'rg'));

  t.truthy(sampleLink);
  t.is(actualLinkTarget, sampleLink?.linkTarget);
});
