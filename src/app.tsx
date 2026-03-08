import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseAnsiToHtml } from './ansi';
import { ApiError, isRateLimitError, rateLimitToastMessage, responseToApiError } from './api_error';
import { looksLikeClaudeExportTrace, parseClaudeExportTrace, renderClaudeTraceMarkdown } from './claude_trace';
import { useDialogs } from './components/DialogProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ImageLightbox } from './components/ImageLightbox';
import { type ReaderAiMessage, ReaderAiPanel } from './components/ReaderAiPanel';
import { Sidebar, type SidebarFileFilter } from './components/Sidebar';
import { useToast } from './components/ToastProvider';
import { type ActiveView, Toolbar } from './components/Toolbar';
import { createGistDocumentStore, createRepoDocumentStore, findRepoDocFile, type RepoDocFile } from './document_store';
import { markGistRecentlyCreated } from './gist_consistency';
import {
  clearGitHubCaches,
  createGist,
  type GistDetail,
  type GistFile,
  type GistSummary,
  type GitHubUser,
  getAuthSession,
  getGist,
  listGists,
  logout,
  updateGist,
  updateGistFiles,
} from './github';
import {
  clearGitHubAppCaches,
  clearInstallationId,
  clearPendingInstallationId,
  clearSelectedRepo,
  consumeInstallState,
  createInstallState,
  createRepoFileShareLink,
  createSession,
  deleteRepoFile,
  disconnectInstallation,
  getInstallationId,
  getInstallUrl,
  getPendingInstallationId,
  getPublicRepoContents,
  getPublicRepoTarball,
  getPublicRepoTree,
  getRepoContents,
  getRepoTarball,
  getRepoTree,
  getSelectedRepo,
  getSharedRepoFile,
  hasInstallState,
  type InstallationRepo,
  isRepoFile,
  listInstallationRepos,
  publicRepoRawFileUrl,
  putRepoFile,
  type RepoContents,
  type RepoFileEntry,
  rememberInstallState,
  repoRawFileUrl,
  SessionExpiredError,
  setInstallationId,
  setPendingInstallationId,
  setSelectedRepo as storeSelectedRepo,
  tryBuildRepoFilesFromCache,
} from './github_app';
import { useRoute } from './hooks/useRoute';
import { parseMarkdownToHtml } from './markdown';
import {
  askReaderAiStream,
  createReaderAiProjectSession,
  deleteReaderAiProjectSession,
  listReaderAiModels,
  type ReaderAiModel,
  readerAiModelPriorityRank,
  resetReaderAiProjectSession,
} from './reader_ai';
import { matchRoute, type Route, routePath } from './routing';
import { isSubdomainMode } from './subdomain';
import {
  decodeBase64ToBytes,
  encodeBytesToBase64,
  encodePathForHref,
  encodeUtf8ToBase64,
  isMarkdownFileName,
} from './util';
import { ContentView } from './views/ContentView';
import { EditView } from './views/EditView';
import { ErrorView } from './views/ErrorView';
import { LoadingView } from './views/LoadingView';
import { WorkspacesView } from './views/WorkspacesView';

const EDITOR_PREVIEW_VISIBLE_KEY = 'editor_preview_visible';
const READER_AI_VISIBLE_KEY = 'reader_ai_visible';
const READER_AI_MODEL_KEY = 'reader_ai_model';
const READER_AI_WIDTH_KEY = 'reader_ai_width_px';
const READER_AI_HISTORY_KEY = 'reader_ai_history_v1';
const SIDEBAR_WIDTH_KEY = 'sidebar_width_px';
const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';
const DRAFT_TITLE_KEY = 'draft_title';
const DRAFT_CONTENT_KEY = 'draft_content';
const DEFAULT_NEW_FILENAME = 'index.md';
const REPO_NEW_DRAFT_KEY_PREFIX = 'repo_new_draft';
const DEFAULT_SIDEBAR_WIDTH_PX = 220;
const MIN_SIDEBAR_WIDTH_PX = 180;
const MAX_SIDEBAR_WIDTH_PX = 420;
const DEFAULT_READER_AI_WIDTH_PX = 360;
const MIN_READER_AI_WIDTH_PX = 280;
const MAX_READER_AI_WIDTH_PX = 640;
const SIDEBAR_FILE_FILTER_KEY = 'sidebar_file_filter';
const PASTED_IMAGE_RESIZE_THRESHOLD_BYTES = Math.floor(1.5 * 1024 * 1024);
const PASTED_IMAGE_MAX_SIDE_PX = 1600;
const PASTED_IMAGE_QUALITY = 0.82;
const OAUTH_REDIRECT_GUARD_KEY = 'oauth_redirect_guard';
const OAUTH_REDIRECT_GUARD_WINDOW_MS = 15_000;
const AUTO_ONCE_GUARD_KEY_PREFIX = 'auto_once_guard:';
const MARKDOWN_LINK_PREVIEW_MAX_CHARS = 1800;
const MARKDOWN_LINK_PREVIEW_MAX_LINES = 18;
const READER_AI_SOURCE_MAX_CHARS = 140_000;
const READER_AI_HISTORY_MAX_ENTRIES = 12;
const READER_AI_HISTORY_MAX_MESSAGES = 80;
const LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION = `
### Input

An experimental Markdown editor, and alternative GitHub frontend.

Input is a tool for editing and publishing workspaces of Markdown files. It's like Obsidian in your browser, or HackMD for Git repos.

It supports live preview, multi-document workspaces, and \\[\\[wiki links\\]\\]. Your data is stored in your own [repos](https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories) or [gists](https://gist.github.com/) as files.

We ask for minimal permissions, and do not log your data.`;

function autoOnceGuardStorageKey(key: string): string {
  return `${AUTO_ONCE_GUARD_KEY_PREFIX}${key}`;
}

function hasAutoOnceGuard(key: string): boolean {
  try {
    return sessionStorage.getItem(autoOnceGuardStorageKey(key)) === '1';
  } catch {
    return false;
  }
}

function markAutoOnceGuard(key: string): void {
  try {
    sessionStorage.setItem(autoOnceGuardStorageKey(key), '1');
  } catch {
    // Best effort only.
  }
}

function isRepoWriteConflictError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ApiError && err.status === 409) return true;
  return /does not match|sha/i.test(err.message);
}

function isPartialRepoRenameError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /rename partially completed/i.test(err.message);
}

function repoNewDraftKey(installationId: string, repoFullName: string, field: 'title' | 'content'): string {
  return `${REPO_NEW_DRAFT_KEY_PREFIX}:${installationId}:${repoFullName}:${field}`;
}

function isTxtFileName(name: string | null | undefined): boolean {
  return Boolean(name && /\.txt$/i.test(name));
}

function isSidebarTextFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  return (
    isMarkdownFileName(name) ||
    /\.(txt|ts|js|py|tsx|jsx|json|jsonc|yml|yaml|toml|css|scss|html|sh|sql|xml|csv|mdx|rst)$/i.test(name)
  );
}

function isSafeImageFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
}

