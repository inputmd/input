import type { RepoDocFile } from './document_store';
import type { RepoContents } from './github_app';
import {
  dirName,
  fileNameFromPath,
  normalizeRepoPath,
  pathDepth,
  resolveRelativeDocPath,
  safeDecodeURIComponent,
} from './path_utils';
import { encodePathForHref, isMarkdownFileName } from './util';

export interface WikiLinkResolver {
  exists: boolean;
  resolvedHref?: string;
}

export function createWikiLinkResolver(
  currentDocPath: string,
  knownPaths: string[],
): (targetPath: string) => WikiLinkResolver {
  const exactPaths = new Set<string>();
  const canonicalByLowerPath = new Map<string, string>();
  const markdownDirectoryIndexByLowerPath = new Map<string, string>();

  for (const knownPath of knownPaths) {
    const normalized = normalizeRepoPath(safeDecodeURIComponent(knownPath).trim());
    if (!normalized) continue;
    exactPaths.add(normalized);
    const lower = normalized.toLowerCase();
    if (!canonicalByLowerPath.has(lower)) canonicalByLowerPath.set(lower, normalized);
    if (lower.endsWith('/index.md')) {
      const parentPath = dirName(normalized);
      if (isMarkdownFileName(parentPath) && !markdownDirectoryIndexByLowerPath.has(parentPath.toLowerCase())) {
        markdownDirectoryIndexByLowerPath.set(parentPath.toLowerCase(), normalized);
      }
    }
  }

  return (targetPath: string) => {
    const resolvedTarget = resolveRelativeDocPath(currentDocPath, targetPath);
    if (!resolvedTarget) return { exists: false };
    if (exactPaths.has(resolvedTarget)) return { exists: true, resolvedHref: encodePathForHref(resolvedTarget) };
    const markdownDirectoryIndex = markdownDirectoryIndexByLowerPath.get(resolvedTarget.toLowerCase());
    if (markdownDirectoryIndex) return { exists: true, resolvedHref: encodePathForHref(markdownDirectoryIndex) };

    const canonical = canonicalByLowerPath.get(resolvedTarget.toLowerCase());
    if (!canonical) return { exists: false };
    return { exists: true, resolvedHref: encodePathForHref(canonical) };
  };
}

export function findMarkdownDirectoryIndexPath(contents: RepoContents, requestedPath: string): string | null {
  if (!Array.isArray(contents)) return null;
  const normalizedRequestedPath = normalizeRepoPath(safeDecodeURIComponent(requestedPath).trim());
  if (!normalizedRequestedPath) return null;
  const expectedIndexLower = `${normalizedRequestedPath}/index.md`.toLowerCase();
  for (const entry of contents) {
    if (entry.type !== 'file') continue;
    const normalizedEntryPath = normalizeRepoPath(entry.path) ?? entry.path;
    if (normalizedEntryPath.toLowerCase() === expectedIndexLower) return entry.path;
  }
  return null;
}

export function pickPreferredRepoMarkdownFile(files: RepoDocFile[]): RepoDocFile | undefined {
  if (files.length === 0) return undefined;
  const preferredByName = new Map<string, number>([
    ['index.md', 0],
    ['readme.md', 1],
  ]);
  return [...files].sort((a, b) => {
    const aPriority = preferredByName.get(fileNameFromPath(a.path).toLowerCase()) ?? Number.POSITIVE_INFINITY;
    const bPriority = preferredByName.get(fileNameFromPath(b.path).toLowerCase()) ?? Number.POSITIVE_INFINITY;
    if (aPriority !== bPriority) return aPriority - bPriority;

    const depthDifference = pathDepth(a.path) - pathDepth(b.path);
    if (depthDifference !== 0) return depthDifference;

    return a.path.localeCompare(b.path);
  })[0];
}

export interface PublicRepoRef {
  owner: string;
  repo: string;
}

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseGitHubRepoFullNameInput(value: string | null | undefined): PublicRepoRef | null {
  if (!value) return null;
  const trimmed = value.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;

  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_NAME_PATTERN.test(repo)) return null;
  return { owner, repo };
}

export function parseRepoFullName(fullName: string | null | undefined): PublicRepoRef | null {
  return parseGitHubRepoFullNameInput(fullName);
}

export function buildRepoFullName(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
