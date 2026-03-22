import { isMarkdownFileName } from './util';

export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

export function commonSuffixLength(a: string, b: string, prefixLength: number): number {
  const max = Math.min(a.length, b.length) - prefixLength;
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

export function sanitizeDroppedFileName(name: string): string {
  const trimmed = name.trim().replace(/\\/g, '/');
  const base = trimmed.split('/').filter(Boolean).at(-1) ?? '';
  return base.replace(/\0/g, '').trim();
}

export function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function sanitizeTitleToFileName(title: string, defaultNewFilename = 'index.md'): string {
  const trimmed = title
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '.');
  if (!trimmed) return defaultNewFilename;
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
}

export function fileNameFromPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

export function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

export function parentFolderPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
}

export function sanitizeScratchFileNameInput(input: string): string {
  const normalized = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized.includes('/') ||
    normalized === '.' ||
    normalized === '..' ||
    /[:<>*?"|]/.test(normalized)
  )
    return '';
  return normalized;
}

export function dirName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
}

export function splitPathSuffix(path: string): { pathWithoutSuffix: string; suffix: string } {
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

export function normalizeRepoPath(path: string): string | null {
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

export function resolveRepoAssetPath(currentDocPath: string, src: string): string | null {
  const { pathWithoutSuffix, suffix } = splitPathSuffix(src.trim());
  if (!pathWithoutSuffix) return null;
  const pathWithBase = pathWithoutSuffix.startsWith('/')
    ? pathWithoutSuffix.slice(1)
    : `${dirName(currentDocPath)}/${pathWithoutSuffix}`;
  const normalized = normalizeRepoPath(pathWithBase);
  if (!normalized) return null;
  return `${normalized}${suffix}`;
}

export function resolveRelativeDocPath(currentDocPath: string, targetPath: string): string | null {
  const { pathWithoutSuffix } = splitPathSuffix(safeDecodeURIComponent(targetPath).trim());
  if (!pathWithoutSuffix) return null;
  const pathWithBase = pathWithoutSuffix.startsWith('/')
    ? pathWithoutSuffix.slice(1)
    : `${dirName(currentDocPath)}/${pathWithoutSuffix}`;
  return normalizeRepoPath(pathWithBase);
}

export function isSidebarTextFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  return (
    isMarkdownFileName(name) ||
    /\.(txt|ts|js|py|tsx|jsx|json|jsonc|yml|yaml|toml|css|scss|html|sh|sql|xml|csv|mdx|rst)$/i.test(name)
  );
}

export function isKeepFilePath(path: string | null | undefined): boolean {
  return Boolean(path && /(?:^|\/)\.keep$/i.test(path));
}

export function isSidebarTextListPath(path: string): boolean {
  return isSidebarTextFileName(path) || isKeepFilePath(path);
}

export function isEditableTextFilePath(path: string | null | undefined): boolean {
  return Boolean(path && isSidebarTextListPath(path));
}

export function isVisibleSidebarFilePath(path: string): boolean {
  return !isKeepFilePath(path);
}

export function isSafeImageFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
}

export function isLikelyBinaryBytes(bytes: Uint8Array): boolean {
  const length = Math.min(bytes.length, 4096);
  if (length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    if (byte === 0) return true;
    const isAsciiControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    const isDel = byte === 127;
    if (isAsciiControl || isDel) suspicious++;
  }
  return suspicious / length > 0.2;
}

export function isPathInFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

export function renamePathWithNewFolder(path: string, oldFolderPath: string, newFolderPath: string): string {
  if (!isPathInFolder(path, oldFolderPath)) return path;
  if (path === oldFolderPath) return newFolderPath;
  return `${newFolderPath}/${path.slice(oldFolderPath.length + 1)}`;
}

export function folderDeleteConfirmMessage(folderPath: string, filePaths: string[]): string {
  const deleteCount = filePaths.length;
  const message = `Delete folder "${folderPath}" and ${deleteCount} file(s)?`;
  if (deleteCount === 0 || deleteCount > 2) return message;
  const names = filePaths.map((path) => `"${fileNameFromPath(path)}"`);
  const details = deleteCount === 1 ? names[0] : `${names[0]} and ${names[1]}`;
  return `${message} This will delete ${details}.`;
}