function isLikelyBinaryBytes(bytes: Uint8Array): boolean {
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

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function sanitizeTitleToFileName(title: string): string {
  const trimmed = title
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '.');
  if (!trimmed) return DEFAULT_NEW_FILENAME;
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function fileNameFromPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

function upsertRepoFile(files: RepoDocFile[], next: RepoDocFile): RepoDocFile[] {
  const existingIndex = files.findIndex((file) => file.path === next.path);
  if (existingIndex === -1) return [...files, next].sort((a, b) => a.path.localeCompare(b.path));
  const updated = [...files];
  updated[existingIndex] = next;
  return updated;
}

function isPathInFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function renamePathWithNewFolder(path: string, oldFolderPath: string, newFolderPath: string): string {
  if (!isPathInFolder(path, oldFolderPath)) return path;
  if (path === oldFolderPath) return newFolderPath;
  return `${newFolderPath}/${path.slice(oldFolderPath.length + 1)}`;
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

function createMarkdownPreviewExcerpt(content: string): { text: string; truncated: boolean } {
  if (!content) return { text: '', truncated: false };
  const normalized = content.replace(/\r\n/g, '\n');
  const allLines = normalized.split('\n');
  const lines = allLines.slice(0, MARKDOWN_LINK_PREVIEW_MAX_LINES);
  let text = lines.join('\n');
  let truncated = lines.length < allLines.length;
  if (text.length > MARKDOWN_LINK_PREVIEW_MAX_CHARS) {
    text = text.slice(0, MARKDOWN_LINK_PREVIEW_MAX_CHARS);
    truncated = true;
  }
  return { text: text.trimEnd(), truncated };
}

function removeImagesFromHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('img').forEach((img) => {
    img.remove();
  });
  return template.innerHTML;
}

function trimReaderAiSource(source: string): string {
  if (source.length <= READER_AI_SOURCE_MAX_CHARS) return source;
  return source.slice(source.length - READER_AI_SOURCE_MAX_CHARS);
}

interface ReaderAiHistoryEntry {
  messages: ReaderAiMessage[];
  summary?: string;
}

interface ReaderAiHistoryStore {
  order: string[];
  entries: Record<string, ReaderAiHistoryEntry>;
}

function buildReaderAiHistoryDocumentKey(options: {
  currentRepoDocPath: string | null;
  currentGistId: string | null;
  currentFileName: string | null;
  repoAccessMode: 'installed' | 'public' | null;
  selectedRepo: string | null;
  publicRepoRef: PublicRepoRef | null;
  route: Route;
}): string | null {
  const { currentRepoDocPath, currentGistId, currentFileName, repoAccessMode, selectedRepo, publicRepoRef, route } =
    options;

  if (currentGistId && currentFileName) {
    return `gist:${currentGistId}:${currentFileName}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'installed' && selectedRepo) {
    return `repo:${selectedRepo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (currentRepoDocPath && repoAccessMode === 'public' && publicRepoRef) {
    return `public:${publicRepoRef.owner.toLowerCase()}/${publicRepoRef.repo.toLowerCase()}:${currentRepoDocPath}`;
  }
  if (route.name === 'sharefile' && currentRepoDocPath) {
    return `share:${route.params.token}:${currentRepoDocPath}`;
  }
  return null;
}

function isReaderAiRole(value: unknown): value is ReaderAiMessage['role'] {
  return value === 'user' || value === 'assistant';
}

function normalizeReaderAiMessages(value: unknown): ReaderAiMessage[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((item): ReaderAiMessage | null => {
      if (!item || typeof item !== 'object') return null;
      const role = (item as { role?: unknown }).role;
      const content = (item as { content?: unknown }).content;
      const edited = (item as { edited?: unknown }).edited;
      if (!isReaderAiRole(role) || typeof content !== 'string') return null;
      const message: ReaderAiMessage = { role, content };
      if (edited === true) message.edited = true;
      return message;
    })
    .filter((message): message is ReaderAiMessage => message !== null);
  return normalized.slice(-READER_AI_HISTORY_MAX_MESSAGES);
}

function loadReaderAiHistoryStore(): ReaderAiHistoryStore {
  if (typeof window === 'undefined') return { order: [], entries: {} };
  try {
    const raw = localStorage.getItem(READER_AI_HISTORY_KEY);
    if (!raw) return { order: [], entries: {} };
    const parsed = JSON.parse(raw) as { order?: unknown; entries?: unknown };
    const rawEntries = parsed.entries;
    if (!rawEntries || typeof rawEntries !== 'object') return { order: [], entries: {} };
    const entries: Record<string, ReaderAiHistoryEntry> = {};
    for (const [key, value] of Object.entries(rawEntries)) {
      // Support both old format (ReaderAiMessage[]) and new format (ReaderAiHistoryEntry)
      if (Array.isArray(value)) {
        entries[key] = { messages: normalizeReaderAiMessages(value) };
      } else if (value && typeof value === 'object') {
        const entry = value as { messages?: unknown; summary?: unknown };
        entries[key] = {
          messages: normalizeReaderAiMessages(entry.messages),
          ...(typeof entry.summary === 'string' && entry.summary ? { summary: entry.summary } : {}),
        };
      }
    }
    const rawOrder = Array.isArray(parsed.order)
      ? parsed.order.filter((key): key is string => typeof key === 'string')
      : [];
    const order = rawOrder.filter((key, index) => index < READER_AI_HISTORY_MAX_ENTRIES && key in entries);
    for (const key of Object.keys(entries)) {
      if (!order.includes(key)) delete entries[key];
    }
    return { order, entries };
  } catch {
    return { order: [], entries: {} };
  }
}

function loadReaderAiEntryFromHistory(historyKey: string): ReaderAiHistoryEntry {
  const store = loadReaderAiHistoryStore();
  const entry = store.entries[historyKey] ?? { messages: [] };
  console.debug('[reader-ai] loaded history', {
    historyKey,
    messageCount: entry.messages.length,
    hasSummary: Boolean(entry.summary),
    knownKeys: store.order,
  });
  return entry;
}

function persistReaderAiMessagesToHistory(historyKey: string, messages: ReaderAiMessage[], summary?: string): void {
  if (typeof window === 'undefined') return;
  const store = loadReaderAiHistoryStore();
  const nextEntries = { ...store.entries };
  const nextOrder = store.order.filter((key) => key !== historyKey);
  const normalizedMessages = normalizeReaderAiMessages(messages);
  if (normalizedMessages.length === 0) {
    console.debug('[reader-ai] skip persist for empty messages (no explicit clear)', { historyKey });
    return;
  }
  const entry: ReaderAiHistoryEntry = { messages: normalizedMessages };
  if (summary) entry.summary = summary;
  nextEntries[historyKey] = entry;
  nextOrder.unshift(historyKey);
  const trimmedOrder = nextOrder.slice(0, READER_AI_HISTORY_MAX_ENTRIES);
  for (const key of Object.keys(nextEntries)) {
    if (!trimmedOrder.includes(key)) delete nextEntries[key];
  }
  console.debug('[reader-ai] persisting history', {
    historyKey,
    messageCount: normalizedMessages.length,
    hasSummary: Boolean(summary),
    orderLength: trimmedOrder.length,
  });
  try {
    if (trimmedOrder.length === 0) {
      localStorage.removeItem(READER_AI_HISTORY_KEY);
      const persisted = localStorage.getItem(READER_AI_HISTORY_KEY);
      console.debug('[reader-ai] persisted history clear check', {
        removed: persisted === null,
      });
      return;
    }
    const payload = JSON.stringify({ order: trimmedOrder, entries: nextEntries });
    localStorage.setItem(READER_AI_HISTORY_KEY, payload);
    const persistedRaw = localStorage.getItem(READER_AI_HISTORY_KEY);
    if (!persistedRaw) {
      console.warn('[reader-ai] persist check failed: history key missing after write', { historyKey });
      return;
    }
    const persistedStore = JSON.parse(persistedRaw) as ReaderAiHistoryStore;
    const persistedEntry = persistedStore.entries?.[historyKey];
    const persistedMessages = normalizeReaderAiMessages(persistedEntry?.messages);
    console.debug('[reader-ai] persisted history check', {
      historyKey,
      persisted: persistedMessages.length === normalizedMessages.length,
      persistedMessageCount: persistedMessages.length,
      expectedMessageCount: normalizedMessages.length,
    });
  } catch {
    console.error('[reader-ai] persist history failed', { historyKey });
  }
}

function clearReaderAiMessagesFromHistory(historyKey: string): void {
  if (typeof window === 'undefined') return;
  const store = loadReaderAiHistoryStore();
  if (!(historyKey in store.entries)) return;
  const nextEntries = { ...store.entries };
  delete nextEntries[historyKey];
  const trimmedOrder = store.order.filter((key) => key !== historyKey).slice(0, READER_AI_HISTORY_MAX_ENTRIES);
  for (const key of Object.keys(nextEntries)) {
    if (!trimmedOrder.includes(key)) delete nextEntries[key];
  }
  try {
    if (trimmedOrder.length === 0) {
      localStorage.removeItem(READER_AI_HISTORY_KEY);
      console.debug('[reader-ai] cleared history key and removed store', { historyKey });
      return;
    }
    localStorage.setItem(READER_AI_HISTORY_KEY, JSON.stringify({ order: trimmedOrder, entries: nextEntries }));
    console.debug('[reader-ai] cleared history key', { historyKey, remainingKeys: trimmedOrder });
  } catch {
    console.error('[reader-ai] clear history failed', { historyKey });
  }
}

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH_PX, Math.min(MAX_SIDEBAR_WIDTH_PX, width));
}

function clampReaderAiWidth(width: number): number {
  return Math.max(MIN_READER_AI_WIDTH_PX, Math.min(MAX_READER_AI_WIDTH_PX, width));
}

function prioritizeReaderAiModels(models: ReaderAiModel[]): ReaderAiModel[] {
  return models
    .map((model, originalIndex) => ({ model, originalIndex, rank: readerAiModelPriorityRank(model) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) {
        if (a.rank === -1) return 1;
        if (b.rank === -1) return -1;
        return a.rank - b.rank;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map(({ model }) => model);
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

function resolveRelativeDocPath(currentDocPath: string, targetPath: string): string | null {
  const { pathWithoutSuffix } = splitPathSuffix(safeDecodeURIComponent(targetPath).trim());
  if (!pathWithoutSuffix) return null;
  const pathWithBase = pathWithoutSuffix.startsWith('/')
    ? pathWithoutSuffix.slice(1)
    : `${dirName(currentDocPath)}/${pathWithoutSuffix}`;
  return normalizeRepoPath(pathWithBase);
}

interface WikiLinkResolver {
  exists: boolean;
  resolvedHref?: string;
}

function createWikiLinkResolver(
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

function findMarkdownDirectoryIndexPath(contents: RepoContents, requestedPath: string): string | null {
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

function pickPreferredRepoMarkdownFile(files: RepoDocFile[]): RepoDocFile | undefined {
  if (files.length === 0) return undefined;
  const preferredByName = ['index.md', 'readme.md'];
  for (const preferredName of preferredByName) {
    const preferred = files.find((file) => fileNameFromPath(file.path).toLowerCase() === preferredName);
    if (preferred) return preferred;
  }
  return files[0];
}

interface PublicRepoRef {
  owner: string;
  repo: string;
}

function parseRepoFullName(fullName: string | null | undefined): PublicRepoRef | null {
  if (!fullName) return null;
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function buildRepoFullName(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

interface GoToWorkspaceTarget {
  filePath: string;
  repo: InstallationRepo;
}

interface MarkdownRepoSourceContext {
  mode: 'installed' | 'public';
  installationId?: string | null;
  selectedRepo?: string | null;
  publicRepoRef?: PublicRepoRef | null;
}

interface PendingImageUpload {
  id: string;
  installationId: string;
  repoFullName: string;
  imageName: string;
  imageRepoPath: string;
  contentB64: string;
  resized: boolean;
  uploadingToken: string;
  failedToken: string;
  finalMarkdown: string;
}

function extensionFromMimeType(mimeType: string): string {
  const mimeExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return mimeExt[mimeType] ?? 'png';
}

function isResizableImageType(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg' || mimeType === 'image/webp';
}

async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

async function maybeResizePastedImage(file: File): Promise<{ bytes: Uint8Array; extension: string; resized: boolean }> {
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const originalExtension = extensionFromMimeType(file.type);

  if (file.size <= PASTED_IMAGE_RESIZE_THRESHOLD_BYTES || !isResizableImageType(file.type)) {
    return { bytes: originalBytes, extension: originalExtension, resized: false };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const scale = longest > PASTED_IMAGE_MAX_SIDE_PX ? PASTED_IMAGE_MAX_SIDE_PX / longest : 1;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return { bytes: originalBytes, extension: originalExtension, resized: false };
    }
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const outputMimeType = file.type === 'image/jpeg' || file.type === 'image/jpg' ? 'image/jpeg' : 'image/webp';
    const resizedBlob = await canvasToBlob(canvas, outputMimeType, PASTED_IMAGE_QUALITY);
    if (!resizedBlob) return { bytes: originalBytes, extension: originalExtension, resized: false };

    const resizedBytes = new Uint8Array(await resizedBlob.arrayBuffer());
    if (resizedBytes.length >= originalBytes.length) {
      return { bytes: originalBytes, extension: originalExtension, resized: false };
    }

    return { bytes: resizedBytes, extension: extensionFromMimeType(outputMimeType), resized: true };
  } catch {
    return { bytes: originalBytes, extension: originalExtension, resized: false };
  }
}

function replaceFirst(source: string, needle: string, replacement: string): string {
  const index = source.indexOf(needle);
  if (index === -1) return source;
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

function viewFromRoute(route: Route): ActiveView {
  switch (route.name) {
    case 'workspaces':
      return 'workspaces';
    case 'repofile':
    case 'sharefile':
    case 'gist':
      return 'content';
    default:
      return 'edit';
  }
}

export function App() {
  const { route, navigate } = useRoute();
  const { showAlert, showConfirm } = useDialogs();
  const { showSuccessToast, showFailureToast, showLoadingToast, dismissToast } = useToast();

  // --- Shared state ---
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [installationId, setInstId] = useState<string | null>(getInstallationId());
  const [selectedRepo, setSelectedRepo] = useState<string | null>(getSelectedRepo()?.full_name ?? null);
  const [selectedRepoPrivate, setSelectedRepoPrivate] = useState<boolean | null>(getSelectedRepo()?.private ?? null);
  const [publicRepoRef, setPublicRepoRef] = useState<PublicRepoRef | null>(null);
  const [repoAccessMode, setRepoAccessMode] = useState<'installed' | 'public' | null>(null);
  const [installationRepos, setInstallationRepos] = useState<InstallationRepo[]>([]);
  const [installationReposLoading, setInstallationReposLoading] = useState(false);
  const [loadedReposInstallationId, setLoadedReposInstallationId] = useState<string | null>(null);
  const [autoLoadAttemptedReposInstallationId, setAutoLoadAttemptedReposInstallationId] = useState<string | null>(null);
  const [reposLoadError, setReposLoadError] = useState<string | null>(null);
  const [menuGists, setMenuGists] = useState<GistSummary[]>([]);
  const [menuGistsLoading, setMenuGistsLoading] = useState(false);
  const [menuGistsLoaded, setMenuGistsLoaded] = useState(false);
  const [autoLoadAttemptedGists, setAutoLoadAttemptedGists] = useState(false);
  const [gistsLoadError, setGistsLoadError] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);

  // --- View state ---
  const [viewPhase, setViewPhase] = useState<'loading' | 'error' | null>('loading');
  const [renderedHtml, setRenderedHtml] = useState('');
  const [renderMode, setRenderMode] = useState<'ansi' | 'markdown' | 'image'>('ansi');
  const [contentLoadPending, setContentLoadPending] = useState(false);
  const [contentImagePreview, setContentImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const [isClaudeTranscript, setIsClaudeTranscript] = useState(false);
  const [contentAlertMessage, setContentAlertMessage] = useState<string | null>(null);
  const [contentAlertDownloadHref, setContentAlertDownloadHref] = useState<string | null>(null);
  const [contentAlertDownloadName, setContentAlertDownloadName] = useState<string | null>(null);
  const [readerAiVisible, setReaderAiVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(READER_AI_VISIBLE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [readerAiSource, setReaderAiSource] = useState('');
  const [readerAiModels, setReaderAiModels] = useState<ReaderAiModel[]>([]);
  const [readerAiModelsLoading, setReaderAiModelsLoading] = useState(false);
  const [readerAiModelsError, setReaderAiModelsError] = useState<string | null>(null);
  const [readerAiConfigured, setReaderAiConfigured] = useState(true);
  const [readerAiSelectedModel, setReaderAiSelectedModel] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return localStorage.getItem(READER_AI_MODEL_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [readerAiWidth, setReaderAiWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_READER_AI_WIDTH_PX;
    try {
      const raw = Number(localStorage.getItem(READER_AI_WIDTH_KEY));
      if (Number.isFinite(raw)) return clampReaderAiWidth(raw);
    } catch {}
    return DEFAULT_READER_AI_WIDTH_PX;
  });
  const [readerAiMessages, setReaderAiMessages] = useState<ReaderAiMessage[]>([]);
  const [readerAiSummary, setReaderAiSummary] = useState<string>('');
  const [readerAiSending, setReaderAiSending] = useState(false);
  const [readerAiToolStatus, setReaderAiToolStatus] = useState<string | null>(null);
  const [readerAiToolLog, setReaderAiToolLog] = useState<
    Array<{ type: 'call' | 'result'; name: string; detail?: string }>
  >([]);
  const [readerAiStagedChanges, setReaderAiStagedChanges] = useState<
    Array<{ path: string; type: 'edit' | 'create' | 'delete'; diff: string }>
  >([]);
  const [readerAiApplyingChanges, setReaderAiApplyingChanges] = useState(false);
  const [readerAiError, setReaderAiError] = useState<string | null>(null);
  const [readerAiRepoMode, setReaderAiRepoMode] = useState(false);
  const [readerAiRepoModeLoading, setReaderAiRepoModeLoading] = useState(false);
  const [readerAiRepoFiles, setReaderAiRepoFiles] = useState<RepoFileEntry[] | null>(null);
  const [readerAiProjectId, setReaderAiProjectId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [currentGistId, setCurrentGistId] = useState<string | null>(null);
  const [currentRepoDocPath, setCurrentRepoDocPath] = useState<string | null>(null);
  const [currentRepoDocSha, setCurrentRepoDocSha] = useState<string | null>(null);
  const [editingBackend, setEditingBackend] = useState<'gist' | 'repo' | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [draftMode, setDraftMode] = useState(false);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [gistFiles, setGistFiles] = useState<Record<string, GistFile> | null>(null);
  const [repoFiles, setRepoFiles] = useState<RepoDocFile[]>([]);
  const [repoSidebarFiles, setRepoSidebarFiles] = useState<RepoDocFile[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [failedImageUpload, setFailedImageUpload] = useState<PendingImageUpload | null>(null);
  const [sidebarVisibilityOverride, setSidebarVisibilityOverride] = useState<boolean | null>(null);
  const [sidebarFileFilter, setSidebarFileFilter] = useState<SidebarFileFilter>(() => {
    if (typeof window === 'undefined') return 'text';
    try {
      const saved = localStorage.getItem(SIDEBAR_FILE_FILTER_KEY);
      if (saved === 'all') return 'all';
      return 'text';
    } catch {
      return 'text';
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH_PX;
    try {
      const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      if (Number.isFinite(raw)) return clampSidebarWidth(raw);
    } catch {}
    return DEFAULT_SIDEBAR_WIDTH_PX;
  });
  const [previewVisible, setPreviewVisible] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && !window.matchMedia(DESKTOP_MEDIA_QUERY).matches) {
      return false;
    }
    try {
      return localStorage.getItem(EDITOR_PREVIEW_VISIBLE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [isDesktopWidth, setIsDesktopWidth] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
  });
  const defaultPreviewVisible = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
  }, []);

  // Track initialization
  const initialized = useRef(false);
  const markdownLinkPreviewCacheRef = useRef(new Map<string, { title: string; html: string } | null>());
  const markdownLinkPreviewPendingRef = useRef(new Map<string, Promise<{ title: string; html: string } | null>>());
  const readerAiAbortRef = useRef<AbortController | null>(null);
  const readerAiPrevHistoryKeyRef = useRef<string | null>(null);
  const readerAiSkipPersistHistoryKeyRef = useRef<string | null>(null);
  const activeView = viewPhase ?? viewFromRoute(route);
  const readerAiHistoryDocumentKey = useMemo(
    () =>
      buildReaderAiHistoryDocumentKey({
        currentRepoDocPath,
        currentGistId,
        currentFileName,
        repoAccessMode,
        selectedRepo,
        publicRepoRef,
        route,
      }),
    [currentRepoDocPath, currentGistId, currentFileName, repoAccessMode, selectedRepo, publicRepoRef, route],
  );
  const isContentRoute = useCallback((nextRoute: Route) => {
    return nextRoute.name === 'gist' || nextRoute.name === 'repofile' || nextRoute.name === 'sharefile';
  }, []);

  const clearRenderedContent = useCallback(() => {
    setRenderedHtml('');
    setRenderMode('ansi');
    setIsClaudeTranscript(false);
    setReaderAiSource('');
    setContentImagePreview(null);
    setContentAlertMessage(null);
    setContentAlertDownloadHref(null);
    setContentAlertDownloadName(null);
  }, []);

  // --- Helpers ---
  const showError = useCallback((msg: string) => {
    setErrorMessage(msg);
    setViewPhase('error');
  }, []);
  const showRateLimitToastIfNeeded = useCallback(
    (err: unknown) => {
      if (isRateLimitError(err)) {
        showFailureToast(rateLimitToastMessage(err));
      }
    },
    [showFailureToast],
  );

  const clearMarkdownLinkPreviewCache = useCallback(() => {
    markdownLinkPreviewCacheRef.current.clear();
    markdownLinkPreviewPendingRef.current.clear();
  }, []);

  const clearOAuthRedirectGuard = useCallback(() => {
    try {
      sessionStorage.removeItem(OAUTH_REDIRECT_GUARD_KEY);
    } catch {}
  }, []);

  const startGitHubSignIn = useCallback(
    (returnTo: string, options?: { force?: boolean; guardKey?: string }) => {
      const normalizedReturnTo = returnTo.startsWith('/') ? returnTo : `/${returnTo}`;
      const currentPath = window.location.pathname;
      try {
        if (!options?.force && options?.guardKey) {
          if (hasAutoOnceGuard(options.guardKey)) return false;
          markAutoOnceGuard(options.guardKey);
        }
        if (!options?.force) {
          const raw = sessionStorage.getItem(OAUTH_REDIRECT_GUARD_KEY);
          if (raw) {
            const guard = JSON.parse(raw) as { at?: unknown; fromPath?: unknown; returnTo?: unknown };
            if (
              typeof guard.at === 'number' &&
              typeof guard.fromPath === 'string' &&
              typeof guard.returnTo === 'string' &&
              guard.fromPath === currentPath &&
              guard.returnTo === normalizedReturnTo &&
              Date.now() - guard.at < OAUTH_REDIRECT_GUARD_WINDOW_MS
            ) {
              showError('Sign-in redirect loop detected. Please refresh and try again.');
              return false;
            }
          }
        }
        sessionStorage.setItem(
          OAUTH_REDIRECT_GUARD_KEY,
          JSON.stringify({
            at: Date.now(),
            fromPath: currentPath,
            returnTo: normalizedReturnTo,
          }),
        );
      } catch {
        // Best effort only; continue with OAuth redirect.
      }
      window.location.assign(`/api/auth/github/start?return_to=${encodeURIComponent(normalizedReturnTo)}`);
      return true;
    },
    [showError],
  );

  const handleSessionExpired = useCallback(() => {
    clearInstallationId();
    clearSelectedRepo();
    setUser(null);
    setInstId(null);
    setSelectedRepo(null);
    setSelectedRepoPrivate(null);
    setRepoAccessMode(null);
    setPublicRepoRef(null);
    setRepoFiles([]);
    setRepoSidebarFiles([]);
    setErrorMessage('Session expired. Sign in with GitHub from the header to continue.');
    setViewPhase('error');
  }, []);

  const focusEditorSoon = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('.doc-editor')?.focus();
      });
    });
  }, []);

  const resolveMarkdownImageSrc = useCallback(
    (src: string, repoDocPath: string | null, repoSource?: MarkdownRepoSourceContext): string | null => {
      const normalizedSrc = src.trim();
      if (!normalizedSrc) return null;
      if (!repoDocPath) return normalizedSrc;
      if (normalizedSrc.startsWith('#') || normalizedSrc.startsWith('?')) return normalizedSrc;

      const protocolMatch = normalizedSrc.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
      if (protocolMatch) return normalizedSrc;

      const resolvedPath = resolveRepoAssetPath(repoDocPath, normalizedSrc);
      if (!resolvedPath) return normalizedSrc;
      const effectiveMode = repoSource?.mode ?? repoAccessMode;
      if (effectiveMode === 'installed') {
        const effectiveSelectedRepo = repoSource?.selectedRepo ?? selectedRepo;
        const effectiveInstallationId = repoSource?.installationId ?? installationId;
        if (effectiveSelectedRepo && effectiveInstallationId) {
          return repoRawFileUrl(effectiveInstallationId, effectiveSelectedRepo, resolvedPath);
        }
      }
      if (effectiveMode === 'public') {
        const effectivePublicRepoRef = repoSource?.publicRepoRef ?? publicRepoRef;
        if (effectivePublicRepoRef) {
          return publicRepoRawFileUrl(effectivePublicRepoRef.owner, effectivePublicRepoRef.repo, resolvedPath);
        }
      }
      return normalizedSrc;
    },
    [installationId, publicRepoRef, repoAccessMode, selectedRepo],
  );

  const renderDocumentContent = useCallback(
    (
      content: string,
      fileName: string | null | undefined,
      repoDocPath: string | null = null,
      repoSource?: MarkdownRepoSourceContext,
      wikiLinkContext?: { currentDocPath: string; knownMarkdownPaths: string[] },
    ) => {
      if (isMarkdownFileName(fileName)) {
        setIsClaudeTranscript(false);
        setReaderAiSource(content);

        setContentImagePreview(null);
        setContentAlertMessage(null);
        setContentAlertDownloadHref(null);
        setContentAlertDownloadName(null);
        const wikiLinkResolver =
          wikiLinkContext && wikiLinkContext.knownMarkdownPaths.length > 0
            ? createWikiLinkResolver(wikiLinkContext.currentDocPath, wikiLinkContext.knownMarkdownPaths)
            : undefined;

        setRenderedHtml(
          parseMarkdownToHtml(content, {
            resolveImageSrc: (src) => resolveMarkdownImageSrc(src, repoDocPath, repoSource),
            resolveWikiLinkMeta: wikiLinkResolver,
          }),
        );
        setRenderMode('markdown');
        setContentLoadPending(false);
        return;
      }
      if (isTxtFileName(fileName) && looksLikeClaudeExportTrace(content)) {
        const parsed = parseClaudeExportTrace(content, fileName ?? undefined);
        const markdown = renderClaudeTraceMarkdown(parsed);
        setRenderedHtml(parseMarkdownToHtml(markdown, { breaks: false, claudeTranscript: true }));
        setRenderMode('markdown');
        setIsClaudeTranscript(true);
        setReaderAiSource(content);

        setContentImagePreview(null);
        setContentAlertMessage(
          'This is a Claude Code export. Use ↑/↓ to move between messages and ←/→ to jump between user messages.',
        );
        setContentAlertDownloadHref(null);
        setContentAlertDownloadName(null);
        setContentLoadPending(false);
        return;
      }
      setRenderedHtml(parseAnsiToHtml(content));
      setRenderMode('ansi');
      setIsClaudeTranscript(false);
      setReaderAiSource('');
      setContentImagePreview(null);
      setContentAlertMessage(null);
      setContentAlertDownloadHref(null);
      setContentAlertDownloadName(null);
      setContentLoadPending(false);
    },
    [resolveMarkdownImageSrc],
  );

  const renderImageFileContent = useCallback((fileName: string | null | undefined, imageSrc: string) => {
    setRenderedHtml('');
    setRenderMode('image');
    setIsClaudeTranscript(false);
    setReaderAiSource('');
    setContentImagePreview({ src: imageSrc, alt: fileName ?? 'Image' });
    setContentAlertMessage(null);
    setContentAlertDownloadHref(null);
    setContentAlertDownloadName(null);
    setContentLoadPending(false);
  }, []);

  const renderBinaryFileContent = useCallback(
    (fileName: string | null | undefined, downloadHref: string | null = null) => {
      const label = fileName || 'file';
      setRenderedHtml(parseAnsiToHtml(`Binary file preview is not supported for ${label}.`));
      setRenderMode('ansi');
      setIsClaudeTranscript(false);
      setReaderAiSource('');
      setContentImagePreview(null);
      setContentAlertMessage('Binary file detected.');
      setContentAlertDownloadHref(downloadHref);
      setContentAlertDownloadName(fileName ?? null);
      setContentLoadPending(false);
    },
    [],
  );

  const onRequestMarkdownLinkPreview = useCallback(
    async (rawRoute: string): Promise<{ title: string; html: string } | null> => {
      const routePathname = rawRoute.replace(/^\/+/, '');
      if (!routePathname) return null;

      if (markdownLinkPreviewCacheRef.current.has(routePathname)) {
        return markdownLinkPreviewCacheRef.current.get(routePathname) ?? null;
      }
      const pending = markdownLinkPreviewPendingRef.current.get(routePathname);
      if (pending) return pending;

      const load = (async (): Promise<{ title: string; html: string } | null> => {
        const routeCandidate = matchRoute(routePathname);
        let title = '';
        let content = '';

        if (routeCandidate.name === 'repoedit' || routeCandidate.name === 'repofile') {
          const owner = safeDecodeURIComponent(routeCandidate.params.owner);
          const repo = safeDecodeURIComponent(routeCandidate.params.repo);
          const path = safeDecodeURIComponent(routeCandidate.params.path).replace(/^\/+/, '');
          if (!isMarkdownFileName(path)) return null;
          const repoFullName = buildRepoFullName(owner, repo);
          const selectedRepoFullName = getSelectedRepo()?.full_name ?? selectedRepo;
          const isInstalledRoute =
            routeCandidate.name === 'repoedit' ||
            (selectedRepoFullName !== null && selectedRepoFullName.toLowerCase() === repoFullName.toLowerCase());
          const instId = getInstallationId();
          const loaded =
            isInstalledRoute && instId
              ? await getRepoContents(instId, repoFullName, path)
              : await getPublicRepoContents(owner, repo, path);
          if (!isRepoFile(loaded) || typeof loaded.content !== 'string' || loaded.encoding !== 'base64') return null;
          const bytes = decodeBase64ToBytes(loaded.content);
          if (isLikelyBinaryBytes(bytes)) return null;
          content = new TextDecoder().decode(bytes);
          title = loaded.name ?? fileNameFromPath(loaded.path);
        } else if (routeCandidate.name === 'gist') {
          const gistId = routeCandidate.params.id;
          const filename = routeCandidate.params.filename ? safeDecodeURIComponent(routeCandidate.params.filename) : '';
          if (!filename || !isMarkdownFileName(filename)) return null;

          let file = currentGistId === gistId ? gistFiles?.[filename] : undefined;
          if (!file) {
            if (user) {
              const gist = await getGist(gistId);
              file = gist.files[filename];
            } else {
              const res = await fetch(`/api/gists/${encodeURIComponent(gistId)}`);
              if (!res.ok) return null;
              const data = (await res.json()) as { files?: Record<string, GistFile> } | null;
              file = data?.files?.[filename];
            }
          }
          if (!file || isSafeImageFileName(file.filename)) return null;
          content = file.content ?? '';
          if (!content && file.raw_url) {
            try {
              const raw = await fetch(file.raw_url, { redirect: 'error' });
              if (raw.ok) content = await raw.text();
            } catch {
              return null;
            }
          }
          title = file.filename;
        } else {
          return null;
        }

        const excerpt = createMarkdownPreviewExcerpt(content);
        if (!excerpt.text) return null;
        const previewSource = excerpt.truncated ? `${excerpt.text}\n\n…` : excerpt.text;
        const html = parseMarkdownToHtml(previewSource, {
          breaks: false,
          resolveImageSrc: () => null,
        });
        const preview = { title, html: removeImagesFromHtml(html) };
        markdownLinkPreviewCacheRef.current.set(routePathname, preview);
        return preview;
      })();

      markdownLinkPreviewPendingRef.current.set(routePathname, load);
      try {
        const result = await load;
        if (!result) {
          markdownLinkPreviewCacheRef.current.set(routePathname, null);
        }
        return result;
      } catch {
        markdownLinkPreviewCacheRef.current.set(routePathname, null);
        return null;
      } finally {
        markdownLinkPreviewPendingRef.current.delete(routePathname);
      }
    },
    [currentGistId, gistFiles, selectedRepo, user],
  );

  useEffect(() => {
    return () => {
      if (contentAlertDownloadHref?.startsWith('blob:')) {
        URL.revokeObjectURL(contentAlertDownloadHref);
      }
    };
  }, [contentAlertDownloadHref]);

  useEffect(() => {
    return () => {
      if (contentImagePreview?.src.startsWith('blob:')) {
        URL.revokeObjectURL(contentImagePreview.src);
      }
    };
  }, [contentImagePreview]);

  const runPendingImageUpload = useCallback(
    async (upload: PendingImageUpload) => {
      const uploadToastId = showLoadingToast('Uploading image...');
      try {
        await putRepoFile(
          upload.installationId,
          upload.repoFullName,
          upload.imageRepoPath,
          `Add image ${upload.imageName}`,
          upload.contentB64,
        );
        setEditContent((prev) => {
          let next = replaceFirst(prev, upload.uploadingToken, upload.finalMarkdown);
          next = replaceFirst(next, upload.failedToken, upload.finalMarkdown);
          return next;
        });
        setFailedImageUpload((prev) => (prev?.id === upload.id ? null : prev));
        setHasUnsavedChanges(true);
        showSuccessToast(upload.resized ? 'Image resized and uploaded' : 'Image uploaded');
      } catch (err) {
        setEditContent((prev) => replaceFirst(prev, upload.uploadingToken, upload.failedToken));
        setFailedImageUpload(upload);
        if (isRateLimitError(err)) {
          showFailureToast(rateLimitToastMessage(err));
          return;
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        showFailureToast(`Image upload failed: ${message}`);
      } finally {
        dismissToast(uploadToastId);
      }
    },
    [dismissToast, showFailureToast, showLoadingToast, showSuccessToast],
  );

  const onRetryFailedImageUpload = useCallback(() => {
    if (!failedImageUpload) return;
    let replaced = false;
    setEditContent((prev) => {
      const next = replaceFirst(prev, failedImageUpload.failedToken, failedImageUpload.uploadingToken);
      replaced = next !== prev;
      return next;
    });
    if (!replaced) {
      showFailureToast('Could not find failed upload placeholder in the editor.');
      return;
    }
    setFailedImageUpload(null);
    void runPendingImageUpload(failedImageUpload);
  }, [failedImageUpload, runPendingImageUpload, showFailureToast]);

  const onRemoveFailedImageUploadPlaceholder = useCallback(() => {
    if (!failedImageUpload) return;
    setEditContent((prev) => replaceFirst(prev, failedImageUpload.failedToken, ''));
    setFailedImageUpload(null);
    setHasUnsavedChanges(true);
  }, [failedImageUpload]);

  const handleEditorPaste = useCallback(
    async (event: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => {
      const editor = event.currentTarget;
      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const imageItem = clipboardItems.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
      if (!imageItem) return;

      event.preventDefault();

      if (editingBackend !== 'repo' || !currentRepoDocPath || !selectedRepo || !installationId) {
        showFailureToast('Save your document before uploading images');
        return;
      }

      const file = imageItem.getAsFile();
      if (!file) {
        showFailureToast('Failed to read pasted image.');
        return;
      }
      try {
        const processed = await maybeResizePastedImage(file);
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const imageName = `pasted-${stamp}-${Math.random().toString(36).slice(2, 8)}.${processed.extension}`;
        const docDir = dirName(currentRepoDocPath);
        const assetDir = docDir ? `${docDir}/.assets` : '.assets';
        const imageRepoPath = `${assetDir}/${imageName}`;
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const uploadingToken = `[image-upload:${uploadId}:pending:${imageName}]`;
        const failedToken = `[image-upload:${uploadId}:failed:${imageName}]`;
        const finalMarkdown = `![${imageName}](./.assets/${imageName})`;

        const currentValue = editor.value;
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const next = `${currentValue.slice(0, start)}${uploadingToken}${currentValue.slice(end)}`;
        setEditContent(next);
        setHasUnsavedChanges(true);

        const upload: PendingImageUpload = {
          id: uploadId,
          installationId,
          repoFullName: selectedRepo,
          imageName,
          imageRepoPath,
          contentB64: encodeBytesToBase64(processed.bytes),
          resized: processed.resized,
          uploadingToken,
          failedToken,
          finalMarkdown,
        };
        setFailedImageUpload((prev) => (prev?.id === upload.id ? null : prev));
        void runPendingImageUpload(upload);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to process pasted image.';
        showFailureToast(message);
      }
    },
    [currentRepoDocPath, editingBackend, installationId, runPendingImageUpload, selectedRepo, showFailureToast],
  );

  // --- Auth ---
  // Returns whether auth is present and whether it navigated away from the current route.
  const tryRestoreAuth = useCallback(async (): Promise<{ authenticated: boolean; navigated: boolean }> => {
    try {
      const session = await getAuthSession();
      if (!session.authenticated || !session.user) {
        setUser(null);
        clearInstallationId();
        clearSelectedRepo();
        setInstId(null);
        setSelectedRepo(null);
        setSelectedRepoPrivate(null);
        return { authenticated: false, navigated: false };
      }
      clearOAuthRedirectGuard();
      setUser(session.user);
      const pendingInstallationId = getPendingInstallationId();
      if (pendingInstallationId) {
        try {
          await createSession(pendingInstallationId);
          setInstallationId(pendingInstallationId);
          setInstId(pendingInstallationId);
          clearPendingInstallationId();
          setWorkspaceNotice('GitHub App installation connected. Review your installation details below.');
        } catch (err) {
          if (!(err instanceof Error && err.message === 'Unauthorized')) {
            clearPendingInstallationId();
          }
        }
      }
      if (session.installationId) {
        setInstallationId(session.installationId);
        setInstId(session.installationId);
      } else {
        clearInstallationId();
        setInstId(null);
        setInstallationRepos([]);
        setLoadedReposInstallationId(null);
      }
      return { authenticated: true, navigated: false };
    } catch {
      setUser(null);
      return { authenticated: false, navigated: false };
    }
  }, [clearOAuthRedirectGuard]);

  // --- GitHub App redirect ---
  const tryHandleGitHubAppSetupRedirect = useCallback(async (): Promise<boolean> => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('installation_id');
    if (!id) return false;

    const actualState = params.get('state');
    if (!hasInstallState(actualState)) {
      showError('GitHub App install state mismatch. Please try again.');
      return true;
    }

    try {
      const session = await getAuthSession();
      if (!session.authenticated) {
        setPendingInstallationId(id);
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        const started = startGitHubSignIn(`/${routePath.workspaces()}`, { guardKey: `oauth_install_setup:${id}` });
        if (!started) {
          showError(
            'Automatic sign-in retry was blocked after a failed install setup. Use Sign in with GitHub to retry.',
          );
        }
        return true;
      }
      await createSession(id);
    } catch (err) {
      showRateLimitToastIfNeeded(err);
      if (err instanceof Error && err.message === 'Unauthorized') {
        setPendingInstallationId(id);
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        const started = startGitHubSignIn(`/${routePath.workspaces()}`, { guardKey: `oauth_install_setup:${id}` });
        if (!started) {
          showError(
            'Automatic sign-in retry was blocked after a failed install setup. Use Sign in with GitHub to retry.',
          );
        }
        return true;
      }
      showError(err instanceof Error ? err.message : 'Failed to create session');
      return true;
    }

    consumeInstallState(actualState);
    setInstallationId(id);
    setInstId(id);
    setWorkspaceNotice('GitHub App installation setup complete. Review your installation details below.');

    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    navigate(routePath.workspaces());
    return true;
  }, [navigate, showError, showRateLimitToastIfNeeded, startGitHubSignIn]);

  const onConnectInstallation = useCallback(async () => {
    try {
      const state = createInstallState();
      rememberInstallState(state);
      const url = await getInstallUrl(state);
      window.location.assign(url);
    } catch (err) {
      showRateLimitToastIfNeeded(err);
      void showAlert(err instanceof Error ? err.message : 'Failed to start GitHub App install');
    }
  }, [showAlert, showRateLimitToastIfNeeded]);

  // --- Helpers ---
  const loadRepoMarkdownFiles = useCallback(async (instId: string, repoName: string): Promise<RepoDocFile[]> => {
    const result = await getRepoTree(instId, repoName);
    return result.files;
  }, []);

  const loadRepoAllFiles = useCallback(async (instId: string, repoName: string): Promise<RepoDocFile[]> => {
    const result = await getRepoTree(instId, repoName, undefined, false);
    return result.files;
  }, []);

  const loadPublicRepoMarkdownFiles = useCallback(async (owner: string, repo: string): Promise<RepoDocFile[]> => {
    const result = await getPublicRepoTree(owner, repo);
    return result.files;
  }, []);

  const loadPublicRepoAllFiles = useCallback(async (owner: string, repo: string): Promise<RepoDocFile[]> => {
    const result = await getPublicRepoTree(owner, repo, undefined, false);
    return result.files;
  }, []);

  // --- Data loaders ---
  const loadGist = useCallback(
    async (id: string, filename: string | undefined, anonymous: boolean) => {
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        if (anonymous) {
          let res = await fetch(`https://api.github.com/gists/${encodeURIComponent(id)}`);
          if (!res.ok) {
            console.warn(`GitHub API failed (${res.status}), falling back to gist proxy`);
            res = await fetch(`/api/gists/${encodeURIComponent(id)}`);
          }
          if (!res.ok) throw await responseToApiError(res);
          const data = await res.json();
          const files = data.files as Record<string, GistFile>;
          setGistFiles(files);

          const fileKeys = Object.keys(files);
          const targetName = filename ? safeDecodeURIComponent(filename) : fileKeys[0];
          const file = targetName ? files[targetName] : null;
          if (!file) {
            showError('File not found in gist');
            return;
          }

          let content = file.content;
          if (
            !isSafeImageFileName(file.filename) &&
            content == null &&
            file.raw_url &&
            new URL(file.raw_url).hostname === 'gist.githubusercontent.com'
          ) {
            const raw = await fetch(file.raw_url, { redirect: 'error' });
            if (raw.ok) content = await raw.text();
            if (content != null) {
              const updated = { ...files, [file.filename]: { ...file, content } };
              setGistFiles(updated);
            }
          }

          setCurrentFileName(file.filename);
          if (isSafeImageFileName(file.filename)) {
            renderImageFileContent(file.filename, file.raw_url);
          } else {
            renderDocumentContent(content ?? '', file.filename, null, undefined, {
              currentDocPath: file.filename,
              knownMarkdownPaths: fileKeys,
            });
          }
          setCurrentGistId(id);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setRepoFiles([]);
          setRepoSidebarFiles([]);
          setViewPhase(null);
          return;
        }

        const gist = await getGist(id);
        setGistFiles(gist.files);

        const fileKeys = Object.keys(gist.files);
        const targetName = filename ? safeDecodeURIComponent(filename) : fileKeys[0];
        const file = targetName ? gist.files[targetName] : null;
        if (!file) {
          showError('File not found in gist');
          return;
        }

        setCurrentFileName(file.filename);
        setCurrentGistId(gist.id);
        setRepoAccessMode(null);
        setPublicRepoRef(null);
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setRepoFiles([]);
        setRepoSidebarFiles([]);
        if (isSafeImageFileName(file.filename)) {
          renderImageFileContent(file.filename, file.raw_url);
        } else {
          renderDocumentContent(file.content ?? '', file.filename, null, undefined, {
            currentDocPath: file.filename,
            knownMarkdownPaths: fileKeys,
          });
        }
        setViewPhase(null);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Unknown error');
      }
    },
    [showError, renderDocumentContent, renderImageFileContent, activeView, currentFileName, showRateLimitToastIfNeeded],
  );

  const loadRepoFile = useCallback(
    async (owner: string, repo: string, path: string, forEdit: boolean) => {
      const instId = getInstallationId();
      const repoName = buildRepoFullName(owner, repo);
      if (!instId) {
        navigate(routePath.workspaces());
        return;
      }
      const currentSelectedRepo = getSelectedRepo()?.full_name ?? null;
      if (!currentSelectedRepo || currentSelectedRepo.toLowerCase() !== repoName.toLowerCase()) {
        setSelectedRepo(repoName);
        storeSelectedRepo({ full_name: repoName });
      }
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        let contents = await getRepoContents(instId, repoName, path);
        if (!isRepoFile(contents)) {
          const markdownDirectoryIndex = findMarkdownDirectoryIndexPath(contents, path);
          if (markdownDirectoryIndex) contents = await getRepoContents(instId, repoName, markdownDirectoryIndex);
        }
        if (!isRepoFile(contents)) throw new Error('Expected a file');
        const contentBytes = contents.content ? decodeBase64ToBytes(contents.content) : new Uint8Array();
        const binary = isLikelyBinaryBytes(contentBytes);
        const decoded = binary ? '' : new TextDecoder().decode(contentBytes);
        setRepoAccessMode('installed');
        setPublicRepoRef(null);
        setCurrentRepoDocPath(contents.path);
        setCurrentRepoDocSha(contents.sha);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(contents.path);
        let knownMarkdownPaths = repoFiles.filter((file) => isMarkdownFileName(file.path)).map((file) => file.path);
        if (knownMarkdownPaths.length === 0) {
          try {
            const mdFiles = await loadRepoMarkdownFiles(instId, repoName);
            setRepoFiles(mdFiles);
            knownMarkdownPaths = mdFiles.map((file) => file.path);
          } catch {
            /* sidebar index is best-effort */
          }
        }
        if (forEdit) {
          setEditingBackend('repo');
          setEditTitle(contents.name.replace(/\.(?:md(?:own|wn)?|markdown)$/i, ''));
          setEditContent(decoded);
        } else if (binary && isSafeImageFileName(contents.name)) {
          renderImageFileContent(contents.name, repoRawFileUrl(instId, repoName, contents.path));
        } else if (binary) {
          renderBinaryFileContent(contents.name, repoRawFileUrl(instId, repoName, contents.path));
        } else {
          const wikiPaths = knownMarkdownPaths.includes(contents.path)
            ? knownMarkdownPaths
            : [...knownMarkdownPaths, contents.path];
          renderDocumentContent(
            decoded,
            contents.name,
            contents.path,
            {
              mode: 'installed',
              installationId: instId,
              selectedRepo: repoName,
            },
            {
              currentDocPath: contents.path,
              knownMarkdownPaths: wikiPaths,
            },
          );
        }
        setViewPhase(null);
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Failed to load file');
      }
    },
    [
      navigate,
      handleSessionExpired,
      showError,
      repoFiles,
      loadRepoMarkdownFiles,
      renderDocumentContent,
      renderImageFileContent,
      renderBinaryFileContent,
      activeView,
      currentFileName,
      showRateLimitToastIfNeeded,
    ],
  );

  const loadPublicRepoFile = useCallback(
    async (owner: string, repo: string, path: string) => {
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        let contents = await getPublicRepoContents(owner, repo, path);
        if (!isRepoFile(contents)) {
          const markdownDirectoryIndex = findMarkdownDirectoryIndexPath(contents, path);
          if (markdownDirectoryIndex) contents = await getPublicRepoContents(owner, repo, markdownDirectoryIndex);
        }
        if (!isRepoFile(contents)) throw new Error('Expected a file');
        const contentBytes = contents.content ? decodeBase64ToBytes(contents.content) : new Uint8Array();
        const binary = isLikelyBinaryBytes(contentBytes);
        const decoded = binary ? '' : new TextDecoder().decode(contentBytes);
        const mdFiles = await loadPublicRepoMarkdownFiles(owner, repo);
        const knownMarkdownPaths = mdFiles.map((file) => file.path);
        setRepoFiles(mdFiles);
        setRepoAccessMode('public');
        setPublicRepoRef({ owner, repo });
        setCurrentRepoDocPath(contents.path);
        setCurrentRepoDocSha(null);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(contents.path);
        setEditingBackend(null);
        if (binary && isSafeImageFileName(contents.name)) {
          renderImageFileContent(contents.name, publicRepoRawFileUrl(owner, repo, contents.path));
        } else if (binary) {
          renderBinaryFileContent(contents.name, publicRepoRawFileUrl(owner, repo, contents.path));
        } else {
          renderDocumentContent(
            decoded,
            contents.name,
            contents.path,
            {
              mode: 'public',
              publicRepoRef: { owner, repo },
            },
            {
              currentDocPath: contents.path,
              knownMarkdownPaths: knownMarkdownPaths.includes(contents.path)
                ? knownMarkdownPaths
                : [...knownMarkdownPaths, contents.path],
            },
          );
        }
        setViewPhase(null);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Failed to load file');
      }
    },
    [
      activeView,
      currentFileName,
      loadPublicRepoMarkdownFiles,
      renderDocumentContent,
      renderImageFileContent,
      renderBinaryFileContent,
      showError,
      showRateLimitToastIfNeeded,
    ],
  );

  const loadSharedRepoFile = useCallback(
    async (token: string) => {
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        const shared = await getSharedRepoFile(token);
        const contentBytes = decodeBase64ToBytes(shared.content);
        const binary = isLikelyBinaryBytes(contentBytes);
        const decoded = binary ? '' : new TextDecoder().decode(contentBytes);
        setRepoAccessMode(null);
        setPublicRepoRef(null);
        setRepoFiles([]);
        setCurrentRepoDocPath(shared.path);
        setCurrentRepoDocSha(shared.sha);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(shared.path);
        setEditingBackend(null);
        if (binary && isSafeImageFileName(shared.name)) {
          const imageBlobBytes = new Uint8Array(contentBytes);
          const imageBlob = new Blob([imageBlobBytes], { type: 'application/octet-stream' });
          const imageBlobUrl = URL.createObjectURL(imageBlob);
          renderImageFileContent(shared.name, imageBlobUrl);
        } else if (binary) {
          const blobBytes = new Uint8Array(contentBytes);
          const blob = new Blob([blobBytes], { type: 'application/octet-stream' });
          const blobUrl = URL.createObjectURL(blob);
          renderBinaryFileContent(shared.name, blobUrl);
        } else {
          renderDocumentContent(decoded, shared.name, shared.path);
        }
        setViewPhase(null);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Failed to load shared file');
      }
    },
    [
      activeView,
      currentFileName,
      renderImageFileContent,
      renderBinaryFileContent,
      renderDocumentContent,
      showError,
      showRateLimitToastIfNeeded,
    ],
  );

  // --- Route handler ---
  const handleRoute = useCallback(
    async (r: Route, authenticatedOverride?: boolean) => {
      const isAuthenticated = authenticatedOverride ?? Boolean(user);
      const enteringDocumentRoute =
        r.name === 'repoedit' ||
        r.name === 'edit' ||
        r.name === 'gist' ||
        r.name === 'repofile' ||
        r.name === 'sharefile';
      if (enteringDocumentRoute && activeView !== 'content' && activeView !== 'edit') {
        // Reentering an existing repo/gist should reset manual sidebar overrides.
        setSidebarVisibilityOverride(null);
      }

      switch (r.name) {
        case 'workspaces':
          if (!isAuthenticated) {
            navigate(routePath.freshDraft(), { replace: true });
            return;
          }
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setGistFiles(null);
          setCurrentFileName(null);
          setRepoFiles([]);
          setRepoSidebarFiles([]);
          setViewPhase(null);
          return;
        case 'repodocuments': {
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const repoFullName = buildRepoFullName(owner, repo);
          const selectedRepoFullName = getSelectedRepo()?.full_name ?? selectedRepo;
          const instId = getInstallationId();
          const useInstalledRepo =
            Boolean(isAuthenticated && instId) &&
            selectedRepoFullName !== null &&
            selectedRepoFullName.toLowerCase() === repoFullName.toLowerCase();
          setViewPhase('loading');
          try {
            if (useInstalledRepo && instId) {
              const mdFiles = await loadRepoMarkdownFiles(instId, repoFullName);
              if (mdFiles.length > 0) {
                setRepoAccessMode('installed');
                setPublicRepoRef(null);
                setRepoFiles(mdFiles);
                const target = pickPreferredRepoMarkdownFile(mdFiles);
                if (!target) {
                  navigate(routePath.repoNew(owner, repo, DEFAULT_NEW_FILENAME), { replace: true });
                  return;
                }
                navigate(routePath.repoFile(owner, repo, target.path), { replace: true });
                return;
              }
              navigate(routePath.repoNew(owner, repo, DEFAULT_NEW_FILENAME), { replace: true });
              return;
            }

            const mdFiles = await loadPublicRepoMarkdownFiles(owner, repo);
            if (mdFiles.length === 0) {
              showError('No markdown files found in this repository');
              return;
            }
            setRepoAccessMode('public');
            setPublicRepoRef({ owner, repo });
            setRepoFiles(mdFiles);
            const target = pickPreferredRepoMarkdownFile(mdFiles);
            if (!target) {
              showError('No markdown files found in this repository');
              return;
            }
            if (isSubdomainMode() && fileNameFromPath(target.path).toLowerCase() === 'index.md') {
              await loadPublicRepoFile(owner, repo, target.path);
              return;
            }
            navigate(routePath.publicRepoFile(owner, repo, target.path), { replace: true });
          } catch (err) {
            if (err instanceof SessionExpiredError) {
              handleSessionExpired();
              return;
            }
            showRateLimitToastIfNeeded(err);
            const message = err instanceof Error ? err.message : '';
            if (useInstalledRepo && message.includes('404')) {
              navigate(routePath.repoNew(owner, repo, DEFAULT_NEW_FILENAME), { replace: true });
              return;
            }
            showError(message || 'Failed to load repository documents');
          }
          return;
        }
        case 'repofile': {
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const decodedPath = safeDecodeURIComponent(r.params.path).replace(/^\/+/, '');
          const repoFullName = buildRepoFullName(owner, repo);
          const selectedRepoFullName = getSelectedRepo()?.full_name ?? selectedRepo;
          const instId = getInstallationId();
          const useInstalledRepo =
            Boolean(isAuthenticated && instId) &&
            selectedRepoFullName !== null &&
            selectedRepoFullName.toLowerCase() === repoFullName.toLowerCase();
          if (useInstalledRepo) {
            await loadRepoFile(owner, repo, decodedPath, false);
          } else {
            await loadPublicRepoFile(owner, repo, decodedPath);
          }
          return;
        }
        case 'sharefile':
          await loadSharedRepoFile(safeDecodeURIComponent(r.params.token));
          return;
        case 'reponew': {
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const path = safeDecodeURIComponent(r.params.path).replace(/^\/+/, '');
          const repoName = buildRepoFullName(owner, repo);
          const instId = getInstallationId();
          if (!instId || !isAuthenticated) {
            navigate(routePath.workspaces());
            return;
          }
          if ((selectedRepo ?? '').toLowerCase() !== repoName.toLowerCase()) {
            setSelectedRepo(repoName);
            storeSelectedRepo({ full_name: repoName });
          }
          setDraftMode(false);
          setRepoAccessMode('installed');
          setPublicRepoRef(null);
          setEditingBackend('repo');
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setCurrentGistId(null);
          setCurrentFileName(null);
          setGistFiles(null);
          setRepoFiles([]);
          setRepoSidebarFiles([]);
          setPreviewVisible(defaultPreviewVisible());
          const routeFileName = fileNameFromPath(path);
          const fallbackTitle = routeFileName.replace(/\.(?:md(?:own|wn)?|markdown)$/i, '') || DEFAULT_NEW_FILENAME;
          setEditTitle(localStorage.getItem(repoNewDraftKey(instId, repoName, 'title')) || fallbackTitle);
          setEditContent(localStorage.getItem(repoNewDraftKey(instId, repoName, 'content')) ?? '');
          setViewPhase(null);
          return;
        }
        case 'repoedit': {
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const path = safeDecodeURIComponent(r.params.path).replace(/^\/+/, '');
          setDraftMode(false);
          await loadRepoFile(owner, repo, path, true);
          return;
        }
        case 'new':
          if (activeView === 'edit') {
            localStorage.removeItem(DRAFT_TITLE_KEY);
            localStorage.removeItem(DRAFT_CONTENT_KEY);
            setHasUnsavedChanges(false);
          }
          setDraftMode(true);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setEditingBackend('gist');
          setCurrentGistId(null);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setCurrentFileName(null);
          setGistFiles(null);
          setRepoFiles([]);
          setRepoSidebarFiles([]);
          setPreviewVisible(defaultPreviewVisible());
          setEditTitle(localStorage.getItem(DRAFT_TITLE_KEY) || DEFAULT_NEW_FILENAME);
          setEditContent(localStorage.getItem(DRAFT_CONTENT_KEY) ?? '');
          setViewPhase(null);
          if (activeView === 'edit') focusEditorSoon();
          return;
        case 'edit': {
          if (!isAuthenticated) {
            const started = startGitHubSignIn(`/${routePath.gistEdit(r.params.id, r.params.filename)}`, {
              guardKey: `oauth_edit:${r.params.id}:${r.params.filename ?? ''}`,
            });
            if (!started) {
              showError('Automatic sign-in was already attempted for this gist. Use Sign in with GitHub to retry.');
            }
            return;
          }
          setDraftMode(false);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          // Serve from cache if we already have this gist's files
          const cachedFiles = currentGistId === r.params.id ? gistFiles : null;
          if (cachedFiles) {
            const cacheKeys = Object.keys(cachedFiles);
            const cacheName = r.params.filename ? safeDecodeURIComponent(r.params.filename) : cacheKeys[0];
            const cacheFile = cacheName ? cachedFiles[cacheName] : null;
            if (cacheFile) {
              setEditingBackend('gist');
              setCurrentGistId(r.params.id);
              setCurrentFileName(cacheFile.filename);
              setCurrentRepoDocPath(null);
              setCurrentRepoDocSha(null);
              setRepoFiles([]);
              setRepoSidebarFiles([]);
              setEditTitle(cacheFile.filename.replace(/\.(?:md(?:own|wn)?|markdown)$/i, ''));
              setEditContent(cacheFile.content ?? '');
              setHasUnsavedChanges(false);
              setViewPhase(null);
              return;
            }
          }
          setViewPhase('loading');
          try {
            const gist = await getGist(r.params.id);
            setGistFiles(gist.files);

            const fileKeys = Object.keys(gist.files);
            const targetName = r.params.filename ? safeDecodeURIComponent(r.params.filename) : fileKeys[0];
            const file = targetName ? gist.files[targetName] : null;
            if (!file) {
              showError('File not found in gist');
              return;
            }

            setEditingBackend('gist');
            setCurrentGistId(gist.id);
            setCurrentFileName(file.filename);
            setCurrentRepoDocPath(null);
            setCurrentRepoDocSha(null);
            setRepoFiles([]);
            setRepoSidebarFiles([]);
            setEditTitle(file.filename.replace(/\.(?:md(?:own|wn)?|markdown)$/i, ''));
            setEditContent(file.content ?? '');
            setViewPhase(null);
          } catch (err) {
            showRateLimitToastIfNeeded(err);
            showError(err instanceof Error ? err.message : 'Failed to load gist');
          }
          return;
        }
        case 'gist': {
          const id = r.params.id;
          const filename = r.params.filename;
          await loadGist(id, filename, !isAuthenticated);
          return;
        }
        case 'home':
          if (isAuthenticated) navigate(routePath.workspaces(), { replace: true });
          else navigate(routePath.freshDraft(), { replace: true });
          return;
        default:
          setDraftMode(false);
          setViewPhase(null);
      }
    },
    [
      navigate,
      loadRepoFile,
      loadPublicRepoFile,
      loadSharedRepoFile,
      loadRepoMarkdownFiles,
      loadPublicRepoMarkdownFiles,
      loadGist,
      showError,
      focusEditorSoon,
      activeView,
      user,
      currentGistId,
      gistFiles,
      startGitHubSignIn,
      handleSessionExpired,
      showRateLimitToastIfNeeded,
      defaultPreviewVisible,
      selectedRepo,
    ],
  );

  // --- Init ---
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    (async () => {
      const handledSetup = await tryHandleGitHubAppSetupRedirect();
      const auth = await tryRestoreAuth();
      if (!handledSetup && !auth.navigated) {
        await handleRoute(route, auth.authenticated);
      }
      document.getElementById('app')!.classList.add('ready');
    })();
  }, [handleRoute, route, tryHandleGitHubAppSetupRedirect, tryRestoreAuth]);

  // --- Route changes ---
  const prevRoute = useRef(route);
  useEffect(() => {
    if (!initialized.current) return;
    if (route === prevRoute.current) return;
    if (isContentRoute(route)) {
      clearRenderedContent();
      setContentLoadPending(true);
    } else {
      setContentLoadPending(false);
    }
    prevRoute.current = route;
    handleRoute(route);
  }, [clearRenderedContent, handleRoute, isContentRoute, route]);

  // --- Draft persistence ---
  useEffect(() => {
    if (!draftMode) return;
    localStorage.setItem(DRAFT_TITLE_KEY, editTitle);
    localStorage.setItem(DRAFT_CONTENT_KEY, editContent);
  }, [draftMode, editTitle, editContent]);

  useEffect(() => {
    if (route.name !== 'reponew') return;
    if (editingBackend !== 'repo' || currentRepoDocPath) return;
    const instId = installationId ?? getInstallationId();
    const repoName = selectedRepo ?? getSelectedRepo()?.full_name ?? null;
    if (!instId || !repoName) return;
    localStorage.setItem(repoNewDraftKey(instId, repoName, 'title'), editTitle);
    localStorage.setItem(repoNewDraftKey(instId, repoName, 'content'), editContent);
  }, [route.name, editingBackend, currentRepoDocPath, installationId, selectedRepo, editTitle, editContent]);

  useEffect(() => {
    void installationId;
    void user?.login;
    setInstallationRepos([]);
    setInstallationReposLoading(false);
    setLoadedReposInstallationId(null);
    setAutoLoadAttemptedReposInstallationId(null);
    setReposLoadError(null);
    setGistsLoadError(null);
    setMenuGistsLoaded(false);
    setMenuGists([]);
    setMenuGistsLoading(false);
    setAutoLoadAttemptedGists(false);
  }, [installationId, user?.login]);

  // --- Theme toggle ---
  const toggleTheme = useCallback(() => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {}
  }, []);

  // --- Preview state ---
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsDesktopWidth(event.matches);
    setIsDesktopWidth(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(EDITOR_PREVIEW_VISIBLE_KEY, previewVisible ? 'true' : 'false');
    } catch {}
  }, [previewVisible]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(READER_AI_VISIBLE_KEY, readerAiVisible ? 'true' : 'false');
    } catch {}
  }, [readerAiVisible]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(READER_AI_MODEL_KEY, readerAiSelectedModel);
    } catch {}
  }, [readerAiSelectedModel]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(READER_AI_WIDTH_KEY, String(readerAiWidth));
    } catch {}
  }, [readerAiWidth]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_FILE_FILTER_KEY, sidebarFileFilter);
    } catch {}
  }, [sidebarFileFilter]);

  useEffect(() => {
    if (sidebarFileFilter === 'all' || sidebarFileFilter === 'text') {
      let active = true;
      void (async () => {
        try {
          if (repoAccessMode === 'installed' && installationId && selectedRepo) {
            const files = await loadRepoAllFiles(installationId, selectedRepo);
            if (active) setRepoSidebarFiles(files);
            return;
          }
          if (repoAccessMode === 'public' && publicRepoRef) {
            const files = await loadPublicRepoAllFiles(publicRepoRef.owner, publicRepoRef.repo);
            if (active) setRepoSidebarFiles(files);
          }
        } catch (err) {
          showRateLimitToastIfNeeded(err);
        }
      })();
      return () => {
        active = false;
      };
    }
    return;
  }, [
    sidebarFileFilter,
    repoAccessMode,
    installationId,
    selectedRepo,
    publicRepoRef,
    loadRepoAllFiles,
    loadPublicRepoAllFiles,
    showRateLimitToastIfNeeded,
  ]);

  const onTogglePreview = useCallback(() => {
    setPreviewVisible((v) => !v);
  }, []);

  const onToggleReaderAi = useCallback(() => {
    setReaderAiVisible((visible) => !visible);
  }, []);

  const loadReaderAiModels = useCallback(async () => {
    setReaderAiModelsLoading(true);
    setReaderAiModelsError(null);
    try {
      const models = prioritizeReaderAiModels(await listReaderAiModels());
      setReaderAiConfigured(true);
      setReaderAiModels(models);
      setReaderAiSelectedModel((current) => {
        if (current && models.some((model) => model.id === current)) return current;
        return models[0]?.id ?? '';
      });
    } catch (err) {
      setReaderAiModels([]);
      if (err instanceof ApiError && err.status === 503) {
        setReaderAiConfigured(false);
      }
      setReaderAiModelsError(err instanceof Error ? err.message : 'Failed to load Reader AI models');
    } finally {
      setReaderAiModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    const prevHistoryKey = readerAiPrevHistoryKeyRef.current;
    if (activeView === 'content' && renderMode === 'markdown' && readerAiSource && readerAiHistoryDocumentKey) {
      if (prevHistoryKey !== readerAiHistoryDocumentKey) {
        readerAiSkipPersistHistoryKeyRef.current = readerAiHistoryDocumentKey;
        console.debug('[reader-ai] switching history context', {
          from: prevHistoryKey,
          to: readerAiHistoryDocumentKey,
        });
        readerAiAbortRef.current?.abort();
        readerAiAbortRef.current = null;
        setReaderAiSending(false);
        setReaderAiToolStatus(null);
        const loaded = loadReaderAiEntryFromHistory(readerAiHistoryDocumentKey);
        setReaderAiMessages(loaded.messages);
        setReaderAiSummary(loaded.summary ?? '');

        setReaderAiError(null);
      }
      readerAiPrevHistoryKeyRef.current = readerAiHistoryDocumentKey;
      return;
    }
    readerAiPrevHistoryKeyRef.current = null;
    readerAiAbortRef.current?.abort();
    readerAiAbortRef.current = null;
    setReaderAiSending(false);
    setReaderAiToolStatus(null);
    setReaderAiMessages([]);
    setReaderAiSummary('');

    setReaderAiError(null);
  }, [activeView, renderMode, readerAiSource, readerAiHistoryDocumentKey]);

  useLayoutEffect(() => {
    if (activeView !== 'content' || renderMode !== 'markdown' || !readerAiSource || !readerAiHistoryDocumentKey) return;
    if (readerAiSkipPersistHistoryKeyRef.current === readerAiHistoryDocumentKey) {
      readerAiSkipPersistHistoryKeyRef.current = null;
      console.debug('[reader-ai] skipping first persist after history load', {
        historyKey: readerAiHistoryDocumentKey,
      });
      return;
    }
    persistReaderAiMessagesToHistory(readerAiHistoryDocumentKey, readerAiMessages, readerAiSummary || undefined);
  }, [activeView, renderMode, readerAiMessages, readerAiSummary, readerAiSource, readerAiHistoryDocumentKey]);

  useEffect(() => {
    return () => {
      readerAiAbortRef.current?.abort();
      readerAiAbortRef.current = null;
    };
  }, []);

  const showReaderAiToggleCandidate =
    activeView === 'content' && renderMode === 'markdown' && (Boolean(readerAiSource) || isClaudeTranscript);

  useEffect(() => {
    if (!showReaderAiToggleCandidate || readerAiModelsLoading || readerAiModels.length > 0 || readerAiModelsError)
      return;
    void loadReaderAiModels();
  }, [
    loadReaderAiModels,
    readerAiModels.length,
    readerAiModelsError,
    readerAiModelsLoading,
    showReaderAiToggleCandidate,
  ]);

  // ── Repo mode availability ──
  const REPO_MODE_MAX_FILES = 100;
  const REPO_MODE_MAX_FILE_SIZE = 50 * 1024 * 1024;

  const isGistContext = currentGistId !== null && gistFiles !== null;
  const repoModeAvailable = repoAccessMode !== null || isGistContext;

  const repoModeFileCount = readerAiRepoFiles?.length ?? 0;

  const repoModeDisabledReason = useMemo((): string | null => {
    if (!repoModeAvailable) return null;
    if (isGistContext) {
      const fileCount = gistFiles ? Object.keys(gistFiles).length : 0;
      if (fileCount === 0) return 'No files in gist';
      if (fileCount > REPO_MODE_MAX_FILES) return `Too many files (${fileCount}, max ${REPO_MODE_MAX_FILES})`;
      return null;
    }
    // Check against the sidebar files list (all files) when available
    const allFiles = repoSidebarFiles.length > 0 ? repoSidebarFiles : repoFiles;
    if (allFiles.length === 0) return null; // tree not loaded yet — allow toggle, will validate on fetch
    if (allFiles.length > REPO_MODE_MAX_FILES) return `Too many files (${allFiles.length}, max ${REPO_MODE_MAX_FILES})`;
    const oversized = allFiles.find((f) => f.size != null && f.size > REPO_MODE_MAX_FILE_SIZE);
    if (oversized)
      return `File too large: ${oversized.path} (${Math.round((oversized.size ?? 0) / 1024 / 1024)}MB, max 50MB)`;
    return null;
  }, [repoModeAvailable, isGistContext, gistFiles, repoSidebarFiles, repoFiles]);

  // Reset repo mode when navigating away from a repo/gist
  useEffect(() => {
    if (!repoModeAvailable) {
      setReaderAiRepoMode(false);
      setReaderAiRepoFiles(null);
      if (readerAiProjectId) {
        void deleteReaderAiProjectSession(readerAiProjectId);
        setReaderAiProjectId(null);
      }
    }
  }, [repoModeAvailable, readerAiProjectId]);

  // Auto-enable repo mode when all files are already cached
  useEffect(() => {
    if (!repoModeAvailable || readerAiRepoMode || readerAiRepoModeLoading || repoModeDisabledReason) return;
    const allFiles = repoSidebarFiles.length > 0 ? repoSidebarFiles : repoFiles;
    if (allFiles.length === 0) return;

    let cached: RepoFileEntry[] | null = null;
    if (repoAccessMode === 'installed' && installationId && selectedRepo) {
      cached = tryBuildRepoFilesFromCache({ installationId, repoFullName: selectedRepo }, allFiles);
    } else if (repoAccessMode === 'public' && publicRepoRef) {
      cached = tryBuildRepoFilesFromCache({ owner: publicRepoRef.owner, repo: publicRepoRef.repo }, allFiles);
    }
    if (cached && cached.length > 0) {
      setReaderAiRepoFiles(cached);
      setReaderAiRepoMode(true);
      // Upload to server for project session
      void createReaderAiProjectSession(cached)
        .then((ps) => {
          setReaderAiProjectId(ps.projectId);
        })
        .catch(() => {
          // Non-fatal — chat will fall back to inline files if project session is missing
        });
    }
  }, [
    repoModeAvailable,
    readerAiRepoMode,
    readerAiRepoModeLoading,
    repoModeDisabledReason,
    repoSidebarFiles,
    repoFiles,
    repoAccessMode,
    installationId,
    selectedRepo,
    publicRepoRef,
  ]);

  const onToggleRepoMode = useCallback(
    async (enabled: boolean) => {
      if (!enabled) {
        setReaderAiRepoMode(false);
        setReaderAiRepoFiles(null);
        if (readerAiProjectId) {
          void deleteReaderAiProjectSession(readerAiProjectId);
          setReaderAiProjectId(null);
        }
        return;
      }

      setReaderAiRepoModeLoading(true);
      try {
        let files: RepoFileEntry[];
        if (isGistContext && gistFiles) {
          // Build file entries from gist files (already loaded)
          files = Object.values(gistFiles).map((f) => ({
            path: f.filename,
            content: f.content,
            size: f.size,
          }));
        } else if (repoAccessMode === 'installed' && installationId && selectedRepo) {
          files = await getRepoTarball(installationId, selectedRepo);
        } else if (repoAccessMode === 'public' && publicRepoRef) {
          files = await getPublicRepoTarball(publicRepoRef.owner, publicRepoRef.repo);
        } else {
          return;
        }
        // Upload files to server and get a project session ID
        const ps = await createReaderAiProjectSession(files);
        setReaderAiRepoFiles(files);
        setReaderAiProjectId(ps.projectId);
        setReaderAiRepoMode(true);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        setReaderAiError(err instanceof Error ? err.message : 'Failed to load repo files');
        setReaderAiRepoMode(false);
        setReaderAiRepoFiles(null);
        setReaderAiProjectId(null);
      } finally {
        setReaderAiRepoModeLoading(false);
      }
    },
    [
      repoAccessMode,
      installationId,
      selectedRepo,
      publicRepoRef,
      showRateLimitToastIfNeeded,
      readerAiProjectId,
      isGistContext,
      gistFiles,
    ],
  );

  const streamReaderAiAssistant = useCallback(
    async (baseMessages: ReaderAiMessage[], options?: { edited?: boolean }) => {
      const model = readerAiSelectedModel;
      const source = trimReaderAiSource(readerAiSource);
      if (!model || !source) return false;
      const assistantEdited = options?.edited === true;
      readerAiAbortRef.current?.abort();
      const controller = new AbortController();
      readerAiAbortRef.current = controller;
      setReaderAiMessages([
        ...baseMessages,
        assistantEdited ? { role: 'assistant', content: '', edited: true } : { role: 'assistant', content: '' },
      ]);

      setReaderAiSending(true);
      setReaderAiToolStatus(null);
      setReaderAiToolLog([]);
      setReaderAiError(null);
      let received = false;

      // Build project context if repo mode is active (send project_id, not files)
      let projectContext: { projectId: string; currentDocPath: string | null } | undefined;
      if (readerAiRepoMode && readerAiProjectId) {
        projectContext = {
          projectId: readerAiProjectId,
          currentDocPath: currentRepoDocPath,
        };
      }

      try {
        await askReaderAiStream(
          model,
          source,
          baseMessages.map((message) => ({ role: message.role, content: message.content })),
          {
            signal: controller.signal,
            onSummary: (summary) => setReaderAiSummary(summary),
            onToolCall: (event) => {
              const labels: Record<string, string> = {
                read_document: 'Reading document…',
                search_document: 'Searching document…',
                read_file: 'Reading file…',
                search_files: 'Searching files…',
                list_files: 'Listing files…',
                edit_file: 'Editing file…',
                create_file: 'Creating file…',
                delete_file: 'Deleting file…',
                task: 'Running subagent…',
              };
              setReaderAiToolStatus(labels[event.name] ?? `Running ${event.name}…`);
              const argsObj = typeof event.arguments === 'object' ? event.arguments : undefined;
              const detail = argsObj
                ? (((argsObj as Record<string, unknown>).path as string | undefined) ??
                  ((argsObj as Record<string, unknown>).query as string | undefined))
                : undefined;
              setReaderAiToolLog((log) => [
                ...log,
                { type: 'call', name: event.name, detail: typeof detail === 'string' ? detail : undefined },
              ]);
            },
            onToolResult: (event) => {
              setReaderAiToolStatus(null);
              setReaderAiToolLog((log) => [...log, { type: 'result', name: event.name, detail: event.preview }]);
            },
            onStagedChanges: (changes) => {
              setReaderAiStagedChanges(changes);
            },
            onDelta: (delta) => {
              if (!delta) return;
              received = true;
              setReaderAiMessages((current) => {
                if (current.length === 0) {
                  return assistantEdited
                    ? [{ role: 'assistant', content: delta, edited: true }]
                    : [{ role: 'assistant', content: delta }];
                }
                const updated = [...current];
                const lastIndex = updated.length - 1;
                const last = updated[lastIndex];
                if (last.role !== 'assistant') {
                  updated.push(
                    assistantEdited
                      ? { role: 'assistant', content: delta, edited: true }
                      : { role: 'assistant', content: delta },
                  );
                  return updated;
                }
                updated[lastIndex] = { ...last, content: `${last.content}${delta}` };
                return updated;
              });
            },
          },
          readerAiSummary || undefined,
          projectContext,
        );
        if (!received) {
          setReaderAiMessages((current) => {
            if (current.length === 0) {
              return assistantEdited
                ? [{ role: 'assistant', content: 'No response.', edited: true }]
                : [{ role: 'assistant', content: 'No response.' }];
            }
            const updated = [...current];
            const lastIndex = updated.length - 1;
            const last = updated[lastIndex];
            if (last.role !== 'assistant') {
              updated.push(
                assistantEdited
                  ? { role: 'assistant', content: 'No response.', edited: true }
                  : { role: 'assistant', content: 'No response.' },
              );
              return updated;
            }
            if (!last.content.trim()) updated[lastIndex] = { ...last, content: 'No response.' };
            return updated;
          });
        }
        return true;
      } catch (err) {
        setReaderAiMessages((current) => {
          if (current.length === 0) return current;
          const last = current[current.length - 1];
          if (last.role === 'assistant' && !last.content.trim()) return current.slice(0, -1);
          return current;
        });
        if (err instanceof DOMException && err.name === 'AbortError') return true;
        setReaderAiError(err instanceof Error ? err.message : 'Reader AI request failed');
        return false;
      } finally {
        if (readerAiAbortRef.current === controller) readerAiAbortRef.current = null;
        setReaderAiSending(false);
        setReaderAiToolStatus(null);
      }
    },
    [readerAiSelectedModel, readerAiSource, readerAiSummary, readerAiRepoMode, readerAiProjectId, currentRepoDocPath],
  );

  const onReaderAiSend = useCallback(
    async (prompt: string) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) return true;
      return streamReaderAiAssistant([...readerAiMessages, { role: 'user', content: trimmedPrompt }]);
    },
    [readerAiMessages, streamReaderAiAssistant],
  );

  const onReaderAiEditMessage = useCallback(
    async (index: number, nextContent: string) => {
      const trimmedContent = nextContent.trim();
      if (!trimmedContent) return;
      if (index < 0 || index >= readerAiMessages.length) return;
      const target = readerAiMessages[index];
      if (!target || target.role !== 'user' || target.content === trimmedContent) return;
      const updated = readerAiMessages
        .slice(0, index + 1)
        .map((message, messageIndex) =>
          messageIndex === index ? { ...message, content: trimmedContent, edited: false } : message,
        );
      await streamReaderAiAssistant(updated, { edited: true });
    },
    [readerAiMessages, streamReaderAiAssistant],
  );

  const onReaderAiStop = useCallback(() => {
    readerAiAbortRef.current?.abort();
    readerAiAbortRef.current = null;
    setReaderAiSending(false);
    setReaderAiToolStatus(null);
  }, []);

  const onReaderAiClear = useCallback(() => {
    if (readerAiHistoryDocumentKey) clearReaderAiMessagesFromHistory(readerAiHistoryDocumentKey);
    setReaderAiMessages([]);
    setReaderAiSummary('');

    setReaderAiToolStatus(null);
    setReaderAiToolLog([]);
    setReaderAiStagedChanges([]);
    setReaderAiError(null);
    if (readerAiProjectId) void resetReaderAiProjectSession(readerAiProjectId);
  }, [readerAiHistoryDocumentKey, readerAiProjectId]);

  const onReaderAiApplyChanges = useCallback(
    async (commitMessage?: string) => {
      if (readerAiApplyingChanges || readerAiStagedChanges.length === 0 || !readerAiRepoFiles) return;
      setReaderAiApplyingChanges(true);
      setReaderAiError(null);

      const applied: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];

      try {
        // Fetch modified files from the project session
        if (!readerAiProjectId) throw new Error('No project session');
        const res = await fetch(`/api/ai/project/${encodeURIComponent(readerAiProjectId)}/files`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('Failed to fetch modified files');
        const data = (await res.json()) as { files?: Array<{ path: string; content: string }> };
        const modifiedMap = new Map((data.files ?? []).map((f) => [f.path, f.content]));

        if (isGistContext && currentGistId) {
          // Gist mode: batch all changes into one PATCH call
          const gistUpdates: Record<string, { content: string } | null> = {};
          for (const change of readerAiStagedChanges) {
            if (change.type === 'delete') {
              gistUpdates[change.path] = null;
            } else {
              const content = modifiedMap.get(change.path);
              if (content !== undefined) gistUpdates[change.path] = { content };
            }
          }
          if (Object.keys(gistUpdates).length > 0) {
            await updateGistFiles(currentGistId, gistUpdates);
            applied.push(...Object.keys(gistUpdates));
          }
        } else if (repoAccessMode === 'installed' && installationId && selectedRepo) {
          // Repo mode: apply each change via GitHub Contents API
          const message = commitMessage || 'Apply AI-suggested changes';

          for (const change of readerAiStagedChanges) {
            try {
              if (change.type === 'delete') {
                const contents = await getRepoContents(installationId, selectedRepo, change.path);
                if (!Array.isArray(contents) && contents.type === 'file') {
                  await deleteRepoFile(installationId, selectedRepo, change.path, message, contents.sha);
                }
              } else {
                const content = modifiedMap.get(change.path);
                if (content === undefined) {
                  failed.push({ path: change.path, error: 'Modified content not found' });
                  continue;
                }
                const base64 = btoa(unescape(encodeURIComponent(content)));
                let sha: string | undefined;
                if (change.type === 'edit') {
                  try {
                    const contents = await getRepoContents(installationId, selectedRepo, change.path);
                    if (!Array.isArray(contents) && contents.type === 'file') sha = contents.sha;
                  } catch {
                    // File may not exist — treat as create
                  }
                }
                await putRepoFile(installationId, selectedRepo, change.path, message, base64, sha);
              }
              applied.push(change.path);
            } catch (err) {
              failed.push({ path: change.path, error: err instanceof Error ? err.message : 'Unknown error' });
            }
          }
        } else {
          throw new Error('Cannot apply changes: no write access');
        }

        if (failed.length > 0 && applied.length > 0) {
          // Partial success
          setReaderAiStagedChanges((prev) => prev.filter((c) => !applied.includes(c.path)));
          const failedPaths = failed.map((f) => f.path).join(', ');
          setReaderAiError(`Applied ${applied.length} file(s), but ${failed.length} failed: ${failedPaths}`);
        } else if (failed.length > 0) {
          const failedPaths = failed.map((f) => `${f.path}: ${f.error}`).join('; ');
          setReaderAiError(`Failed to apply changes: ${failedPaths}`);
        } else {
          // Full success — clear staged changes
          setReaderAiStagedChanges([]);
          if (readerAiProjectId) void resetReaderAiProjectSession(readerAiProjectId);
        }

        // Invalidate caches so the UI reflects the applied changes
        if (applied.length > 0) {
          clearGitHubAppCaches();
          if (isGistContext) clearGitHubCaches();
        }
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        setReaderAiError(err instanceof Error ? err.message : 'Failed to apply changes');
      } finally {
        setReaderAiApplyingChanges(false);
      }
    },
    [
      readerAiApplyingChanges,
      readerAiStagedChanges,
      readerAiRepoFiles,
      readerAiProjectId,
      isGistContext,
      currentGistId,
      repoAccessMode,
      installationId,
      selectedRepo,
      showRateLimitToastIfNeeded,
    ],
  );

  const onReaderAiRetryLastMessage = useCallback(async () => {
    if (readerAiSending) return;
    if (readerAiMessages.length === 0) return;
    // Find the last user message and replay up to (and including) it
    let lastUserIndex = -1;
    for (let i = readerAiMessages.length - 1; i >= 0; i--) {
      if (readerAiMessages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return;
    const messagesToReplay = readerAiMessages.slice(0, lastUserIndex + 1);
    await streamReaderAiAssistant(messagesToReplay);
  }, [readerAiMessages, readerAiSending, streamReaderAiAssistant]);

  // --- Sign out ---
  const signOut = useCallback(() => {
    void logout().catch(() => {});
    clearInstallationId();
    clearSelectedRepo();
    setUser(null);
    setInstId(null);
    setSelectedRepo(null);
    setSelectedRepoPrivate(null);
    setRepoAccessMode(null);
    setPublicRepoRef(null);
    setCurrentGistId(null);
    setRepoFiles([]);
    setRepoSidebarFiles([]);
    navigate(routePath.home());
  }, [navigate]);

  const selectedRepoRef = useMemo(() => parseRepoFullName(selectedRepo), [selectedRepo]);

  const onEdit = useCallback(() => {
    if (repoAccessMode === 'installed' && currentRepoDocPath && selectedRepoRef) {
      navigate(routePath.repoEdit(selectedRepoRef.owner, selectedRepoRef.repo, currentRepoDocPath));
    } else if (currentGistId && currentFileName) navigate(routePath.gistEdit(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistEdit(currentGistId));
  }, [repoAccessMode, currentRepoDocPath, currentGistId, currentFileName, navigate, selectedRepoRef]);

  const onCancel = useCallback(() => {
    if (currentRepoDocPath && selectedRepoRef) {
      navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, currentRepoDocPath));
    } else if (currentGistId && currentFileName) navigate(routePath.gistView(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistView(currentGistId));
    else if (selectedRepoRef) navigate(routePath.repoDocuments(selectedRepoRef.owner, selectedRepoRef.repo));
    else navigate(routePath.workspaces());
  }, [currentRepoDocPath, currentGistId, currentFileName, selectedRepoRef, navigate]);

  const onShareLink = useCallback(async () => {
    const isGistRoute = route.name === 'gist' || route.name === 'edit';

    try {
      let url: string;
      if (isGistRoute && currentGistId) {
        const sharePath = routePath.gistView(currentGistId, currentFileName ?? undefined);
        url = `${window.location.origin}/${sharePath}`;
      } else if (
        repoAccessMode === 'installed' &&
        (route.name === 'repoedit' || route.name === 'repofile') &&
        selectedRepo &&
        currentRepoDocPath
      ) {
        if (selectedRepoPrivate === true) {
          const installationId = getInstallationId();
          if (!installationId) {
            showFailureToast('Sharing is not available for this file');
            return;
          }
          const shareLink = await createRepoFileShareLink(installationId, selectedRepo, currentRepoDocPath);
          url = shareLink.url;
        } else {
          const [owner, repo] = selectedRepo.split('/');
          if (!owner || !repo) {
            showFailureToast('Failed to build public link');
            return;
          }
          const sharePath = routePath.publicRepoFile(owner, repo, currentRepoDocPath);
          url = `${window.location.origin}/${sharePath}`;
        }
      } else {
        showFailureToast('Sharing is not available for this file');
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement('textarea');
        input.value = url;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      showSuccessToast('Copied share link');
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
        return;
      }
      if (err instanceof ApiError && err.code === 'share_links_not_configured') {
        showFailureToast(err.message);
        return;
      }
      showRateLimitToastIfNeeded(err);
      showFailureToast(err instanceof Error ? err.message : 'Failed to copy share link');
    }
  }, [
    currentGistId,
    currentFileName,
    repoAccessMode,
    route.name,
    selectedRepoPrivate,
    selectedRepo,
    currentRepoDocPath,
    handleSessionExpired,
    showRateLimitToastIfNeeded,
    showSuccessToast,
    showFailureToast,
  ]);

  const onSave = useCallback(async () => {
    const title = editTitle.trim() || DEFAULT_NEW_FILENAME;
    const content = editContent;
    let saved = false;
    setSaving(true);

    try {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name ?? null;

      if (editingBackend === 'repo' && currentRepoDocPath && instId && repoName) {
        const contentB64 = encodeUtf8ToBase64(content);
        const result = await putRepoFile(
          instId,
          repoName,
          currentRepoDocPath,
          `Update ${currentRepoDocPath}`,
          contentB64,
          currentRepoDocSha ?? undefined,
        );
        const contentSize = new TextEncoder().encode(content).length;
        setCurrentRepoDocSha(result.content.sha);
        setRepoSidebarFiles((prev) =>
          prev.map((file) =>
            file.path === currentRepoDocPath ? { ...file, sha: result.content.sha, size: contentSize } : file,
          ),
        );
        if (isMarkdownFileName(currentRepoDocPath)) {
          setRepoFiles((prev) =>
            prev.map((file) =>
              file.path === currentRepoDocPath ? { ...file, sha: result.content.sha, size: contentSize } : file,
            ),
          );
        }

        const knownMarkdownPaths = repoFiles.filter((file) => isMarkdownFileName(file.path)).map((file) => file.path);
        renderDocumentContent(content, currentRepoDocPath.split('/').pop() ?? null, currentRepoDocPath, undefined, {
          currentDocPath: currentRepoDocPath,
          knownMarkdownPaths: knownMarkdownPaths.includes(currentRepoDocPath)
            ? knownMarkdownPaths
            : [...knownMarkdownPaths, currentRepoDocPath],
        });
        if (selectedRepoRef) {
          navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, currentRepoDocPath));
        } else {
          navigate(routePath.workspaces());
        }
      } else if (editingBackend === 'repo' && repoName && instId) {
        const filename = sanitizeTitleToFileName(title);
        const path = filename;
        const contentB64 = encodeUtf8ToBase64(content);
        const result = await putRepoFile(instId, repoName, path, `Create ${filename}`, contentB64);
        const createdFile: RepoDocFile = {
          name: fileNameFromPath(result.content.path),
          path: result.content.path,
          sha: result.content.sha,
          size: new TextEncoder().encode(content).length,
        };
        setRepoSidebarFiles((prev) => upsertRepoFile(prev, createdFile));
        if (isMarkdownFileName(createdFile.path)) {
          setRepoFiles((prev) => upsertRepoFile(prev, createdFile));
        }
        localStorage.removeItem(repoNewDraftKey(instId, repoName, 'title'));
        localStorage.removeItem(repoNewDraftKey(instId, repoName, 'content'));
        setCurrentRepoDocPath(result.content.path);
        setCurrentRepoDocSha(result.content.sha);

        const knownMarkdownPaths = repoFiles.filter((file) => isMarkdownFileName(file.path)).map((file) => file.path);
        const createdPath = result.content.path;
        renderDocumentContent(content, fileNameFromPath(createdPath), createdPath, undefined, {
          currentDocPath: createdPath,
          knownMarkdownPaths: knownMarkdownPaths.includes(createdPath)
            ? knownMarkdownPaths
            : [...knownMarkdownPaths, createdPath],
        });
        if (selectedRepoRef) {
          navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, createdPath));
        } else {
          navigate(routePath.workspaces());
        }
      } else {
        let gist: GistDetail;
        const filename = currentFileName ?? sanitizeTitleToFileName(title);
        if (currentGistId) {
          gist = await updateGist(currentGistId, content, filename);
        } else {
          gist = await createGist(content, filename, title);
          markGistRecentlyCreated(user?.login ?? null, gist);
        }
        setCurrentGistId(gist.id);
        setCurrentFileName(filename);
        setGistFiles(gist.files);
        if (draftMode) {
          localStorage.removeItem(DRAFT_TITLE_KEY);
          localStorage.removeItem(DRAFT_CONTENT_KEY);
          setDraftMode(false);
        }

        renderDocumentContent(content, filename, null, undefined, {
          currentDocPath: filename,
          knownMarkdownPaths: Object.keys(gist.files),
        });
        navigate(routePath.gistView(gist.id, filename));
      }
      clearMarkdownLinkPreviewCache();
      showSuccessToast('Saved');
      saved = true;
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
        return;
      }
      showRateLimitToastIfNeeded(err);
      const staleRepoWrite = editingBackend === 'repo' && isRepoWriteConflictError(err);
      const message = staleRepoWrite
        ? "Save failed: your write wasn't persisted because the file changed upstream. Copy your edits, reload, merge, and save again."
        : err instanceof Error
          ? err.message
          : 'Failed to save';
      void showAlert(message);
    } finally {
      setSaving(false);
      if (saved) setHasUnsavedChanges(false);
    }
  }, [
    editTitle,
    editContent,
    editingBackend,
    currentRepoDocPath,
    currentRepoDocSha,
    currentGistId,
    currentFileName,
    draftMode,
    navigate,
    handleSessionExpired,
    user,
    showAlert,
    showRateLimitToastIfNeeded,
    showSuccessToast,
    clearMarkdownLinkPreviewCache,
    renderDocumentContent,
    repoFiles,
    selectedRepoRef,
  ]);

  const getActiveDocumentStore = useCallback(() => {
    if (currentGistId) {
      return createGistDocumentStore(currentGistId);
    }

    if (repoAccessMode === 'installed' && selectedRepo) {
      const instId = getInstallationId();
      const repoName = getSelectedRepo()?.full_name;
      if (!instId || !repoName) return null;
      return createRepoDocumentStore(instId, repoName);
    }

    return null;
  }, [currentGistId, repoAccessMode, selectedRepo]);

  const onClearCaches = useCallback(async () => {
    const confirmed = await showConfirm(
      'Clear cached data and API requests? This may cause additional reload requests.',
      { confirmLabel: 'Clear cache', intent: 'danger', defaultFocus: 'cancel' },
    );
    if (!confirmed) return;
    clearGitHubCaches();
    clearGitHubAppCaches();
    clearMarkdownLinkPreviewCache();
    setMenuGists([]);
    setMenuGistsLoaded(false);
    setMenuGistsLoading(false);
    setAutoLoadAttemptedGists(false);
    setGistsLoadError(null);
    setInstallationRepos([]);
    setInstallationReposLoading(false);
    setLoadedReposInstallationId(null);
    setAutoLoadAttemptedReposInstallationId(null);
    setReposLoadError(null);
    showSuccessToast('Caches cleared');
  }, [clearMarkdownLinkPreviewCache, showConfirm, showSuccessToast]);

  // --- Sidebar actions ---
  const navigateToSidebarFile = useCallback(
    (filePath: string) => {
      setHasUnsavedChanges(false);
      if (currentGistId) {
        navigate(routePath.gistView(currentGistId, filePath));
      } else if (repoAccessMode === 'installed' && selectedRepoRef) {
        navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, filePath));
      } else if (repoAccessMode === 'public' && publicRepoRef) {
        navigate(routePath.publicRepoFile(publicRepoRef.owner, publicRepoRef.repo, filePath));
      }
    },
    [currentGistId, repoAccessMode, selectedRepoRef, publicRepoRef, navigate],
  );

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (activeView === 'edit' && hasUnsavedChanges) {
        const action = await showConfirm('You have unsaved changes. Discard and switch files?');
        if (action) navigateToSidebarFile(filePath);
        return;
      }
      navigateToSidebarFile(filePath);
    },
    [activeView, hasUnsavedChanges, navigateToSidebarFile, showConfirm],
  );

  const handleCreateFile = useCallback(
    async (filePath: string) => {
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        if (store.kind === 'gist') {
          if (!currentGistId) return;
          const gist = await store.createFile(filePath);
          setGistFiles(gist.files);
          setHasUnsavedChanges(false);
          navigate(routePath.gistEdit(currentGistId, filePath));
        } else {
          const result = await store.createFile(filePath);
          const createdFile = {
            name: fileNameFromPath(filePath),
            path: result.content.path,
            sha: result.content.sha,
            size: 0,
          };
          if (isMarkdownFileName(createdFile.path)) {
            setRepoFiles((prev) => [...prev, createdFile].sort((a, b) => a.path.localeCompare(b.path)));
          }
          setRepoSidebarFiles((prev) => [...prev, createdFile].sort((a, b) => a.path.localeCompare(b.path)));
          setHasUnsavedChanges(false);
          if (selectedRepoRef) {
            if (isMarkdownFileName(result.content.path)) {
              navigate(routePath.repoEdit(selectedRepoRef.owner, selectedRepoRef.repo, result.content.path));
            } else {
              navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, result.content.path));
            }
          } else {
            navigate(routePath.workspaces());
          }
        }
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to create file');
      }
    },
    [getActiveDocumentStore, currentGistId, navigate, showAlert, showRateLimitToastIfNeeded, selectedRepoRef],
  );

  const handleCreateDirectory = useCallback(
    async (directoryPath: string) => {
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        const seedFilePath = `${directoryPath}/index.md`;
        if (store.kind === 'gist') {
          const gist = await store.createFile(seedFilePath);
          setGistFiles(gist.files);
          setHasUnsavedChanges(false);
        } else {
          const result = await store.createFile(seedFilePath);
          const createdFile = {
            name: fileNameFromPath(seedFilePath),
            path: result.content.path,
            sha: result.content.sha,
            size: 0,
          };
          if (isMarkdownFileName(createdFile.path)) {
            setRepoFiles((prev) => [...prev, createdFile].sort((a, b) => a.path.localeCompare(b.path)));
          }
          setRepoSidebarFiles((prev) => [...prev, createdFile].sort((a, b) => a.path.localeCompare(b.path)));
          setHasUnsavedChanges(false);
        }
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to create directory');
      }
    },
    [getActiveDocumentStore, showAlert, showRateLimitToastIfNeeded],
  );

  const handleEditFile = useCallback(
    async (filePath: string) => {
      if (!isMarkdownFileName(filePath)) return;
      if (activeView === 'edit' && currentFileName === filePath) return;

      const target = currentGistId
        ? routePath.gistEdit(currentGistId, filePath)
        : repoAccessMode === 'installed' && selectedRepoRef
          ? routePath.repoEdit(selectedRepoRef.owner, selectedRepoRef.repo, filePath)
          : null;
      if (!target) return;

      if (activeView === 'edit' && hasUnsavedChanges) {
        const saveFirst = await showConfirm('You have unsaved changes. Save before editing another file?');
        if (saveFirst) {
          await onSave();
        } else {
          const discard = await showConfirm('Discard unsaved changes and continue editing another file?');
          if (!discard) return;
          setHasUnsavedChanges(false);
        }
      }

      navigate(target);
    },
    [
      currentGistId,
      repoAccessMode,
      selectedRepoRef,
      activeView,
      currentFileName,
      hasUnsavedChanges,
      onSave,
      navigate,
      showConfirm,
    ],
  );

  const handleViewOnGitHub = useCallback(
    (filePath: string) => {
      if (currentGistId) {
        window.open(`https://gist.github.com/${currentGistId}`, '_blank', 'noopener,noreferrer');
        return;
      }
      const repoFullName =
        repoAccessMode === 'installed'
          ? selectedRepo
          : repoAccessMode === 'public' && publicRepoRef
            ? `${publicRepoRef.owner}/${publicRepoRef.repo}`
            : null;
      if (!repoFullName) return;
      const repoPath = filePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      window.open(`https://github.com/${repoFullName}/blob/HEAD/${repoPath}`, '_blank', 'noopener,noreferrer');
    },
    [currentGistId, repoAccessMode, selectedRepo, publicRepoRef],
  );

  const handleViewFolderOnGitHub = useCallback(
    (folderPath: string) => {
      if (currentGistId) {
        window.open(`https://gist.github.com/${currentGistId}`, '_blank', 'noopener,noreferrer');
        return;
      }
      const repoFullName =
        repoAccessMode === 'installed'
          ? selectedRepo
          : repoAccessMode === 'public' && publicRepoRef
            ? `${publicRepoRef.owner}/${publicRepoRef.repo}`
            : null;
      if (!repoFullName) return;
      const repoPath = folderPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      window.open(`https://github.com/${repoFullName}/tree/HEAD/${repoPath}`, '_blank', 'noopener,noreferrer');
    },
    [currentGistId, repoAccessMode, selectedRepo, publicRepoRef],
  );

  const onHeaderViewInGitHub = useCallback(() => {
    if (currentGistId) {
      handleViewOnGitHub(currentFileName ?? '');
      return;
    }
    if (!currentRepoDocPath) return;
    handleViewOnGitHub(currentRepoDocPath);
  }, [currentGistId, currentFileName, currentRepoDocPath, handleViewOnGitHub]);

  const handleDeleteFile = useCallback(
    async (filePath: string) => {
      if (
        !(await showConfirm(`Delete "${filePath}"?`, {
          intent: 'danger',
          confirmLabel: 'Delete',
        }))
      )
        return;
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        if (store.kind === 'gist') {
          if (!currentGistId) return;
          const gist = await store.deleteFile({ name: filePath });
          setGistFiles(gist.files);
          const deletedCurrent = currentFileName === filePath;
          if (deletedCurrent) {
            const remaining = Object.keys(gist.files);
            if (remaining.length > 0) {
              navigate(routePath.gistView(currentGistId, remaining[0]));
            } else {
              navigate(routePath.workspaces());
            }
          }
        } else {
          const repoFile = findRepoDocFile(repoSidebarFiles, filePath);
          if (!repoFile) return;
          await store.deleteFile(repoFile);
          const remaining = repoFiles.filter((f) => f.path !== filePath);
          const remainingSidebar = repoSidebarFiles.filter((f) => f.path !== filePath);
          setRepoFiles(remaining);
          setRepoSidebarFiles(remainingSidebar);
          const deletedCurrent = currentRepoDocPath === repoFile.path;
          if (deletedCurrent) {
            if (remainingSidebar.length > 0) {
              if (selectedRepoRef) {
                navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, remainingSidebar[0].path));
              } else {
                navigate(routePath.workspaces());
              }
            } else {
              if (selectedRepoRef) {
                navigate(routePath.repoDocuments(selectedRepoRef.owner, selectedRepoRef.repo));
              } else {
                navigate(routePath.workspaces());
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to delete file');
      }
    },
    [
      getActiveDocumentStore,
      currentFileName,
      repoFiles,
      repoSidebarFiles,
      currentRepoDocPath,
      navigate,
      handleSessionExpired,
      showConfirm,
      showAlert,
      showRateLimitToastIfNeeded,
      currentGistId,
      selectedRepoRef,
    ],
  );

  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      const gistTargets = Object.keys(gistFiles ?? {}).filter((path) => isPathInFolder(path, folderPath));
      const repoTargets = repoSidebarFiles.filter((file) => isPathInFolder(file.path, folderPath));
      const deleteCount = currentGistId ? gistTargets.length : repoTargets.length;
      if (deleteCount === 0) return;
      if (
        !(await showConfirm(`Delete folder "${folderPath}" and ${deleteCount} file(s)?`, {
          intent: 'danger',
          confirmLabel: 'Delete',
        }))
      )
        return;
      let deleteToastId = -1;
      try {
        const store = getActiveDocumentStore();
        if (!store) return;
        if (store.kind === 'gist' && !currentGistId) return;
        deleteToastId = showLoadingToast(`Deleting ${deleteCount} file${deleteCount === 1 ? '' : 's'}...`);
        let completedCount = 0;
        let batchError: unknown = null;

        if (store.kind === 'gist') {
          const gistId = currentGistId;
          if (!gistId) return;
          let gist = null;
          for (const path of gistTargets) {
            try {
              gist = await store.deleteFile({ name: path });
              completedCount += 1;
            } catch (err) {
              batchError = err;
              break;
            }
          }
          if (gist) {
            setGistFiles(gist.files);
            const deletedCurrent = currentFileName ? isPathInFolder(currentFileName, folderPath) : false;
            if (deletedCurrent) {
              const remaining = Object.keys(gist.files);
              if (remaining.length > 0) {
                navigate(routePath.gistView(gistId, remaining[0]));
              } else {
                navigate(routePath.workspaces());
              }
            }
          }
        } else {
          const completedPaths = new Set<string>();
          for (const file of repoTargets) {
            try {
              await store.deleteFile(file);
              completedPaths.add(file.path);
              completedCount += 1;
            } catch (err) {
              batchError = err;
              break;
            }
          }
          const remaining = repoFiles.filter((file) => !completedPaths.has(file.path));
          const remainingSidebar = repoSidebarFiles.filter((file) => !completedPaths.has(file.path));
          setRepoFiles(remaining);
          setRepoSidebarFiles(remainingSidebar);
          const deletedCurrent = currentRepoDocPath ? completedPaths.has(currentRepoDocPath) : false;
          if (deletedCurrent) {
            if (remainingSidebar.length > 0) {
              if (selectedRepoRef) {
                navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, remainingSidebar[0].path));
              } else {
                navigate(routePath.workspaces());
              }
            } else {
              if (selectedRepoRef) {
                navigate(routePath.repoDocuments(selectedRepoRef.owner, selectedRepoRef.repo));
              } else {
                navigate(routePath.workspaces());
              }
            }
          }
        }
        dismissToast(deleteToastId);
        if (batchError) {
          showRateLimitToastIfNeeded(batchError);
          const remainingCount = Math.max(0, deleteCount - completedCount);
          void showAlert(
            `Folder delete partially completed (${completedCount}/${deleteCount}). ${remainingCount} file(s) remain. Run the same delete action again to resume.`,
          );
          return;
        }
        if (deleteCount > 1) {
          showSuccessToast(`Deleted ${completedCount} files`);
        }
      } catch (err) {
        if (deleteToastId >= 0) dismissToast(deleteToastId);
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to delete folder');
      }
    },
    [
      getActiveDocumentStore,
      gistFiles,
      repoSidebarFiles,
      currentGistId,
      showConfirm,
      currentFileName,
      navigate,
      repoFiles,
      currentRepoDocPath,
      handleSessionExpired,
      showAlert,
      showLoadingToast,
      showRateLimitToastIfNeeded,
      showSuccessToast,
      dismissToast,
      selectedRepoRef,
    ],
  );

  const handleRenameFile = useCallback(
    async (oldPath: string, newPath: string) => {
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        if (store.kind === 'gist') {
          if (!currentGistId) return;
          const gist = await store.renameFile({ name: oldPath }, newPath);
          setGistFiles(gist.files);
          if (currentFileName === oldPath) {
            setCurrentFileName(newPath);
            navigate(routePath.gistView(currentGistId, newPath));
          }
        } else {
          const oldFile = findRepoDocFile(repoSidebarFiles, oldPath);
          if (!oldFile) return;
          const created = await store.renameFile(oldFile, newPath);
          const updatedSidebarFiles = repoSidebarFiles
            .map((f) =>
              f.path === oldPath
                ? {
                    name: fileNameFromPath(newPath),
                    path: created.content.path,
                    sha: created.content.sha,
                    size: f.size,
                  }
                : f,
            )
            .sort((a, b) => a.path.localeCompare(b.path));
          const updatedFiles = isMarkdownFileName(newPath)
            ? repoFiles
                .map((f) =>
                  f.path === oldPath
                    ? {
                        name: fileNameFromPath(newPath),
                        path: created.content.path,
                        sha: created.content.sha,
                        size: f.size,
                      }
                    : f,
                )
                .sort((a, b) => a.path.localeCompare(b.path))
            : repoFiles.filter((f) => f.path !== oldPath);
          setRepoSidebarFiles(updatedSidebarFiles);
          setRepoFiles(updatedFiles);
          if (currentFileName === oldPath) {
            if (selectedRepoRef) {
              navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, created.content.path));
            } else {
              navigate(routePath.workspaces());
            }
          }
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        if (isPartialRepoRenameError(err)) {
          void showAlert(
            `${err instanceof Error ? err.message : 'Rename partially completed.'} Refresh the workspace and verify both paths before retrying.`,
          );
          return;
        }
        void showAlert(err instanceof Error ? err.message : 'Failed to rename file');
      }
    },
    [
      getActiveDocumentStore,
      currentGistId,
      currentFileName,
      repoFiles,
      repoSidebarFiles,
      navigate,
      handleSessionExpired,
      showAlert,
      showRateLimitToastIfNeeded,
      selectedRepoRef,
    ],
  );

  const handleBeforeRenameFile = useCallback(
    async (path: string): Promise<boolean> => {
      if (!isMarkdownFileName(path)) return true;
      if (activeView !== 'edit' || !hasUnsavedChanges) return true;

      const currentEditingPath = editingBackend === 'repo' ? currentRepoDocPath : currentFileName;
      if (currentEditingPath !== path) return true;

      const shouldSave = await showConfirm('Save this Markdown file before renaming?', {
        title: 'Unsaved changes',
        confirmLabel: 'Save',
        cancelLabel: 'Cancel',
        defaultFocus: 'action',
      });
      if (!shouldSave) return false;
      await onSave();
      return true;
    },
    [activeView, hasUnsavedChanges, editingBackend, currentRepoDocPath, currentFileName, showConfirm, onSave],
  );

  const handleRenameFolder = useCallback(
    async (oldPath: string, newPath: string) => {
      let renameToastId = -1;
      try {
        const store = getActiveDocumentStore();
        if (!store) return;
        if (store.kind === 'gist' && !currentGistId) return;
        renameToastId = showLoadingToast(`Renaming folder "${oldPath}"...`);
        let completedCount = 0;
        let batchError: unknown = null;

        if (store.kind === 'gist') {
          const gistId = currentGistId;
          if (!gistId) return;
          const paths = Object.keys(gistFiles ?? {}).filter((path) => isPathInFolder(path, oldPath));
          if (paths.length === 0) {
            dismissToast(renameToastId);
            return;
          }
          let gist = null;
          for (const path of paths) {
            const nextPath = renamePathWithNewFolder(path, oldPath, newPath);
            try {
              gist = await store.renameFile({ name: path }, nextPath);
              completedCount += 1;
            } catch (err) {
              batchError = err;
              break;
            }
          }
          if (gist) {
            setGistFiles(gist.files);
            if (currentFileName && isPathInFolder(currentFileName, oldPath)) {
              navigate(routePath.gistView(gistId, renamePathWithNewFolder(currentFileName, oldPath, newPath)));
            }
          }
          if (batchError) {
            showRateLimitToastIfNeeded(batchError);
            const total = paths.length;
            const remainingCount = Math.max(0, total - completedCount);
            dismissToast(renameToastId);
            void showAlert(
              `Folder rename partially completed (${completedCount}/${total}). ${remainingCount} file(s) remain at the old path. Run rename again to resume.`,
            );
            return;
          }
        } else {
          const paths = repoSidebarFiles.filter((file) => isPathInFolder(file.path, oldPath));
          if (paths.length === 0) {
            dismissToast(renameToastId);
            return;
          }
          const renamed = new Map<string, RepoDocFile>();
          for (const file of paths) {
            const nextPath = renamePathWithNewFolder(file.path, oldPath, newPath);
            try {
              const created = await store.renameFile(file, nextPath);
              renamed.set(file.path, {
                name: fileNameFromPath(nextPath),
                path: created.content.path,
                sha: created.content.sha,
                size: file.size,
              });
              completedCount += 1;
            } catch (err) {
              batchError = err;
              break;
            }
          }
          const updatedSidebarFiles = repoSidebarFiles
            .map((file) => renamed.get(file.path) ?? file)
            .sort((a, b) => a.path.localeCompare(b.path));
          setRepoSidebarFiles(updatedSidebarFiles);
          setRepoFiles(updatedSidebarFiles.filter((file) => isMarkdownFileName(file.path)));
          if (currentFileName && isPathInFolder(currentFileName, oldPath)) {
            if (selectedRepoRef) {
              navigate(
                routePath.repoFile(
                  selectedRepoRef.owner,
                  selectedRepoRef.repo,
                  renamePathWithNewFolder(currentFileName, oldPath, newPath),
                ),
              );
            } else {
              navigate(routePath.workspaces());
            }
          }
          if (batchError) {
            showRateLimitToastIfNeeded(batchError);
            const total = paths.length;
            const remainingCount = Math.max(0, total - completedCount);
            const message = isPartialRepoRenameError(batchError)
              ? `${batchError instanceof Error ? batchError.message : 'Rename partially completed.'} Refresh the workspace and verify both old/new paths before continuing.`
              : `Folder rename partially completed (${completedCount}/${total}). ${remainingCount} file(s) remain at the old path. Run rename again to resume.`;
            dismissToast(renameToastId);
            void showAlert(message);
            return;
          }
        }
        dismissToast(renameToastId);
        if (completedCount > 1) {
          showSuccessToast(`Renamed ${completedCount} files`);
        }
      } catch (err) {
        if (renameToastId >= 0) dismissToast(renameToastId);
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        if (isPartialRepoRenameError(err)) {
          void showAlert(
            `${err instanceof Error ? err.message : 'Rename partially completed.'} Refresh the workspace and verify both old/new paths before retrying.`,
          );
          return;
        }
        void showAlert(err instanceof Error ? err.message : 'Failed to rename folder');
      }
    },
    [
      getActiveDocumentStore,
      currentGistId,
      gistFiles,
      currentFileName,
      navigate,
      repoSidebarFiles,
      handleSessionExpired,
      showAlert,
      showLoadingToast,
      showRateLimitToastIfNeeded,
      showSuccessToast,
      dismissToast,
      selectedRepoRef,
    ],
  );

  // --- GitHub App callbacks ---
  const onSelectRepo = useCallback((fullName: string, id: number, isPrivate: boolean) => {
    setSelectedRepo(fullName);
    setSelectedRepoPrivate(isPrivate);
    storeSelectedRepo({ full_name: fullName, id, private: isPrivate });
  }, []);

  const onOpenRepoFromWorkspaces = useCallback(
    (fullName: string, id: number, isPrivate: boolean) => {
      onSelectRepo(fullName, id, isPrivate);
      const repoRef = parseRepoFullName(fullName);
      if (!repoRef) {
        navigate(routePath.workspaces());
        return;
      }
      navigate(routePath.repoDocuments(repoRef.owner, repoRef.repo));
    },
    [navigate, onSelectRepo],
  );

  const onOpenRepoMenu = useCallback(
    (_mode: 'auto' | 'manual' = 'manual') => {
      if (!user) return;
      const isAutoMode = _mode === 'auto';

      const shouldLoadRepos =
        Boolean(installationId) &&
        !installationReposLoading &&
        loadedReposInstallationId !== installationId &&
        (!isAutoMode || autoLoadAttemptedReposInstallationId !== installationId);
      const shouldLoadGists = !menuGistsLoading && !menuGistsLoaded && (!isAutoMode || !autoLoadAttemptedGists);
      if (!shouldLoadRepos && !shouldLoadGists) return;

      if (shouldLoadRepos && isAutoMode && installationId) {
        setAutoLoadAttemptedReposInstallationId(installationId);
      }
      if (shouldLoadGists && isAutoMode) {
        setAutoLoadAttemptedGists(true);
      }
      if (shouldLoadRepos) setInstallationReposLoading(true);
      if (shouldLoadGists) setMenuGistsLoading(true);

      void (async () => {
        const tasks: Promise<void>[] = [];

        if (shouldLoadRepos && installationId) {
          tasks.push(
            (async () => {
              try {
                const repos = await listInstallationRepos(installationId);
                setInstallationRepos(repos.repositories);
                setLoadedReposInstallationId(installationId);
                setReposLoadError(null);
              } catch (err) {
                if (err instanceof SessionExpiredError) {
                  handleSessionExpired();
                  return;
                }
                showRateLimitToastIfNeeded(err);
                setInstallationRepos([]);
                setReposLoadError(err instanceof Error ? err.message : 'Failed to load repos');
              } finally {
                setInstallationReposLoading(false);
              }
            })(),
          );
        }

        if (shouldLoadGists) {
          tasks.push(
            (async () => {
              try {
                const gists = await listGists(1, 30);
                setMenuGists(gists);
                setMenuGistsLoaded(true);
                setGistsLoadError(null);
              } catch (err) {
                showRateLimitToastIfNeeded(err);
                setMenuGists([]);
                setGistsLoadError(err instanceof Error ? err.message : 'Failed to load gists');
              } finally {
                setMenuGistsLoading(false);
              }
            })(),
          );
        }

        await Promise.all(tasks);
      })();
    },
    [
      user,
      installationId,
      installationReposLoading,
      loadedReposInstallationId,
      autoLoadAttemptedReposInstallationId,
      handleSessionExpired,
      menuGistsLoading,
      menuGistsLoaded,
      autoLoadAttemptedGists,
      showRateLimitToastIfNeeded,
    ],
  );

  useEffect(() => {
    if (!user || route.name === 'home') return;
    onOpenRepoMenu('auto');
  }, [user, route.name, onOpenRepoMenu]);

  const onDisconnect = useCallback(async () => {
    const confirmed = await showConfirm('Disconnect all repos?');
    if (!confirmed) return;

    try {
      await disconnectInstallation();
    } catch {
      /* still clear local state below */
    } finally {
      clearInstallationId();
      clearSelectedRepo();
      setInstId(null);
      setSelectedRepo(null);
      setSelectedRepoPrivate(null);
      setInstallationRepos([]);
      setLoadedReposInstallationId(null);
      setRepoFiles([]);
      setRepoSidebarFiles([]);
      navigate(routePath.workspaces());
    }
  }, [navigate, showConfirm]);

  // --- Render active view ---
  const renderView = () => {
    switch (activeView) {
      case 'workspaces': {
        const reposInitialLoaded = !installationId || loadedReposInstallationId === installationId;
        const gistsInitialLoaded = menuGistsLoaded;
        return user ? (
          <WorkspacesView
            installationId={installationId}
            availableRepos={installationRepos}
            repoListLoading={installationReposLoading}
            reposLoadError={reposLoadError}
            gistsLoadError={gistsLoadError}
            onLoadRepos={(mode) => onOpenRepoMenu(mode)}
            onRetryRepos={() => onOpenRepoMenu('manual')}
            onRetryGists={() => onOpenRepoMenu('manual')}
            onConnect={onConnectInstallation}
            onDisconnect={onDisconnect}
            onOpenRepo={onOpenRepoFromWorkspaces}
            reposInitialLoaded={reposInitialLoaded}
            gistsInitialLoaded={gistsInitialLoaded}
            initialGists={menuGists}
            navigate={navigate}
            userLogin={user.login}
            workspaceNotice={workspaceNotice}
            onDismissWorkspaceNotice={() => setWorkspaceNotice(null)}
          />
        ) : null;
      }
      case 'content':
        return (
          <ContentView
            html={renderedHtml}
            markdown={renderMode === 'markdown' || renderMode === 'image'}
            loading={contentLoadPending}
            imagePreview={contentImagePreview}
            claudeTranscript={isClaudeTranscript}
            alertMessage={contentAlertMessage}
            alertDownloadHref={contentAlertDownloadHref}
            alertDownloadName={contentAlertDownloadName}
            onImageClick={onOpenLightbox}
            onRequestMarkdownLinkPreview={onRequestMarkdownLinkPreview}
            onInternalLinkNavigate={(rawRoute) => {
              const routePathname = rawRoute.replace(/^\/+/, '');
              navigate(routePathname);
            }}
          />
        );
      case 'edit':
        return (
          <EditView
            content={editContent}
            previewHtml={editPreviewHtml}
            previewVisible={previewVisible}
            canRenderPreview={canRenderPreview}
            onTogglePreview={onTogglePreview}
            onContentChange={onEditContentChange}
            onPreviewImageClick={onOpenLightbox}
            onEditorPaste={handleEditorPaste}
            saving={saving}
            canSave={hasUnsavedChanges}
            onSave={onSave}
            imageUploadIssue={
              failedImageUpload
                ? {
                    message: `Image upload failed for ${failedImageUpload.imageName}.`,
                    onRetry: onRetryFailedImageUpload,
                    onRemovePlaceholder: onRemoveFailedImageUploadPlaceholder,
                  }
                : null
            }
          />
        );
      case 'loading':
        return <LoadingView />;
      case 'error':
        return (
          <ErrorView
            message={errorMessage}
            onRetry={() => {
              void handleRoute(route);
            }}
          />
        );
      default:
        return null;
    }
  };

  const sidebarFiles = useMemo(() => {
    if (gistFiles) {
      const files = Object.keys(gistFiles)
        .map((path) => ({
          path,
          active: path === currentFileName,
          editable: isMarkdownFileName(path),
          deemphasized: !isSidebarTextFileName(path),
          size: gistFiles[path]?.size,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return sidebarFileFilter === 'text' ? files.filter((file) => isSidebarTextFileName(file.path)) : files;
    }
    const sourceFiles = repoSidebarFiles;
    if (sourceFiles.length > 0 && currentRepoDocPath) {
      const currentPath = currentRepoDocPath;
      const files = sourceFiles.map((f) => ({
        path: f.path,
        active: f.path === currentPath,
        editable: isMarkdownFileName(f.path),
        deemphasized: !isSidebarTextFileName(f.path),
        size: f.size,
      }));
      return sidebarFileFilter === 'text' ? files.filter((file) => isSidebarTextFileName(file.path)) : files;
    }
    return [];
  }, [gistFiles, currentFileName, repoSidebarFiles, currentRepoDocPath, sidebarFileFilter]);
  const sidebarFileCounts = useMemo(() => {
    if (gistFiles) {
      const allPaths = Object.keys(gistFiles);
      return {
        text: allPaths.filter((path) => isSidebarTextFileName(path)).length,
        total: allPaths.length,
      };
    }
    const sourceFiles = repoSidebarFiles;
    if (sourceFiles.length > 0 && currentRepoDocPath) {
      return {
        text: sourceFiles.filter((file) => isSidebarTextFileName(file.path)).length,
        total: sourceFiles.length,
      };
    }
    return { text: 0, total: 0 };
  }, [gistFiles, repoSidebarFiles, currentRepoDocPath]);
  const sidebarWorkspaceKey = useMemo(() => {
    if (currentGistId) return `gist:${currentGistId}`;
    if (repoAccessMode === 'installed' && selectedRepo) return `repo:${selectedRepo}`;
    if (repoAccessMode === 'public' && publicRepoRef) return `public:${publicRepoRef.owner}/${publicRepoRef.repo}`;
    return 'none';
  }, [currentGistId, publicRepoRef, repoAccessMode, selectedRepo]);

  const sidebarEligible = activeView === 'content' || activeView === 'edit';
  const sidebarDisabled = activeView === 'edit' && draftMode;
  const isAnonymousGistWorkspace = currentGistId !== null && !user;
  const defaultShowSidebar =
    isDesktopWidth && !sidebarDisabled && (!!user || repoAccessMode === 'public' || currentGistId !== null);
  const showSidebar = sidebarEligible && (sidebarVisibilityOverride ?? defaultShowSidebar);
  const handleSidebarDocumentStep = useCallback(
    async (direction: -1 | 1) => {
      if (!showSidebar || sidebarFiles.length < 2) return;
      const activeIndex = sidebarFiles.findIndex((file) => file.active);
      if (activeIndex < 0) return;
      const nextIndex = activeIndex + direction;
      if (nextIndex < 0 || nextIndex >= sidebarFiles.length) return;
      const nextFile = sidebarFiles[nextIndex];
      if (!nextFile) return;

      if (activeView === 'edit' && hasUnsavedChanges) {
        const shouldSave = await showConfirm('Save this document before switching files?', {
          title: 'Unsaved changes',
          confirmLabel: 'Save',
          cancelLabel: 'Cancel',
          defaultFocus: 'action',
        });
        if (!shouldSave) return;
        await onSave();
      }

      navigateToSidebarFile(nextFile.path);
    },
    [activeView, hasUnsavedChanges, navigateToSidebarFile, onSave, showConfirm, showSidebar, sidebarFiles],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.metaKey || !event.ctrlKey || event.altKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.closest('input, select, [contenteditable="true"]') !== null ||
          (target.closest('textarea') !== null && target.closest('textarea.doc-editor') === null))
      ) {
        return;
      }

      event.preventDefault();
      void handleSidebarDocumentStep(event.key === 'ArrowUp' ? -1 : 1);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSidebarDocumentStep]);
  const editingFileName = currentFileName ?? editTitle;
  const editPreviewEnabled = isMarkdownFileName(editingFileName);
  const canRenderPreview = editPreviewEnabled && isDesktopWidth;
  const showLoggedOutNewDocPreviewDescription =
    route.name === 'new' && activeView === 'edit' && !user && editContent.trim().length === 0;
  const showEditorCancel = activeView === 'edit' && !draftMode && repoAccessMode !== 'public';
  const showEditorSave = activeView === 'edit' && !(draftMode && !user) && repoAccessMode !== 'public';
  const editPreviewWikiLinkResolver = useMemo(() => {
    if (!editPreviewEnabled) return undefined;

    if (editingBackend === 'repo') {
      if (!currentRepoDocPath) return undefined;
      const knownMarkdownPaths = repoFiles.filter((file) => isMarkdownFileName(file.path)).map((file) => file.path);
      const wikiPaths = knownMarkdownPaths.includes(currentRepoDocPath)
        ? knownMarkdownPaths
        : [...knownMarkdownPaths, currentRepoDocPath];
      return createWikiLinkResolver(currentRepoDocPath, wikiPaths);
    }

    if (!currentFileName) return undefined;
    const knownMarkdownPaths = Object.keys(gistFiles ?? {}).filter((path) => isMarkdownFileName(path));
    const wikiPaths = knownMarkdownPaths.includes(currentFileName)
      ? knownMarkdownPaths
      : [...knownMarkdownPaths, currentFileName];
    return createWikiLinkResolver(currentFileName, wikiPaths);
  }, [editPreviewEnabled, editingBackend, currentRepoDocPath, repoFiles, currentFileName, gistFiles]);
  const editPreviewHtml = useMemo(
    () =>
      editPreviewEnabled
        ? parseMarkdownToHtml(
            showLoggedOutNewDocPreviewDescription ? LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION : editContent,
            {
              resolveImageSrc: (src) =>
                resolveMarkdownImageSrc(src, editingBackend === 'repo' ? currentRepoDocPath : null),
              resolveWikiLinkMeta: editPreviewWikiLinkResolver,
            },
          )
        : '',
    [
      currentRepoDocPath,
      editPreviewEnabled,
      editContent,
      editPreviewWikiLinkResolver,
      editingBackend,
      resolveMarkdownImageSrc,
      showLoggedOutNewDocPreviewDescription,
    ],
  );
  const onToggleSidebar = useCallback(() => {
    setSidebarVisibilityOverride((prev) => {
      const current = prev ?? defaultShowSidebar;
      return !current;
    });
  }, [defaultShowSidebar]);
  const onSidebarSplitPointerDown = useCallback(
    (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (!isDesktopWidth) return;
      const onMove = (moveEvent: globalThis.PointerEvent) => {
        setSidebarWidth(clampSidebarWidth(moveEvent.clientX));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      event.preventDefault();
    },
    [isDesktopWidth],
  );
  const onReaderAiSplitPointerDown = useCallback(
    (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (!isDesktopWidth) return;
      const onMove = (moveEvent: globalThis.PointerEvent) => {
        setReaderAiWidth(clampReaderAiWidth(window.innerWidth - moveEvent.clientX));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      event.preventDefault();
    },
    [isDesktopWidth],
  );
  const onOpenLightbox = useCallback((image: HTMLImageElement) => {
    const src = image.currentSrc.trim() || (image.getAttribute('src') ?? '').trim();
    if (!src) return;
    let lightboxSrc = src;
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(image, 0, 0);
          lightboxSrc = canvas.toDataURL('image/png');
        }
      } catch {
        // Cross-origin images can taint canvas; fall back to original src.
      }
    }
    setLightboxImage({ src: lightboxSrc, alt: image.getAttribute('alt') ?? '' });
  }, []);
  const onCloseLightbox = useCallback(() => {
    setLightboxImage(null);
  }, []);
  const onEditContentChange = useCallback((content: string) => {
    setEditContent(content);
    setHasUnsavedChanges(true);
  }, []);
  const handleSignInWithGitHub = useCallback(() => {
    if (isSubdomainMode()) {
      const { protocol, hostname, port } = window.location;
      const apexHost = hostname.endsWith('.input.md')
        ? 'input.md'
        : hostname.endsWith('.localhost')
          ? port
            ? `localhost:${port}`
            : 'localhost'
          : 'input.md';
      window.location.assign(`${protocol}//${apexHost}/input.md`);
      return;
    }
    startGitHubSignIn(`/${routePath.workspaces()}`, { force: true });
  }, [startGitHubSignIn]);
  const showHeaderEdit =
    activeView === 'content' &&
    isMarkdownFileName(currentFileName) &&
    (currentGistId !== null || (currentRepoDocPath !== null && repoAccessMode === 'installed'));
  const showReaderAiToggle = showReaderAiToggleCandidate && readerAiConfigured;
  const showReaderAiPanel = showReaderAiToggle && readerAiVisible;
  const showGistHeaderShare = currentGistId !== null && (route.name === 'gist' || route.name === 'edit');
  const showInstalledRepoHeaderShare =
    repoAccessMode === 'installed' &&
    currentRepoDocPath !== null &&
    (route.name === 'repoedit' || (route.name === 'repofile' && Boolean(user)));
  const showHeaderShare = showInstalledRepoHeaderShare || showGistHeaderShare;
  const inRepoContext =
    (activeView === 'content' || activeView === 'edit') &&
    repoAccessMode === 'installed' &&
    (currentRepoDocPath !== null || (editingBackend === 'repo' && selectedRepo !== null));
  const showHeaderLeftLoading = activeView === 'loading' && Boolean(user);
  const goToWorkspaceTarget = useMemo<GoToWorkspaceTarget | null>(() => {
    if (route.name !== 'repofile' || !user || !installationId) return null;
    const owner = safeDecodeURIComponent(route.params.owner);
    const repo = safeDecodeURIComponent(route.params.repo);
    const filePath = safeDecodeURIComponent(route.params.path).replace(/^\/+/, '');
    const repoFullName = `${owner}/${repo}`.toLowerCase();
    const matchedRepo = installationRepos.find((candidate) => candidate.full_name.toLowerCase() === repoFullName);
    if (!matchedRepo) return null;
    return { filePath, repo: matchedRepo };
  }, [route, user, installationId, installationRepos]);
  const onGoToWorkspace = useCallback(() => {
    if (!goToWorkspaceTarget) return;
    onSelectRepo(goToWorkspaceTarget.repo.full_name, goToWorkspaceTarget.repo.id, goToWorkspaceTarget.repo.private);
    const repoRef = parseRepoFullName(goToWorkspaceTarget.repo.full_name);
    if (!repoRef) {
      navigate(routePath.workspaces());
      return;
    }
    navigate(routePath.repoFile(repoRef.owner, repoRef.repo, goToWorkspaceTarget.filePath));
  }, [goToWorkspaceTarget, navigate, onSelectRepo]);

  return (
    <>
      <Toolbar
        view={activeView}
        user={user}
        selectedRepo={selectedRepo}
        selectedRepoPrivate={selectedRepoPrivate}
        inRepoContext={inRepoContext}
        availableRepos={installationRepos}
        repoListLoading={installationReposLoading}
        reposLoadError={reposLoadError}
        menuGists={menuGists.slice(0, 6)}
        menuGistsLoading={menuGistsLoading}
        gistsLoadError={gistsLoadError}
        draftMode={draftMode}
        sidebarVisible={showSidebar}
        showShare={showHeaderShare}
        onShare={() => {
          void onShareLink();
        }}
        onViewInGitHub={onHeaderViewInGitHub}
        showEdit={showHeaderEdit}
        editUrl={null}
        navigate={navigate}
        onOpenRepoMenu={onOpenRepoMenu}
        onRetryRepos={() => onOpenRepoMenu('manual')}
        onRetryGists={() => onOpenRepoMenu('manual')}
        onSelectRepo={onSelectRepo}
        onSignOut={signOut}
        onClearCache={onClearCaches}
        onToggleTheme={toggleTheme}
        onToggleSidebar={onToggleSidebar}
        onEdit={onEdit}
        showLeftLoading={showHeaderLeftLoading}
        // Show only when a public repo file can be switched into an installed workspace:
        // route is a repo file, user is signed in with an installation, and the URL repo
        // matches one of the user's installation repos.
        showGoToWorkspace={repoAccessMode === 'public' && Boolean(goToWorkspaceTarget)}
        onGoToWorkspace={onGoToWorkspace}
        showPreviewToggle={activeView === 'edit' && editPreviewEnabled}
        previewVisible={previewVisible}
        onTogglePreview={onTogglePreview}
        showAiToggle={showReaderAiToggle}
        aiVisible={showReaderAiPanel}
        onToggleAi={onToggleReaderAi}
        showCancel={showEditorCancel}
        onCancel={onCancel}
        showSave={showEditorSave}
        saving={saving}
        canSave={hasUnsavedChanges}
        onSave={onSave}
        onSignInWithGitHub={handleSignInWithGitHub}
      />
      <div
        class={`${showSidebar ? 'app-body app-body--with-sidebar' : 'app-body app-body--no-sidebar'}${showReaderAiPanel ? ' app-body--with-reader-ai' : ''}`}
        style={
          showSidebar || showReaderAiPanel
            ? ({
                ...(showSidebar ? { '--sidebar-width': `${sidebarWidth}px` } : {}),
                ...(showReaderAiPanel ? { '--reader-ai-width': `${readerAiWidth}px` } : {}),
              } as JSX.CSSProperties)
            : undefined
        }
      >
        {showSidebar && (
          <>
            <div class="sidebar-backdrop" onClick={onToggleSidebar} />
            <Sidebar
              key={sidebarWorkspaceKey}
              files={sidebarFiles}
              textFileCount={sidebarFileCounts.text}
              totalFileCount={sidebarFileCounts.total}
              fileFilter={sidebarFileFilter}
              onFileFilterChange={setSidebarFileFilter}
              onSelectFile={handleSelectFile}
              onEditFile={handleEditFile}
              onViewOnGitHub={handleViewOnGitHub}
              onViewFolderOnGitHub={handleViewFolderOnGitHub}
              canViewOnGitHub={currentGistId !== null || selectedRepo !== null || publicRepoRef !== null}
              disabled={sidebarDisabled}
              readOnly={repoAccessMode === 'public' || isAnonymousGistWorkspace}
              onCreateFile={handleCreateFile}
              onCreateDirectory={handleCreateDirectory}
              onDeleteFile={handleDeleteFile}
              onDeleteFolder={handleDeleteFolder}
              onBeforeRenameFile={handleBeforeRenameFile}
              onRenameFile={handleRenameFile}
              onRenameFolder={handleRenameFolder}
            />
            <div
              class="sidebar-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSidebarSplitPointerDown}
            />
          </>
        )}
        <ErrorBoundary
          fallbackMessage="This screen crashed while rendering."
          resetKey={route.name}
          onReset={() => {
            void handleRoute(route);
          }}
        >
          <main>{renderView()}</main>
        </ErrorBoundary>
        {showReaderAiPanel ? (
          <>
            <div
              class="reader-ai-splitter"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onReaderAiSplitPointerDown}
            />
            <ReaderAiPanel
              authenticated={Boolean(user)}
              models={readerAiModels}
              modelsLoading={readerAiModelsLoading}
              modelsError={readerAiModelsError}
              selectedModel={readerAiSelectedModel}
              onSelectModel={setReaderAiSelectedModel}
              messages={readerAiMessages}
              sending={readerAiSending}
              toolStatus={readerAiToolStatus}
              toolLog={readerAiToolLog}
              stagedChanges={readerAiStagedChanges}
              applyingChanges={readerAiApplyingChanges}
              canApplyChanges={
                (repoAccessMode === 'installed' && Boolean(installationId && selectedRepo)) ||
                (isGistContext && Boolean(currentGistId && user))
              }
              onApplyChanges={(msg) => void onReaderAiApplyChanges(msg)}
              error={readerAiError}
              onSend={onReaderAiSend}
              onEditMessage={onReaderAiEditMessage}
              onRetryLastUserMessage={onReaderAiRetryLastMessage}
              onStop={onReaderAiStop}
              onClear={onReaderAiClear}
              repoModeAvailable={repoModeAvailable}
              repoModeEnabled={readerAiRepoMode}
              repoModeLoading={readerAiRepoModeLoading}
              repoModeFileCount={repoModeFileCount}
              repoModeDisabledReason={repoModeDisabledReason}
              onToggleRepoMode={(enabled) => void onToggleRepoMode(enabled)}
            />
          </>
        ) : null}
      </div>
      {lightboxImage && <ImageLightbox src={lightboxImage.src} alt={lightboxImage.alt} onClose={onCloseLightbox} />}
    </>
  );
}
