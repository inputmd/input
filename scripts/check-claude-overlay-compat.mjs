#!/usr/bin/env node

import { access, lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_CLAUDE_PACKAGE_DIR = path.join(
  DEFAULT_REPO_ROOT,
  'vendor',
  'overlay',
  '.local',
  'lib',
  'node_modules',
  '@anthropic-ai',
  'claude-code',
);
export const DEFAULT_HOST_REWRITE_PATH = path.join(DEFAULT_REPO_ROOT, 'vendor', 'overlay', 'host_rewrite.mjs');
export const DEFAULT_UPSTREAM_PROXY_PATH = path.join(DEFAULT_REPO_ROOT, 'server', 'upstream_proxy.ts');
export const DEFAULT_WEBCONTAINER_HOST_BRIDGE_PATH = path.join(
  DEFAULT_REPO_ROOT,
  'src',
  'webcontainer_host_bridge.ts',
);
export const DEFAULT_OVERLAY_JSHRC_PATH = path.join(DEFAULT_REPO_ROOT, 'vendor', 'overlay', '.jshrc');

export const REQUIRED_CLAUDE_PACKAGE_RELATIVE_PATHS = [
  'LICENSE.md',
  'README.md',
  'cli.js',
  'package.json',
  'sdk-tools.d.ts',
  'vendor/ripgrep/COPYING',
  'vendor/seccomp/arm64/apply-seccomp',
  'vendor/seccomp/x64/apply-seccomp',
];

export const RIPGREP_LINK_RELATIVE_PATHS = [
  'vendor/ripgrep/arm64-darwin/rg',
  'vendor/ripgrep/arm64-linux/rg',
  'vendor/ripgrep/arm64-win32/rg.exe',
  'vendor/ripgrep/x64-darwin/rg',
  'vendor/ripgrep/x64-linux/rg',
  'vendor/ripgrep/x64-win32/rg.exe',
];

const RUNTIME_URL_PATH_PATTERN = /(?:^|\/)(?:api|oauth|login|bridge|sync|plugins?|claude-code-releases|v\d+)(?:\/|$)/i;

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

function extractQuotedStrings(source) {
  const values = [];
  for (const match of source.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    values.push(match[1] ?? match[2] ?? '');
  }
  return values;
}

function extractNamedStringArray(source, name) {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[(?<body>[\\s\\S]*?)\\];`, 'm'));
  if (!match?.groups?.body) {
    throw new Error(`Could not find array declaration for ${name}`);
  }
  return extractQuotedStrings(match.groups.body);
}

function extractNamedStringSet(source, name) {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*new Set\\(\\[(?<body>[\\s\\S]*?)\\]\\);`, 'm'));
  if (!match?.groups?.body) {
    throw new Error(`Could not find Set declaration for ${name}`);
  }
  return extractQuotedStrings(match.groups.body);
}

function hostnameMatchesPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
  return new RegExp(`^${escapedPattern}$`, 'i').test(hostname);
}

function isHostAllowed(hostname, allowedHosts, allowedPatterns) {
  if (allowedHosts.has(hostname)) return true;
  return allowedPatterns.some((pattern) => hostnameMatchesPattern(hostname, pattern));
}

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function compareSets(leftValues, rightValues) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  return {
    onlyLeft: sortStrings([...left].filter((value) => !right.has(value))),
    onlyRight: sortStrings([...right].filter((value) => !left.has(value))),
  };
}

export function extractClaudeCliVersions(cliSource) {
  const commentVersion = cliSource.match(/^\/\/ Version:\s*([^\s]+)\s*$/m)?.[1] ?? null;
  const runtimeVersionMatch =
    cliSource.match(/PACKAGE_URL:"@anthropic-ai\/claude-code"[\s\S]{0,400}?VERSION:"([^"]+)"/) ??
    cliSource.match(/README_URL:"https:\/\/code\.claude\.com\/docs\/en\/overview",VERSION:"([^"]+)"/);
  const runtimeVersion = runtimeVersionMatch?.[1] ?? null;
  return {
    commentVersion,
    runtimeVersion,
  };
}

