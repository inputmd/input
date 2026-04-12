import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const PI_PACKAGE_ROOT = path.resolve(
  process.cwd(),
  'vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent',
);

const PRUNE_DIRECTORY_BASENAMES = new Set([
  '.github',
  '.history',
  '__tests__',
  'docs',
  'example',
  'examples',
  'man',
  'spec',
  'test',
  'tests',
]);

const PRUNE_FILE_BASENAMES = new Set(['.yarnrc.yml', 'Cargo.toml', 'build.rs', 'package-lock.json', 'tsconfig.json']);

const PRUNE_NATIVE_PACKAGE_DIRS = [
  'node_modules/@mariozechner/clipboard-darwin-arm64',
  'node_modules/@mariozechner/clipboard-darwin-universal',
  'node_modules/koffi',
];

function shouldDeleteFile(name) {
  if (PRUNE_FILE_BASENAMES.has(name)) return true;
  if (name.endsWith('.map')) return true;
  if (name.endsWith('.d.ts') || name.endsWith('.d.ts.map')) return true;
  if (name.endsWith('.d.mts') || name.endsWith('.d.mts.map')) return true;
  if (name.endsWith('.d.cts') || name.endsWith('.d.cts.map')) return true;
  if (name.endsWith('.md') && !/^license(?:\.[^.]+)?$/i.test(name)) return true;
  return false;
}

function shouldDeleteSourceDirectory(parentPath, name) {
  if (name !== 'src') return false;
  const lowerParent = parentPath.replace(/\\/g, '/').toLowerCase();
  return (
    lowerParent.endsWith('/node_modules/openai') ||
    lowerParent.endsWith('/node_modules/@anthropic-ai/sdk') ||
    lowerParent.endsWith('/node_modules/@mistralai/mistralai')
  );
}

async function pruneTree(rootPath) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (PRUNE_DIRECTORY_BASENAMES.has(entry.name) || shouldDeleteSourceDirectory(rootPath, entry.name)) {
        await rm(entryPath, { force: true, recursive: true });
        continue;
      }
      await pruneTree(entryPath);
      continue;
    }
    if (shouldDeleteFile(entry.name)) {
      await rm(entryPath, { force: true });
    }
  }
}

async function sizeInBytes(rootPath) {
  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) return rootStat.size;
  let total = 0;
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    total += await sizeInBytes(path.join(rootPath, entry.name));
  }
  return total;
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function main() {
  const beforeBytes = await sizeInBytes(PI_PACKAGE_ROOT);
  await pruneTree(PI_PACKAGE_ROOT);
  for (const relativePath of PRUNE_NATIVE_PACKAGE_DIRS) {
    await rm(path.join(PI_PACKAGE_ROOT, relativePath), { force: true, recursive: true });
  }
  const afterBytes = await sizeInBytes(PI_PACKAGE_ROOT);
  const removedBytes = Math.max(0, beforeBytes - afterBytes);
  console.info('[prune-pi-overlay] completed', {
    before: formatMiB(beforeBytes),
    after: formatMiB(afterBytes),
    removed: formatMiB(removedBytes),
  });
}

await main();
