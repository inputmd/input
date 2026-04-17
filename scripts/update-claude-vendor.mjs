#!/usr/bin/env node

import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import {
  collectClaudeOverlayCompatReport,
  DEFAULT_CLAUDE_PACKAGE_DIR,
  DEFAULT_REPO_ROOT,
  printClaudeOverlayCompatReport,
  RIPGREP_LINK_RELATIVE_PATHS,
} from './check-claude-overlay-compat.mjs';

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadPackageManifest(packageDir) {
  const packageJsonPath = path.join(packageDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  return {
    packageDir,
    packageJson,
  };
}

async function findClaudePackageDirectory(directory) {
  const candidateDirs = [
    directory,
    path.join(directory, 'package'),
    path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code'),
  ];

  for (const candidateDir of candidateDirs) {
    try {
      const manifest = await loadPackageManifest(candidateDir);
      if (manifest.packageJson.name === '@anthropic-ai/claude-code') {
        return {
          packageDir: candidateDir,
          packageJson: manifest.packageJson,
        };
      }
    } catch {
      // Continue checking other candidate directories.
    }
  }

  throw new Error(`Could not find an @anthropic-ai/claude-code package under ${directory}`);
}

async function resolveSourcePackage({ sourcePath, tempRoot }) {
  const absoluteSourcePath = path.resolve(sourcePath);
  const tarball = /\.(?:tgz|tar\.gz)$/i.test(absoluteSourcePath);

  if (!tarball) {
    return await findClaudePackageDirectory(absoluteSourcePath);
  }

  const extractRoot = await mkdtemp(path.join(tempRoot, 'claude-pack-'));
  const tarResult = spawnSync('tar', ['-xzf', absoluteSourcePath, '-C', extractRoot], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (tarResult.status !== 0) {
    throw new Error(
      `Failed to extract ${absoluteSourcePath} with tar: ${tarResult.stderr?.trim() || tarResult.stdout?.trim() || `exit ${tarResult.status}`}`,
    );
  }

  const manifest = await findClaudePackageDirectory(extractRoot);
  return {
    ...manifest,
    tempExtractRoot: extractRoot,
  };
}

async function fetchLatestClaudePack(tempRoot) {
  const packDir = await mkdtemp(path.join(tempRoot, 'claude-pack-latest-'));
  const packResult = spawnSync('npm', ['pack', '@anthropic-ai/claude-code'], {
    cwd: packDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (packResult.status !== 0) {
    throw new Error(
      `Failed to fetch latest @anthropic-ai/claude-code with npm pack: ${packResult.stderr?.trim() || packResult.stdout?.trim() || `exit ${packResult.status}`}`,
    );
  }

  const tarballName = packResult.stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
  if (!tarballName) {
    throw new Error('npm pack did not report a tarball filename');
  }

  const tarballPath = path.join(packDir, tarballName);
  const manifest = await resolveSourcePackage({
    sourcePath: tarballPath,
    tempRoot,
  });
  return {
    ...manifest,
    fetchedTarballPath: tarballPath,
    packDir,
  };
}

export async function ensureClaudeRipgrepLinks({ packageDir, repoRoot = DEFAULT_REPO_ROOT }) {
  const overlayRgPath = path.join(repoRoot, 'vendor', 'overlay', '.local', 'bin', 'rg');
  const linkResults = [];

  for (const relativePath of RIPGREP_LINK_RELATIVE_PATHS) {
    const absolutePath = path.join(packageDir, relativePath);
    const linkTarget = toPosixPath(path.relative(path.dirname(absolutePath), overlayRgPath));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await rm(absolutePath, { force: true, recursive: true });
    await symlink(linkTarget, absolutePath);
    linkResults.push({
      linkTarget,
      relativePath,
    });
  }

  return linkResults;
}

export async function prepareClaudeVendorPackage({
  destinationPackageDir,
  repoRoot = DEFAULT_REPO_ROOT,
  sourcePackageDir,
}) {
  await rm(destinationPackageDir, { force: true, recursive: true });
  await mkdir(path.dirname(destinationPackageDir), { recursive: true });
  await cp(sourcePackageDir, destinationPackageDir, {
    force: true,
    recursive: true,
    verbatimSymlinks: true,
  });

  const linkResults = await ensureClaudeRipgrepLinks({
    packageDir: destinationPackageDir,
    repoRoot,
  });
  const manifest = await loadPackageManifest(destinationPackageDir);

  return {
    linkResults,
    packageJson: manifest.packageJson,
    preparedPackageDir: destinationPackageDir,
  };
}

async function swapPreparedPackageIntoPlace({ preparedPackageDir, targetPackageDir }) {
  const targetParent = path.dirname(targetPackageDir);
  const backupPackageDir = path.join(
    targetParent,
    `${path.basename(targetPackageDir)}.__backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const targetExists = await pathExists(path.join(targetPackageDir, 'package.json'));
  let renamedTarget = false;

  try {
    if (targetExists) {
      await rename(targetPackageDir, backupPackageDir);
      renamedTarget = true;
    }
    await rename(preparedPackageDir, targetPackageDir);
    if (renamedTarget) {
      await rm(backupPackageDir, { force: true, recursive: true });
    }
  } catch (err) {
    if (renamedTarget) {
      try {
        await rm(targetPackageDir, { force: true, recursive: true });
        await rename(backupPackageDir, targetPackageDir);
      } catch {
        // Preserve the original error; restore best effort only.
      }
    }
    throw err;
  }
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    keepTemp: false,
    latest: false,
    repoRoot: DEFAULT_REPO_ROOT,
    sourcePath: null,
    targetPackageDir: DEFAULT_CLAUDE_PACKAGE_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--keep-temp') {
      options.keepTemp = true;
      continue;
    }
    if (arg === '--latest') {
      options.latest = true;
      continue;
    }
    if (arg === '--source') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --source');
      options.sourcePath = value;
      index += 1;
      continue;
    }
    if (arg === '--target-package-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --target-package-dir');
      options.targetPackageDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--repo-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --repo-root');
      options.repoRoot = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  if (!options.help && !options.latest && !options.sourcePath) {
    options.latest = true;
  }

  return options;
}

function printHelp() {
  console.log(
    'Usage: node scripts/update-claude-vendor.mjs [--latest] [--source <package-dir-or-tgz>] [--target-package-dir <path>] [--repo-root <path>] [--dry-run] [--keep-temp]',
  );
}

export async function runClaudeVendorUpdate({
  dryRun = false,
  keepTemp = false,
  latest = false,
  repoRoot = DEFAULT_REPO_ROOT,
  sourcePath,
  targetPackageDir = DEFAULT_CLAUDE_PACKAGE_DIR,
}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'input-claude-vendor-'));
  const targetParent = path.dirname(targetPackageDir);
  const stagingPackageDir = await mkdtemp(path.join(targetParent, `${path.basename(targetPackageDir)}.__staging-`));

  let tempExtractRoot = null;
  let packDir = null;
  let fetchedTarballPath = null;

  try {
    const source =
      latest || !sourcePath ? await fetchLatestClaudePack(tempRoot) : await resolveSourcePackage({ sourcePath, tempRoot });
    tempExtractRoot = source.tempExtractRoot ?? null;
    packDir = source.packDir ?? null;
    fetchedTarballPath = source.fetchedTarballPath ?? null;

    const prepared = await prepareClaudeVendorPackage({
      destinationPackageDir: stagingPackageDir,
      repoRoot,
      sourcePackageDir: source.packageDir,
    });

    const stagedReport = await collectClaudeOverlayCompatReport({
      packageDir: stagingPackageDir,
      repoRoot,
    });
    if (stagedReport.issues.length > 0) {
      printClaudeOverlayCompatReport(stagedReport);
      throw new Error('Prepared Claude package failed overlay compatibility checks');
    }

    if (dryRun) {
      return {
        dryRun: true,
        fetchedTarballPath,
        keptPaths: keepTemp ? [stagingPackageDir, tempExtractRoot, packDir, fetchedTarballPath].filter(Boolean) : [],
        prepared,
        report: stagedReport,
        sourceVersion: source.packageJson.version ?? null,
        stagingPackageDir,
        targetPackageDir,
      };
    }

    await swapPreparedPackageIntoPlace({
      preparedPackageDir: stagingPackageDir,
      targetPackageDir,
    });

    const finalReport = await collectClaudeOverlayCompatReport({
      packageDir: targetPackageDir,
      repoRoot,
    });
    if (finalReport.issues.length > 0) {
      printClaudeOverlayCompatReport(finalReport);
      throw new Error('Updated Claude package failed overlay compatibility checks after swap');
    }

    return {
      dryRun: false,
      fetchedTarballPath,
      prepared,
      report: finalReport,
      sourceVersion: source.packageJson.version ?? null,
      targetPackageDir,
    };
  } finally {
    if (!keepTemp) {
      await rm(stagingPackageDir, { force: true, recursive: true }).catch(() => {});
      if (tempExtractRoot) {
        await rm(tempExtractRoot, { force: true, recursive: true }).catch(() => {});
      }
      if (packDir) {
        await rm(packDir, { force: true, recursive: true }).catch(() => {});
      }
      await rm(tempRoot, { force: true, recursive: true }).catch(() => {});
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }

    const result = await runClaudeVendorUpdate(options);
    printClaudeOverlayCompatReport(result.report);
    if (result.fetchedTarballPath) {
      console.log(`Fetched tarball: ${result.fetchedTarballPath}`);
    }
    if (result.dryRun) {
      console.log(`Dry run complete for Claude ${result.sourceVersion ?? 'unknown'} -> ${result.targetPackageDir}`);
    } else {
      console.log(`Updated Claude vendor to ${result.sourceVersion ?? 'unknown'} in ${result.targetPackageDir}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