export function extractRuntimeRelevantCliHosts(cliSource) {
  const hosts = new Set();
  for (const match of cliSource.matchAll(/https?:\/\/[^\s"'`]+/g)) {
    let url;
    try {
      url = new URL(match[0].replace(/[),.;]+$/, ''));
    } catch {
      continue;
    }
    if (!RUNTIME_URL_PATH_PATTERN.test(url.pathname)) continue;
    hosts.add(url.hostname.toLowerCase());
  }
  return sortStrings(hosts);
}

export async function collectClaudeOverlayCompatReport({
  packageDir = DEFAULT_CLAUDE_PACKAGE_DIR,
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  const issues = [];
  const warnings = [];
  const packageJsonPath = path.join(packageDir, 'package.json');
  const cliPath = path.join(packageDir, 'cli.js');
  const overlayRgPath = path.join(repoRoot, 'vendor', 'overlay', '.local', 'bin', 'rg');
  const hostRewritePath = path.join(repoRoot, 'vendor', 'overlay', 'host_rewrite.mjs');
  const upstreamProxyPath = path.join(repoRoot, 'server', 'upstream_proxy.ts');
  const webcontainerHostBridgePath = path.join(repoRoot, 'src', 'webcontainer_host_bridge.ts');
  const overlayJshrcPath = path.join(repoRoot, 'vendor', 'overlay', '.jshrc');

  const [packageJsonSource, cliSource, hostRewriteSource, upstreamProxySource, webcontainerHostBridgeSource, overlayJshrc] =
    await Promise.all([
      readFile(packageJsonPath, 'utf8'),
      readFile(cliPath, 'utf8'),
      readFile(hostRewritePath, 'utf8'),
      readFile(upstreamProxyPath, 'utf8'),
      readFile(webcontainerHostBridgePath, 'utf8'),
      readFile(overlayJshrcPath, 'utf8'),
    ]);

  const packageJson = JSON.parse(packageJsonSource);
  const versionInfo = extractClaudeCliVersions(cliSource);

  if (packageJson.name !== '@anthropic-ai/claude-code') {
    issues.push(`Expected @anthropic-ai/claude-code package, found ${packageJson.name ?? '(missing name)'}`);
  }
  if (versionInfo.commentVersion && packageJson.version !== versionInfo.commentVersion) {
    issues.push(
      `Claude package.json version ${packageJson.version} does not match cli.js comment version ${versionInfo.commentVersion}`,
    );
  }
  if (versionInfo.runtimeVersion && packageJson.version !== versionInfo.runtimeVersion) {
    issues.push(
      `Claude package.json version ${packageJson.version} does not match cli.js runtime version ${versionInfo.runtimeVersion}`,
    );
  }

  const packageFileChecks = await Promise.all(
    REQUIRED_CLAUDE_PACKAGE_RELATIVE_PATHS.map(async (relativePath) => {
      const absolutePath = path.join(packageDir, relativePath);
      return {
        absolutePath,
        exists: await pathExists(absolutePath),
        relativePath,
      };
    }),
  );

  for (const fileCheck of packageFileChecks) {
    if (!fileCheck.exists) {
      issues.push(`Missing Claude package file: ${fileCheck.relativePath}`);
    }
  }

  const ripgrepLinks = [];
  for (const relativePath of RIPGREP_LINK_RELATIVE_PATHS) {
    const absolutePath = path.join(packageDir, relativePath);
    const expectedTarget = toPosixPath(path.relative(path.dirname(absolutePath), overlayRgPath));
    try {
      const stats = await lstat(absolutePath);
      if (!stats.isSymbolicLink()) {
        ripgrepLinks.push({
          actualTarget: null,
          exists: true,
          expectedTarget,
          isSymlink: false,
          relativePath,
        });
        issues.push(`Claude ripgrep path is not a symlink: ${relativePath}`);
        continue;
      }

      const actualTarget = await readlink(absolutePath);
      ripgrepLinks.push({
        actualTarget,
        exists: true,
        expectedTarget,
        isSymlink: true,
        relativePath,
      });
      if (toPosixPath(actualTarget) !== expectedTarget) {
        issues.push(`Claude ripgrep symlink mismatch for ${relativePath}: expected ${expectedTarget}, found ${actualTarget}`);
      }
    } catch {
      ripgrepLinks.push({
        actualTarget: null,
        exists: false,
        expectedTarget,
        isSymlink: false,
        relativePath,
      });
      issues.push(`Missing Claude ripgrep symlink: ${relativePath}`);
    }
  }

  const hostRewriteHosts = extractNamedStringArray(hostRewriteSource, 'REWRITE_HOSTS');
  const hostRewritePatterns = extractNamedStringArray(hostRewriteSource, 'REWRITE_HOST_PATTERNS');
  const upstreamProxyHosts = extractNamedStringSet(upstreamProxySource, 'UPSTREAM_PROXY_ALLOWED_HOSTS');
  const upstreamProxyPatterns = extractNamedStringArray(upstreamProxySource, 'UPSTREAM_PROXY_ALLOWED_HOST_PATTERNS');

  const hostMismatch = compareSets(hostRewriteHosts, upstreamProxyHosts);
  const patternMismatch = compareSets(hostRewritePatterns, upstreamProxyPatterns);

  if (hostMismatch.onlyLeft.length > 0 || hostMismatch.onlyRight.length > 0) {
    issues.push(
      `Host rewrite and upstream proxy host allowlists differ: host_rewrite-only=${hostMismatch.onlyLeft.join(', ') || 'none'}, upstream_proxy-only=${hostMismatch.onlyRight.join(', ') || 'none'}`,
    );
  }
  if (patternMismatch.onlyLeft.length > 0 || patternMismatch.onlyRight.length > 0) {
    issues.push(
      `Host rewrite and upstream proxy host patterns differ: host_rewrite-only=${patternMismatch.onlyLeft.join(', ') || 'none'}, upstream_proxy-only=${patternMismatch.onlyRight.join(', ') || 'none'}`,
    );
  }

  const runtimeRelevantCliHosts = extractRuntimeRelevantCliHosts(cliSource);
  const unexpectedRuntimeCliHosts = runtimeRelevantCliHosts.filter(
    (hostname) => !isHostAllowed(hostname, new Set(hostRewriteHosts), hostRewritePatterns),
  );
  if (unexpectedRuntimeCliHosts.length > 0) {
    warnings.push(
      `Claude cli.js references runtime URL hosts missing from allowlists: ${unexpectedRuntimeCliHosts.join(', ')}`,
    );
  }

  const hostBridgeChecks = {
    hasHostBridgeFileReference: webcontainerHostBridgeSource.includes('host_bridge.mjs'),
    hasHostRewriteNodeOptions:
      webcontainerHostBridgeSource.includes('NODE_OPTIONS: `--require=${normalizedHomeDir}/host_rewrite.mjs`'),
    hasInputHostBridgeUrl: webcontainerHostBridgeSource.includes("INPUT_HOST_BRIDGE_URL: HOST_BRIDGE_DEFAULT_URL"),
  };
  if (!hostBridgeChecks.hasHostRewriteNodeOptions) {
    issues.push('WebContainer host bridge env is missing the host_rewrite.mjs NODE_OPTIONS injection');
  }
  if (!hostBridgeChecks.hasInputHostBridgeUrl) {
    issues.push('WebContainer host bridge env is missing INPUT_HOST_BRIDGE_URL');
  }
  if (!hostBridgeChecks.hasHostBridgeFileReference) {
    issues.push('WebContainer host bridge no longer references host_bridge.mjs');
  }

  if (!overlayJshrc.includes('export PATH="$HOME/.local/bin:$PATH"')) {
    issues.push('Overlay .jshrc no longer prepends $HOME/.local/bin to PATH');
  }
  if (!overlayJshrc.includes('npm config set prefix ~/.local')) {
    warnings.push('Overlay .jshrc no longer sets npm prefix to ~/.local');
  }

  return {
    issues,
    packageDir,
    packageFiles: packageFileChecks,
    packageVersion: packageJson.version ?? null,
    ripgrepLinks,
    runtimeRelevantCliHosts,
    unexpectedRuntimeCliHosts,
    versions: versionInfo,
    warnings,
    webcontainer: hostBridgeChecks,
    upstreamProxy: {
      hostMismatch,
      hosts: sortStrings(upstreamProxyHosts),
      patternMismatch,
      patterns: sortStrings(upstreamProxyPatterns),
    },
    hostRewrite: {
      hostMismatch,
      hosts: sortStrings(hostRewriteHosts),
      patternMismatch,
      patterns: sortStrings(hostRewritePatterns),
    },
  };
}

export function printClaudeOverlayCompatReport(report, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Claude package dir: ${report.packageDir}`);
  console.log(`Claude version: ${report.packageVersion ?? 'unknown'}`);
  console.log(
    `CLI versions: comment=${report.versions.commentVersion ?? 'missing'}, runtime=${report.versions.runtimeVersion ?? 'missing'}`,
  );

  if (report.runtimeRelevantCliHosts.length > 0) {
    console.log(`Runtime URL hosts in cli.js: ${report.runtimeRelevantCliHosts.join(', ')}`);
  }

  if (report.issues.length > 0) {
    console.log('Issues:');
    for (const issue of report.issues) {
      console.log(`- ${issue}`);
    }
  } else {
    console.log('Issues: none');
  }

  if (report.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function parseArgs(argv) {
  const options = {
    help: false,
    json: false,
    packageDir: DEFAULT_CLAUDE_PACKAGE_DIR,
    repoRoot: DEFAULT_REPO_ROOT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--package-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --package-dir');
      options.packageDir = path.resolve(value);
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

  return options;
}

function printHelp() {
  console.log('Usage: node scripts/check-claude-overlay-compat.mjs [--package-dir <path>] [--repo-root <path>] [--json]');
}

export async function runClaudeOverlayCompatCheck(options = {}) {
  const report = await collectClaudeOverlayCompatReport(options);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }

    const report = await runClaudeOverlayCompatCheck(options);
    printClaudeOverlayCompatReport(report, { json: options.json });
    process.exit(report.issues.length === 0 ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
