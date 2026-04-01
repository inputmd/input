export interface MarkdownAssetLinkRewriteResult {
  content: string;
  replacements: number;
}

const MARKDOWN_EXT_RE = /\.(?:md(?:own|wn)?|markdown)$/i;

function isMarkdownFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  return MARKDOWN_EXT_RE.test(name);
}

function dirName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
}

function splitPathSuffix(path: string): { pathWithoutSuffix: string; suffix: string } {
  const queryIdx = path.indexOf('?');
  const hashIdx = path.indexOf('#');
  const splitIdx =
    queryIdx >= 0 && hashIdx >= 0
      ? Math.min(queryIdx, hashIdx)
      : queryIdx >= 0
        ? queryIdx
        : hashIdx >= 0
          ? hashIdx
          : -1;
  if (splitIdx < 0) return { pathWithoutSuffix: path, suffix: '' };
  return { pathWithoutSuffix: path.slice(0, splitIdx), suffix: path.slice(splitIdx) };
}

function normalizeRepoPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function resolveRepoAssetPath(currentDocPath: string, src: string): string | null {
  const { pathWithoutSuffix, suffix } = splitPathSuffix(src.trim());
  if (!pathWithoutSuffix) return null;
  const pathWithBase = pathWithoutSuffix.startsWith('/')
    ? pathWithoutSuffix.slice(1)
    : `${dirName(currentDocPath)}/${pathWithoutSuffix}`;
  const normalized = normalizeRepoPath(pathWithBase);
  if (!normalized) return null;
  return `${normalized}${suffix}`;
}

function hasUriScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('//');
}

function isLocalMarkdownAssetHref(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  return !hasUriScheme(trimmed);
}

function isSameOrAncestorDirectory(candidateDir: string, targetDir: string): boolean {
  if (candidateDir === targetDir) return true;
  if (!candidateDir) return targetDir.length > 0;
  return targetDir.startsWith(`${candidateDir}/`);
}

function buildRelativeRepoPath(fromDir: string, toPath: string): string {
  const normalizedFrom = normalizeRepoPath(fromDir) ?? '';
  const normalizedTo = normalizeRepoPath(toPath);
  if (!normalizedTo) return toPath;
  const fromParts = normalizedFrom ? normalizedFrom.split('/') : [];
  const toParts = normalizedTo.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common += 1;
  const up = fromParts.length - common;
  const nextParts = [...new Array(up).fill('..'), ...toParts.slice(common)];
  return nextParts.join('/');
}

function buildReplacementDestination(
  currentDocPath: string,
  originalDestination: string,
  newAssetPath: string,
): string {
  const trimmed = originalDestination.trim();
  const { pathWithoutSuffix, suffix } = splitPathSuffix(trimmed);
  if (pathWithoutSuffix.startsWith('/')) return `/${newAssetPath}${suffix}`;

  let nextPath = buildRelativeRepoPath(dirName(currentDocPath), newAssetPath);
  if (!nextPath.startsWith('.') && (pathWithoutSuffix.startsWith('./') || pathWithoutSuffix === '.')) {
    nextPath = `./${nextPath}`;
  }
  return `${nextPath}${suffix}`;
}

function rewriteResolvedDestination(
  currentDocPath: string,
  destination: string,
  oldAssetPath: string,
  newAssetPath: string,
): string | null {
  if (!isLocalMarkdownAssetHref(destination)) return null;
  const resolved = resolveRepoAssetPath(currentDocPath, destination);
  if (!resolved) return null;
  const { pathWithoutSuffix } = splitPathSuffix(resolved);
  if (pathWithoutSuffix !== oldAssetPath) return null;
  return buildReplacementDestination(currentDocPath, destination, newAssetPath);
}

function parseInlineDestination(inner: string): { start: number; end: number; value: string } | null {
  let index = 0;
  while (index < inner.length && /\s/.test(inner[index])) index += 1;
  if (index >= inner.length) return null;

  if (inner[index] === '<') {
    const end = inner.indexOf('>', index + 1);
    if (end < 0) return null;
    return { start: index + 1, end, value: inner.slice(index + 1, end) };
  }

  const start = index;
  while (index < inner.length) {
    const ch = inner[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (/\s/.test(ch)) break;
    index += 1;
  }
  if (index <= start) return null;
  return { start, end: index, value: inner.slice(start, index) };
}

function parseReferenceDestination(remaining: string): { start: number; end: number; value: string } | null {
  let index = 0;
  while (index < remaining.length && /\s/.test(remaining[index])) index += 1;
  if (index >= remaining.length) return null;

  if (remaining[index] === '<') {
    const end = remaining.indexOf('>', index + 1);
    if (end < 0) return null;
    return { start: index + 1, end, value: remaining.slice(index + 1, end) };
  }

  const start = index;
  while (index < remaining.length) {
    const ch = remaining[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (/\s/.test(ch)) break;
    index += 1;
  }
  if (index <= start) return null;
  return { start, end: index, value: remaining.slice(start, index) };
}

export function listMarkdownFilesNearAsset(markdownPaths: string[], assetPath: string): string[] {
  const assetDir = dirName(assetPath);
  return markdownPaths
    .filter((path) => isMarkdownFileName(path))
    .filter((path) => isSameOrAncestorDirectory(dirName(path), assetDir))
    .sort((a, b) => a.localeCompare(b));
}

export function rewriteMovedAssetLinks(
  markdown: string,
  currentDocPath: string,
  oldAssetPath: string,
  newAssetPath: string,
): MarkdownAssetLinkRewriteResult {
  if (!markdown || oldAssetPath === newAssetPath) return { content: markdown, replacements: 0 };

  let replacements = 0;
  let content = markdown.replace(/(!?\[[^\]\n]*\]\()([^\n)]*)(\))/g, (match, prefix: string, inner: string, suffix) => {
    const parsed = parseInlineDestination(inner);
    if (!parsed) return match;
    const rewritten = rewriteResolvedDestination(currentDocPath, parsed.value, oldAssetPath, newAssetPath);
    if (!rewritten || rewritten === parsed.value) return match;
    replacements += 1;
    return `${prefix}${inner.slice(0, parsed.start)}${rewritten}${inner.slice(parsed.end)}${suffix}`;
  });

  content = content.replace(/^([ \t]{0,3}\[[^\]\n]+\]:[ \t]+)(.*)$/gm, (match, prefix: string, remaining: string) => {
    const parsed = parseReferenceDestination(remaining);
    if (!parsed) return match;
    const rewritten = rewriteResolvedDestination(currentDocPath, parsed.value, oldAssetPath, newAssetPath);
    if (!rewritten || rewritten === parsed.value) return match;
    replacements += 1;
    return `${prefix}${remaining.slice(0, parsed.start)}${rewritten}${remaining.slice(parsed.end)}`;
  });

  return { content, replacements };
}
