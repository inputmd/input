import { applyPatch as applyDiffPatch, createTwoFilesPatch } from 'diff';
import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseAnsiToHtml } from './ansi';
import { ApiError, isRateLimitError, rateLimitToastMessage, responseToApiError } from './api_error';
import { onCacheEvent } from './cache_events';
import { CompactCommitsDialog } from './components/CompactCommitsDialog';
import type { EditorDiffPreview } from './components/codemirror_diff_preview';
import type { BracePromptRequest, InlinePromptRequest } from './components/codemirror_inline_prompt';
import { useDialogs } from './components/DialogProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { EditorController } from './components/editor_controller';
import { ForkRepoDialog } from './components/ForkRepoDialog';
import { ImageLightbox } from './components/ImageLightbox';
import type { PromptListRequest } from './components/markdown_editor_commands';
import { normalizeBlockquotePaste } from './components/markdown_editor_commands';
import { type ReaderAiMessage, ReaderAiPanel } from './components/ReaderAiPanel';
import { Sidebar, type SidebarFile, type SidebarFileFilter } from './components/Sidebar';
import { useToast } from './components/ToastProvider';
import { type ActiveView, Toolbar } from './components/Toolbar';
import { stripCriticMarkupComments } from './criticmarkup.ts';
import { parseDocumentEditorsFromMarkdown, parseMarkdownFrontMatterBlock } from './document_permissions.ts';
import { createGistDocumentStore, createRepoDocumentStore, findRepoDocFile, type RepoDocFile } from './document_store';
import { resolveForkTargetInstallationId, resolveForkTargetRepoFullName } from './fork_repo';
import { markGistRecentlyCreated, markGistRecentlyDeleted } from './gist_consistency';
import {
  clearGitHubCaches,
  createGist,
  deleteGist,
  type GistDetail,
  type GistFile,
  type GistSummary,
  type GitHubUser,
  getAuthSession,
  getGist,
  listGists,
  logout,
  updateGist,
  updateGistDescription,
} from './github';
import {
  clearGitHubAppCaches,
  clearInstallationId,
  clearPendingInstallationId,
  clearSelectedRepo,
  compactRepoRecentCommits,
  consumeInstallState,
  createInstallationSession,
  createInstallState,
  createRepoFileShareLink,
  createRepoFilesAtomic,
  deleteRepoPathsAtomic,
  disconnectInstallation,
  getEditorSharedRepoFile,
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
  getSharedRepoFileByRef,
  hasInstallState,
  type InstallationRepo,
  isRepoFile,
  type LinkedInstallation,
  listInstallationRepos,
  listRepoRecentCommits,
  publicRepoRawFileUrl,
  putEditorSharedRepoFile,
  putRepoFile,
  type RepoFileEntry,
  type RepoRecentCommitsResult,
  type RepoTreeResult,
  rememberInstallState,
  renameRepoPathsAtomic,
  repoRawFileUrl,
  SessionExpiredError,
  selectInstallation as selectGitHubInstallation,
  setInstallationId,
  setPendingInstallationId,
  setSelectedRepo as storeSelectedRepo,
  tryBuildRepoFilesFromCache,
} from './github_app';
import {
  type GitHubRateLimitSnapshot,
  readStoredGitHubRateLimitSnapshot,
  recordGitHubRateLimitFromResponse,
  recordServerLocalRateLimitFromResponse,
  subscribeGitHubRateLimitUpdates,
} from './github_rate_limit';
import { removeDocumentDraft, useDocumentPersistence } from './hooks/useDocumentPersistence';
import { type StackEntry, useDocumentStack } from './hooks/useDocumentStack';
import { useRoute } from './hooks/useRoute';
import { buildImageMarkdown } from './image_markdown';
import {
  extensionFromMimeType,
  fetchFullGistFileText,
  fetchWithTimeout,
  maybeResizePastedImage,
} from './image_processing';
import { isEditableShortcutTarget, matchesControlShortcut } from './keyboard_shortcuts';
import { parseMarkdownDocument, parseMarkdownToHtml } from './markdown';
import {
  commonPrefixLength,
  commonSuffixLength,
  dirName,
  fileNameFromPath,
  folderDeleteConfirmMessage,
  formatBytes,
  isEditableTextFilePath,
  isLikelyBinaryBytes,
  isPathInFolder,
  isSafeImageFileName,
  isSidebarTextFileName,
  isSidebarTextListPath,
  isVisibleSidebarFilePath,
  parentFolderPath,
  renamePathWithNewFolder,
  resolveRepoAssetPath,
  safeDecodeURIComponent,
  sanitizeDroppedFileName,
  sanitizeScratchFileNameInput,
  sanitizeTitleToFileName,
} from './path_utils';
import { formatPromptListAnswer } from './prompt_list_format';
import { splitPromptListStableText } from './prompt_list_streaming';
import {
  applyReaderAiChanges,
  askReaderAiStream,
  createReaderAiProjectSession,
  deleteReaderAiProjectSession,
  formatReaderAiModelDisplayName,
  listReaderAiModels,
  localCodexEnabledByPreference,
  type ReaderAiModel,
  type ReaderAiStagedChange,
  readerAiModelPriorityRank,
  resetReaderAiProjectSession,
  setLocalCodexEnabledByPreference,
  updateReaderAiProjectSessionFile,
} from './reader_ai';
import {
  buildReaderAiHistoryDocumentKey,
  clearReaderAiMessagesFromHistory,
  loadReaderAiEntryFromHistory,
  persistReaderAiMessagesToHistory,
} from './reader_ai_history';
import { READER_AI_SELECTION_MAX_CHARS } from './reader_ai_limits';
import { matchRoute, type Route, routePath } from './routing';
import {
  buildRepoNewDraftPath,
  buildScratchFilePath,
  clearPersistedNewGistFileDraft,
  DEFAULT_SCRATCH_FILENAME,
  mergeScratchRouteState,
  resolveActiveScratchFile,
  resolveNewGistFileDraft,
  resolveRepoNewDraftPath,
  resolveRepoNewFilePath,
  writePersistedNewGistFileDraft,
} from './scratch_files';
import { clearStoredScrollPositions } from './scroll_positions';
import { isSubdomainMode } from './subdomain';
import {
  decodeBase64ToBytes,
  encodeBytesToBase64,
  encodeUtf8ToBase64,
  isMarkdownFileName,
  reusableImageSrc,
} from './util';
import { ContentView } from './views/ContentView';
import { DocumentStackView } from './views/DocumentStackView';
import { EditSessionView } from './views/EditSessionView';
import { EditView } from './views/EditView';
import { ErrorView } from './views/ErrorView';
import { LoadingView } from './views/LoadingView';
import { WorkspacesView } from './views/WorkspacesView';
import {
  buildRepoFullName,
  createWikiLinkResolver,
  findMarkdownDirectoryIndexPath,
  type PublicRepoRef,
  parseGitHubRepoFullNameInput,
  parseRepoFullName,
  pickPreferredRepoMarkdownFile,
} from './wiki_links';

const EDITOR_PREVIEW_VISIBLE_KEY = 'editor_preview_visible';
const READER_AI_VISIBLE_KEY = 'reader_ai_visible';
const READER_AI_MODEL_KEY = 'reader_ai_model';
const READER_AI_WIDTH_KEY = 'reader_ai_width_px';
const SIDEBAR_VISIBLE_KEY = 'sidebar_visible';
const SIDEBAR_WIDTH_KEY = 'sidebar_width_px';
const DESKTOP_MEDIA_QUERY = '(min-width: 769px)';
const DRAFT_TITLE_KEY = 'draft_title';
const DRAFT_CONTENT_KEY = 'draft_content';
const DEFAULT_NEW_FILENAME = 'index.md';
const UNSAVED_FILE_LABEL = 'Unsaved file';
const UNSAVED_STATUS_TEXT = 'Unsaved';
const REPO_NEW_DRAFT_KEY_PREFIX = 'repo_new_draft_v2';
const DEFAULT_SIDEBAR_WIDTH_PX = 220;
const MIN_SIDEBAR_WIDTH_PX = 180;
const MAX_SIDEBAR_WIDTH_PX = 420;
const DEFAULT_READER_AI_WIDTH_PX = 360;
const MIN_READER_AI_WIDTH_PX = 280;
const MAX_READER_AI_WIDTH_PX = 640;
const SIDEBAR_FILE_FILTER_KEY = 'sidebar_file_filter';
const SIDEBAR_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const OAUTH_REDIRECT_GUARD_KEY = 'oauth_redirect_guard';
const OAUTH_REDIRECT_GUARD_WINDOW_MS = 15_000;
const AUTO_ONCE_GUARD_KEY_PREFIX = 'auto_once_guard:';
const MARKDOWN_LINK_PREVIEW_MAX_CHARS = 1800;
const MARKDOWN_LINK_PREVIEW_MAX_LINES = 18;
const READER_AI_SOURCE_MAX_CHARS = 140_000;
const DRAFT_PERSIST_DELAY_MS = 250;
const INPUT_GITHUB_REPO_FULL_NAME = 'inputmd/input';
const INPUT_GITHUB_SOURCE_PATH = 'README.md';
const EDIT_CONTENT_SNAPSHOT_DELAY_MS = 250;
const RECENT_REPOS_STORAGE_KEY = 'recent_repos_v1';
const MAX_RECENT_REPOS = 10;

interface RecentRepoVisit {
  fullName: string;
  installationId: string | null;
  source: 'installed' | 'public';
}

interface ForkRepoDialogState {
  installations: LinkedInstallation[];
  selectedInstallationId: string;
  selectedRepoFullName: string;
  sourcePath: string;
  sourceContent: string;
}

function autoOnceGuardStorageKey(key: string): string {
  return `${AUTO_ONCE_GUARD_KEY_PREFIX}${key}`;
}

function isRecentRepoVisit(value: unknown): value is RecentRepoVisit {
  if (!value || typeof value !== 'object') return false;
  const fullName = (value as { fullName?: unknown }).fullName;
  const installationId = (value as { installationId?: unknown }).installationId;
  const source = (value as { source?: unknown }).source;
  return (
    typeof fullName === 'string' &&
    fullName.length > 0 &&
    (typeof installationId === 'string' || installationId === null) &&
    (source === 'installed' || source === 'public')
  );
}

function readStoredRecentRepos(): RecentRepoVisit[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentRepoVisit).slice(0, MAX_RECENT_REPOS);
  } catch {
    return [];
  }
}

function writeStoredRecentRepos(recentRepos: RecentRepoVisit[]): void {
  try {
    localStorage.setItem(RECENT_REPOS_STORAGE_KEY, JSON.stringify(recentRepos.slice(0, MAX_RECENT_REPOS)));
  } catch {
    // Ignore localStorage failures.
  }
}

function pushRecentRepoVisit(
  existingRecentRepos: RecentRepoVisit[],
  nextRecentRepo: RecentRepoVisit,
): RecentRepoVisit[] {
  const normalizedFullName = nextRecentRepo.fullName.toLowerCase();
  return [
    nextRecentRepo,
    ...existingRecentRepos.filter((candidate) => candidate.fullName.toLowerCase() !== normalizedFullName),
  ].slice(0, MAX_RECENT_REPOS);
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

function repoNewDraftKey(
  installationId: string,
  repoFullName: string,
  path: string,
  field: 'title' | 'content',
): string {
  return `${REPO_NEW_DRAFT_KEY_PREFIX}:${installationId}:${repoFullName}:${path}:${field}`;
}

function upsertRepoFile(files: RepoDocFile[], next: RepoDocFile): RepoDocFile[] {
  const existingIndex = files.findIndex((file) => file.path === next.path);
  if (existingIndex === -1) return [...files, next].sort((a, b) => a.path.localeCompare(b.path));
  const updated = [...files];
  updated[existingIndex] = next;
  return updated;
}

function renameRepoDocFiles(files: RepoDocFile[], renames: Array<{ from: string; to: string }>): RepoDocFile[] {
  if (renames.length === 0) return files;
  const renameMap = new Map(renames.map((entry) => [entry.from, entry.to]));
  return files
    .map((file) => {
      const nextPath = renameMap.get(file.path);
      if (!nextPath) return file;
      return {
        ...file,
        name: fileNameFromPath(nextPath),
        path: nextPath,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function repoDocFilesFromTree(result: RepoTreeResult, markdownOnly: boolean): RepoDocFile[] {
  if (Array.isArray(result.entries) && result.entries.length > 0) {
    return result.entries
      .filter((entry) => entry.type === 'file')
      .filter((entry) => (markdownOnly ? isMarkdownFileName(entry.path) : true))
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
      }));
  }
  if (markdownOnly) return result.files.filter((file) => isMarkdownFileName(file.path));
  return result.files;
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
  template.content.querySelectorAll('.prompt-list-header').forEach((header) => {
    header.remove();
  });
  return template.innerHTML;
}

function trimReaderAiSource(source: string): string {
  if (source.length <= READER_AI_SOURCE_MAX_CHARS) return source;
  return source.slice(source.length - READER_AI_SOURCE_MAX_CHARS);
}

type ReaderAiConversationScope = { kind: 'document' } | { kind: 'selection'; source: string };

function stripLeadingFrontMatter(source: string): string {
  const normalized = source.replace(/^\uFEFF/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
  const frontMatter = parseMarkdownFrontMatterBlock(normalized);
  if (!frontMatter || frontMatter.error) return source;
  return frontMatter.content;
}

function estimateApproxReaderAiTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

function buildReaderAiContextLogPayload(options: {
  model: ReaderAiModel | null;
  source: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  summary?: string;
  mode: 'default' | 'prompt_list';
  projectMode: boolean;
  currentDocPath?: string | null;
}) {
  const summary = options.summary?.trim() ?? '';
  const sourceTokens = estimateApproxReaderAiTokens(options.source);
  const messageTokens =
    options.messages.reduce((sum, message) => sum + estimateApproxReaderAiTokens(message.content) + 8, 0) +
    options.messages.length * 4;
  const summaryTokens = estimateApproxReaderAiTokens(summary);
  const approxInputTokens = sourceTokens + messageTokens + summaryTokens;
  const contextLength = options.model?.context_length ?? 0;
  const approxRemainingTokens = contextLength > 0 ? Math.max(0, contextLength - approxInputTokens) : null;

  return {
    model: options.model?.id ?? 'unknown',
    mode: options.mode,
    projectMode: options.projectMode,
    currentDocPath: options.currentDocPath ?? null,
    messageCount: options.messages.length,
    sourceChars: options.source.length,
    summaryChars: summary.length,
    approxInputTokens,
    approxRemainingTokens,
    approxContextUsedPercent: contextLength > 0 ? Number(((approxInputTokens / contextLength) * 100).toFixed(2)) : null,
    contextLength: contextLength > 0 ? contextLength : null,
    note:
      contextLength > 0
        ? options.projectMode
          ? 'Approximate client-side estimate; excludes server-added system prompt and project context.'
          : 'Approximate client-side estimate; excludes server-added system prompt and tool overhead.'
        : 'Model context length unavailable.',
  };
}

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH_PX, Math.min(MAX_SIDEBAR_WIDTH_PX, width));
}

function clampReaderAiWidth(width: number): number {
  return Math.max(MIN_READER_AI_WIDTH_PX, Math.min(MAX_READER_AI_WIDTH_PX, width));
}

function isPaidReaderAiModel(model: ReaderAiModel): boolean {
  return model.provider !== 'codex_local' && !model.id.trim().toLowerCase().endsWith(':free');
}

function readerAiModelPenalty(model: ReaderAiModel): number {
  const normalized = `${model.id} ${model.name}`.toLowerCase();
  return /\b(?:trinity|opus|sonnet)\b/u.test(normalized) ? 1 : 0;
}

function accessibleReaderAiModels(models: ReaderAiModel[], authenticated: boolean): ReaderAiModel[] {
  return authenticated ? models : models.filter((model) => !isPaidReaderAiModel(model));
}

function firstPaidReaderAiModelId(models: ReaderAiModel[]): string {
  return models.find(isPaidReaderAiModel)?.id ?? '';
}

function prioritizeReaderAiModels(models: ReaderAiModel[]): ReaderAiModel[] {
  return models
    .map((model, originalIndex) => ({
      model,
      originalIndex,
      rank: readerAiModelPriorityRank(model),
      modelPenalty: readerAiModelPenalty(model),
    }))
    .sort((a, b) => {
      const aLocal = a.model.provider === 'codex_local';
      const bLocal = b.model.provider === 'codex_local';
      if (aLocal !== bLocal) return aLocal ? -1 : 1;
      if (a.rank !== b.rank) {
        if (a.rank === -1) return 1;
        if (b.rank === -1) return -1;
        return a.rank - b.rank;
      }
      if (a.modelPenalty !== b.modelPenalty) return a.modelPenalty - b.modelPenalty;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ model }) => model);
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

function routeKeyForGist(gistId: string, filename?: string | null): string {
  return `gist:${gistId}:${filename ?? ''}`;
}

function routeKeyForRepo(owner: string, repo: string, path: string): string {
  return `repo:${owner.toLowerCase()}/${repo.toLowerCase()}:${path}`;
}

function routeKeyFromRoute(route: Route): string | null {
  if (route.name === 'gist') {
    const filename = route.params.filename ? safeDecodeURIComponent(route.params.filename) : undefined;
    return routeKeyForGist(route.params.id, filename);
  }
  if (route.name === 'edit') {
    const filename = route.params.filename ? safeDecodeURIComponent(route.params.filename) : undefined;
    return routeKeyForGist(route.params.id, filename);
  }
  if (route.name === 'repofile') {
    return routeKeyForRepo(
      safeDecodeURIComponent(route.params.owner),
      safeDecodeURIComponent(route.params.repo),
      safeDecodeURIComponent(route.params.path).replace(/^\/+/, ''),
    );
  }
  if (route.name === 'repoedit') {
    return routeKeyForRepo(
      safeDecodeURIComponent(route.params.owner),
      safeDecodeURIComponent(route.params.repo),
      safeDecodeURIComponent(route.params.path).replace(/^\/+/, ''),
    );
  }
  return null;
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
    case 'repodocuments':
      return isSubdomainMode() ? 'content' : 'workspaces';
    case 'repofile':
    case 'sharefile':
    case 'gist':
      return 'content';
    default:
      return 'edit';
  }
}

function routeShowsHeaderLeftControls(route: Route, authenticated: boolean): boolean {
  if (!authenticated) return false;
  const view = viewFromRoute(route);
  return view === 'content' || view === 'edit';
}

interface PendingDraftRestoreState {
  documentDraftKey: string;
  content: string;
  saveAfterRestore?: boolean;
}

interface PendingForkRepoDraftState {
  title: string;
  content: string;
}

type CommitResult =
  | {
      kind: 'repo';
      created: boolean;
      owner: string | null;
      repo: string | null;
      path: string;
      routeKey: string | null;
    }
  | {
      kind: 'gist';
      created: boolean;
      gistId: string;
      filename: string;
      routeKey: string;
    };

function generateUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  const unchangedLineCount = oldContent.length === 0 ? 0 : oldContent.split('\n').length;
  const noChangesLabel = `(no changes, ${unchangedLineCount} line${unchangedLineCount === 1 ? '' : 's'})`;
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldContent, newContent, undefined, undefined, {
    context: 3,
  });
  const lines = patch.split('\n');
  const startIndex = lines.findIndex((line) => line.startsWith('---'));
  if (startIndex < 0) return noChangesLabel;
  if (!lines.some((line) => line.startsWith('@@'))) return noChangesLabel;
  const result = lines.slice(startIndex).join('\n').trimEnd();
  return result || noChangesLabel;
}

function buildEditorDiffPreview(change: ReaderAiStagedChange | undefined): EditorDiffPreview | null {
  if (!change || change.type === 'delete') return null;
  if (typeof change.modifiedContent !== 'string') return null;
  if (change.type === 'create') {
    return {
      blocks: [
        {
          kind: 'insert',
          from: 0,
          to: 0,
          insert: change.modifiedContent,
          label: 'Reader AI proposal',
        },
      ],
      source: 'Reader AI proposal',
    };
  }
  const original = typeof change.originalContent === 'string' ? change.originalContent : null;
  if (original === null) return null;
  const modified = change.modifiedContent;
  if (original === modified) return null;
  const start = commonPrefixLength(original, modified);
  const trailingOverlap = commonSuffixLength(original.slice(start), modified.slice(start));
  const originalTrimmedEnd = original.length - trailingOverlap;
  const modifiedTrimmedEnd = modified.length - trailingOverlap;
  const replacement = modified.slice(start, modifiedTrimmedEnd);
  const deleted = original.slice(start, originalTrimmedEnd);
  const blocks: EditorDiffPreview['blocks'] = [];
  if (deleted.length > 0) {
    blocks.push({
      kind: replacement.length > 0 ? 'replace' : 'delete',
      from: Math.max(0, start),
      to: Math.max(0, originalTrimmedEnd),
      label: replacement.length > 0 ? 'Replace' : 'Delete',
      deletedText: deleted,
    });
  }
  if (replacement.length > 0) {
    blocks.push({
      kind: deleted.length > 0 ? 'replace' : 'insert',
      from: Math.max(0, start),
      to: Math.max(0, originalTrimmedEnd),
      insert: replacement,
      label: deleted.length > 0 ? 'Insert' : 'Reader AI proposal',
    });
  }
  if (blocks.length === 0) return null;
  return {
    blocks,
    source: 'Reader AI proposal',
  };
}

function buildReaderAiSelectedChange(
  change: ReaderAiStagedChange,
  selectedHunkIds: Set<string> | undefined,
): ReaderAiStagedChange | null {
  if (!change.hunks || change.hunks.length === 0) return change;
  if (!selectedHunkIds || selectedHunkIds.size === 0) return null;
  const visibleHunks = change.hunks.filter((hunk) => selectedHunkIds.has(hunk.id));
  if (visibleHunks.length === 0) return null;
  if (visibleHunks.length === change.hunks.length) return change;
  const original =
    change.type === 'create'
      ? ''
      : typeof change.originalContent === 'string'
        ? change.originalContent
        : change.originalContent === null
          ? ''
          : null;
  if (original === null) return null;
  const partialDiff = [
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    ...visibleHunks.flatMap((hunk) => [
      hunk.header,
      ...hunk.lines.map((line) => {
        if (line.type === 'add') return `+${line.content}`;
        if (line.type === 'del') return `-${line.content}`;
        return ` ${line.content}`;
      }),
    ]),
  ].join('\n');
  const patched = applyDiffPatch(original, partialDiff);
  if (patched === false) return null;
  return {
    ...change,
    diff: partialDiff,
    modifiedContent: change.type === 'delete' ? null : patched,
    hunks: visibleHunks,
  } satisfies ReaderAiStagedChange;
}

function parsePendingDraftRestore(state: unknown): PendingDraftRestoreState | null {
  if (!state || typeof state !== 'object') return null;
  const restoreDraft = (state as { restoreDraft?: unknown }).restoreDraft;
  if (!restoreDraft || typeof restoreDraft !== 'object') return null;
  const documentDraftKey = (restoreDraft as { documentDraftKey?: unknown }).documentDraftKey;
  const content = (restoreDraft as { content?: unknown }).content;
  const saveAfterRestore = (restoreDraft as { saveAfterRestore?: unknown }).saveAfterRestore;
  if (typeof documentDraftKey !== 'string' || typeof content !== 'string') return null;
  return { documentDraftKey, content, saveAfterRestore: saveAfterRestore === true };
}

function parsePendingForkRepoDraftState(state: unknown): PendingForkRepoDraftState | null {
  if (!state || typeof state !== 'object') return null;
  const forkRepoDraft = (state as { forkRepoDraft?: unknown }).forkRepoDraft;
  if (!forkRepoDraft || typeof forkRepoDraft !== 'object') return null;
  const title = (forkRepoDraft as { title?: unknown }).title;
  const content = (forkRepoDraft as { content?: unknown }).content;
  if (typeof title !== 'string' || typeof content !== 'string') return null;
  return { title, content };
}

function parseScratchReturnPathState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const returnToPath = (state as { returnToPath?: unknown }).returnToPath;
  return typeof returnToPath === 'string' && returnToPath.length > 0 ? returnToPath : null;
}

function withScratchSidebarFile(files: SidebarFile[], scratchPath: string | null): SidebarFile[] {
  if (!scratchPath) return files;
  const nextFiles = files.filter((file) => file.path !== scratchPath);
  nextFiles.push({
    path: scratchPath,
    active: true,
    editable: true,
    deemphasized: false,
    virtual: true,
  });
  nextFiles.sort((a, b) => a.path.localeCompare(b.path));
  return nextFiles;
}

export function App() {
  const { route, routeState, navigate, setNavigationPrompt } = useRoute();
  const documentStack = useDocumentStack();
  const { showAlert, showConfirm, showDiffChoice, showPrompt } = useDialogs();
  const { showSuccessToast, showFailureToast, showLoadingToast, dismissToast } = useToast();

  // --- Shared state ---
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [installationId, setInstId] = useState<string | null>(getInstallationId());
  const [linkedInstallations, setLinkedInstallations] = useState<LinkedInstallation[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(getSelectedRepo()?.full_name ?? null);
  const [selectedRepoPrivate, setSelectedRepoPrivate] = useState<boolean | null>(getSelectedRepo()?.private ?? null);
  const [selectedRepoInstallationId, setSelectedRepoInstallationId] = useState<string | null>(
    getSelectedRepo()?.installationId ?? getInstallationId(),
  );
  const [sharedRepoInstallationId, setSharedRepoInstallationId] = useState<string | null>(null);
  const [publicRepoRef, setPublicRepoRef] = useState<PublicRepoRef | null>(null);
  const [repoAccessMode, setRepoAccessMode] = useState<'installed' | 'shared' | 'public' | null>(null);
  const [installationReposById, setInstallationReposById] = useState<Record<string, InstallationRepo[]>>({});
  const [loadingInstallationRepoIds, setLoadingInstallationRepoIds] = useState<Set<string>>(() => new Set());
  const [reposLoadErrorsById, setReposLoadErrorsById] = useState<Record<string, string>>({});
  const [autoLoadAttemptedReposInstallationId, setAutoLoadAttemptedReposInstallationId] = useState<string | null>(null);
  const [menuGists, setMenuGists] = useState<GistSummary[]>([]);
  const [menuGistsLoading, setMenuGistsLoading] = useState(false);
  const [menuGistsLoaded, setMenuGistsLoaded] = useState(false);
  const [menuGistsPage, setMenuGistsPage] = useState(1);
  const [menuGistsAllLoaded, setMenuGistsAllLoaded] = useState(false);
  const [recentRepos, setRecentRepos] = useState<RecentRepoVisit[]>(() => readStoredRecentRepos());
  const [forkRepoDialog, setForkRepoDialog] = useState<ForkRepoDialogState | null>(null);
  const [forkRepoSubmitting, setForkRepoSubmitting] = useState(false);
  const [autoLoadAttemptedGists, setAutoLoadAttemptedGists] = useState(false);
  const [gistsLoadError, setGistsLoadError] = useState<string | null>(null);
  const installationRepos = installationId ? (installationReposById[installationId] ?? []) : [];
  const installationReposLoading = installationId !== null && loadingInstallationRepoIds.has(installationId);
  const loadedReposInstallationId = installationId && installationReposById[installationId] ? installationId : null;
  const reposLoadError = installationId ? (reposLoadErrorsById[installationId] ?? null) : null;
  const activeInstalledRepoInstallationId = selectedRepoInstallationId ?? installationId;
  const forkRepoDialogRepos = forkRepoDialog
    ? (installationReposById[forkRepoDialog.selectedInstallationId] ?? [])
    : [];
  const forkRepoDialogReposLoading = forkRepoDialog
    ? loadingInstallationRepoIds.has(forkRepoDialog.selectedInstallationId)
    : false;
  const forkRepoDialogReposLoadError = forkRepoDialog
    ? (reposLoadErrorsById[forkRepoDialog.selectedInstallationId] ?? null)
    : null;
  const [localRateLimit, setLocalRateLimit] = useState<GitHubRateLimitSnapshot | null>(() =>
    readStoredGitHubRateLimitSnapshot('serverLocal'),
  );
  const [serverRateLimit, setServerRateLimit] = useState<GitHubRateLimitSnapshot | null>(() =>
    readStoredGitHubRateLimitSnapshot('server'),
  );
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [compactCommitsOpen, setCompactCommitsOpen] = useState(false);
  const [compactCommitsLoading, setCompactCommitsLoading] = useState(false);
  const [compactCommitsSubmitting, setCompactCommitsSubmitting] = useState(false);
  const [compactCommitsError, setCompactCommitsError] = useState<string | null>(null);
  const [compactCommitsData, setCompactCommitsData] = useState<RepoRecentCommitsResult | null>(null);
  const [compactCommitMessage, setCompactCommitMessage] = useState('Compact recent commits');
  const [compactCommitSelection, setCompactCommitSelection] = useState<Set<string>>(new Set());

  // --- View state ---
  const [viewPhase, setViewPhase] = useState<'loading' | 'error' | null>('loading');
  const [renderedHtml, setRenderedHtml] = useState('');
  const [renderedCustomCss, setRenderedCustomCss] = useState<string | null>(null);
  const [renderedCustomCssScope, setRenderedCustomCssScope] = useState<string | null>(null);
  const [renderedText, setRenderedText] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<'ansi' | 'markdown' | 'image'>('ansi');
  const [contentLoadPending, setContentLoadPending] = useState(false);
  const [preserveHeaderLeftControlsWhileLoading, setPreserveHeaderLeftControlsWhileLoading] = useState(false);
  const [contentImagePreview, setContentImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const [contentAlertMessage, setContentAlertMessage] = useState<string | null>(null);
  const [contentAlertDownloadHref, setContentAlertDownloadHref] = useState<string | null>(null);
  const [contentAlertDownloadName, setContentAlertDownloadName] = useState<string | null>(null);
  const [readerAiVisible, setReaderAiVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (route.name === 'new') return false;
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
  const [localCodexEnabled, setLocalCodexEnabled] = useState(() => localCodexEnabledByPreference());
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
  const [readerAiConversationScope, setReaderAiConversationScope] = useState<ReaderAiConversationScope | null>(null);
  const [readerAiHasEligibleSelection, setReaderAiHasEligibleSelection] = useState(false);
  const [readerAiSending, setReaderAiSending] = useState(false);
  const [contentSourceViewVisible, setContentSourceViewVisible] = useState(false);
  const [readerAiToolStatus, setReaderAiToolStatus] = useState<string | null>(null);
  const [readerAiToolLog, setReaderAiToolLog] = useState<
    Array<{ type: 'call' | 'result' | 'progress'; name: string; detail?: string; taskId?: string }>
  >([]);
  const [readerAiStagedChanges, setReaderAiStagedChanges] = useState<ReaderAiStagedChange[]>([]);
  const readerAiStagedChangesStreaming = readerAiSending && readerAiStagedChanges.length > 0;
  const [readerAiAppliedChanges, setReaderAiAppliedChanges] = useState<
    Array<{ path: string; type: 'edit' | 'create' | 'delete'; appliedAt: string }>
  >([]);
  const [readerAiUndoState, setReaderAiUndoState] = useState<{
    path: string;
    content: string;
    revision: number;
  } | null>(null);
  const [readerAiStagedChangesInvalid, setReaderAiStagedChangesInvalid] = useState(false);
  const [readerAiStagedFileContents, setReaderAiStagedFileContents] = useState<Record<string, string>>({});
  const [readerAiDocumentEditedContent, setReaderAiDocumentEditedContent] = useState<string | null>(null);
  const [readerAiSuggestedCommitMessage, setReaderAiSuggestedCommitMessage] = useState('');
  const [readerAiApplyingChanges, setReaderAiApplyingChanges] = useState(false);
  const [inlinePromptStreaming, setInlinePromptStreaming] = useState(false);
  const [readerAiError, setReaderAiError] = useState<string | null>(null);
  const [readerAiRepoMode, setReaderAiRepoMode] = useState(false);
  const [readerAiRepoModeLoading, setReaderAiRepoModeLoading] = useState(false);
  const [readerAiRepoFiles, setReaderAiRepoFiles] = useState<RepoFileEntry[] | null>(null);
  const [readerAiProjectId, setReaderAiProjectId] = useState<string | null>(null);
  const [readerAiSuggestProjectMode, setReaderAiSuggestProjectMode] = useState(false);
  const [readerAiRetryAfterProjectModeEnable, setReaderAiRetryAfterProjectModeEnable] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [currentGistId, setCurrentGistId] = useState<string | null>(null);
  const [currentGistCreatedAt, setCurrentGistCreatedAt] = useState<string | null>(null);
  const [currentGistUpdatedAt, setCurrentGistUpdatedAt] = useState<string | null>(null);
  const [currentRepoDocPath, setCurrentRepoDocPath] = useState<string | null>(null);
  const [currentRepoDocSha, setCurrentRepoDocSha] = useState<string | null>(null);
  const [editingBackend, setEditingBackend] = useState<'gist' | 'repo' | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editContentOrigin, setEditContentOrigin] = useState<'userEdits' | 'external' | 'streaming' | 'appEdits'>(
    'appEdits',
  );
  const [editContentRevision, setEditContentRevision] = useState(0);
  const [draftMode, setDraftMode] = useState(false);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [gistFiles, setGistFiles] = useState<Record<string, GistFile> | null>(null);
  const [repoFiles, setRepoFiles] = useState<RepoDocFile[]>([]);
  const [repoSidebarFiles, setRepoSidebarFiles] = useState<RepoDocFile[]>([]);
  const [editContentSelection, setEditContentSelection] = useState<{ anchor: number; head: number } | null>(null);
  const [failedImageUpload, setFailedImageUpload] = useState<PendingImageUpload | null>(null);
  const [pendingImageUploads, setPendingImageUploads] = useState<Set<string>>(() => new Set());
  const [sidebarVisibilityOverride, setSidebarVisibilityOverride] = useState<boolean | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = localStorage.getItem(SIDEBAR_VISIBLE_KEY);
      if (saved === 'true') return true;
      if (saved === 'false') return false;
      return null;
    } catch {
      return null;
    }
  });
  const [sidebarFileFilter, setSidebarFileFilter] = useState<SidebarFileFilter>(() => {
    if (typeof window === 'undefined') return 'text';
    try {
      const saved = localStorage.getItem(SIDEBAR_FILE_FILTER_KEY);
      if (saved === 'markdown') return 'markdown';
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
  const [readerAiSelectedChangeIds, setReaderAiSelectedChangeIds] = useState<Set<string>>(() => new Set());
  const [readerAiSelectedHunkIdsByChangeId, setReaderAiSelectedHunkIdsByChangeId] = useState<
    Record<string, Set<string>>
  >(() => ({}));
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
  const effectiveReaderAiStagedChanges = useMemo(
    () =>
      readerAiStagedChanges.flatMap((change) => {
        if (change.id && !readerAiSelectedChangeIds.has(change.id)) return [];
        const effectiveChange = buildReaderAiSelectedChange(
          change,
          change.id ? readerAiSelectedHunkIdsByChangeId[change.id] : undefined,
        );
        return effectiveChange ? [effectiveChange] : [];
      }),
    [readerAiSelectedChangeIds, readerAiSelectedHunkIdsByChangeId, readerAiStagedChanges],
  );
  const effectiveReaderAiStagedFileContents = useMemo(
    () =>
      Object.fromEntries(
        effectiveReaderAiStagedChanges
          .filter((change) => change.type !== 'delete' && typeof change.modifiedContent === 'string')
          .map((change) => [change.path, change.modifiedContent as string]),
      ),
    [effectiveReaderAiStagedChanges],
  );
  // Track initialization
  const initialized = useRef(false);
  const markdownLinkPreviewCacheRef = useRef(new Map<string, { title: string; html: string } | null>());
  const markdownLinkPreviewPendingRef = useRef(new Map<string, Promise<{ title: string; html: string } | null>>());
  const readerAiAbortRef = useRef<AbortController | null>(null);
  const inlinePromptAbortRef = useRef<AbortController | null>(null);
  const editViewControllerRef = useRef<EditorController | null>(null);
  const readerAiStagedChangesRef = useRef<ReaderAiStagedChange[]>(readerAiStagedChanges);
  const readerAiSelectedChangeIdsRef = useRef<Set<string>>(readerAiSelectedChangeIds);
  const readerAiSelectedHunkIdsByChangeIdRef = useRef<Record<string, Set<string>>>(readerAiSelectedHunkIdsByChangeId);
  const currentFileNameRef = useRef<string | null>(currentFileName);
  const readerAiPrevHistoryKeyRef = useRef<string | null>(null);
  const readerAiSkipPersistHistoryKeyRef = useRef<string | null>(null);
  const prevRouteNameRef = useRef(route.name);
  const readerAiSkipPersistVisibleRef = useRef(false);
  const pendingGistDraftDirtyRef = useRef(false);
  const editContentRef = useRef(editContent);
  const editContentSnapshotTimerRef = useRef<number | null>(null);
  const hydratedLocalDraftKeysRef = useRef(new Set<string>());
  const externalEditSessionIdRef = useRef(0);
  const hasTypedInExternalEditSessionRef = useRef(false);
  currentFileNameRef.current = currentFileName;
  const cancelEditContentSnapshot = useCallback(() => {
    if (editContentSnapshotTimerRef.current == null) return;
    window.clearTimeout(editContentSnapshotTimerRef.current);
    editContentSnapshotTimerRef.current = null;
  }, []);
  useEffect(() => {
    readerAiStagedChangesRef.current = readerAiStagedChanges;
  }, [readerAiStagedChanges]);
  useEffect(() => {
    readerAiSelectedChangeIdsRef.current = readerAiSelectedChangeIds;
  }, [readerAiSelectedChangeIds]);
  useEffect(() => {
    readerAiSelectedHunkIdsByChangeIdRef.current = readerAiSelectedHunkIdsByChangeId;
  }, [readerAiSelectedHunkIdsByChangeId]);
  const scheduleEditContentSnapshot = useCallback(
    (update: { content: string; revision: number }) => {
      cancelEditContentSnapshot();
      editContentSnapshotTimerRef.current = window.setTimeout(() => {
        editContentSnapshotTimerRef.current = null;
        setEditContent((previousContent) => (previousContent === update.content ? previousContent : update.content));
        setEditContentOrigin('userEdits');
        setEditContentRevision((previousRevision) => Math.max(previousRevision, update.revision));
        setEditContentSelection(null);
      }, EDIT_CONTENT_SNAPSHOT_DELAY_MS);
    },
    [cancelEditContentSnapshot],
  );
  const setNextEditContent = useCallback(
    (
      nextContent: string | ((previousContent: string) => string),
      options: {
        origin: 'userEdits' | 'external' | 'streaming' | 'appEdits';
        revision?: number;
        selection?: { anchor: number; head: number } | null;
      },
    ) => {
      cancelEditContentSnapshot();
      setEditContent(() => {
        const resolvedContent = typeof nextContent === 'function' ? nextContent(editContentRef.current) : nextContent;
        editContentRef.current = resolvedContent;
        return resolvedContent;
      });
      setEditContentOrigin(options.origin);
      setEditContentRevision((previousRevision) => options?.revision ?? previousRevision + 1);
      setEditContentSelection(options?.selection ?? null);
    },
    [cancelEditContentSnapshot],
  );
  useEffect(() => cancelEditContentSnapshot, [cancelEditContentSnapshot]);
  const beginExternalEditSession = useCallback(() => {
    externalEditSessionIdRef.current += 1;
    hasTypedInExternalEditSessionRef.current = false;
    return externalEditSessionIdRef.current;
  }, []);
  const canApplyExternalEditSession = useCallback((sessionId: number) => {
    return sessionId === externalEditSessionIdRef.current && !hasTypedInExternalEditSessionRef.current;
  }, []);
  const shouldHydrateLocalDraftForRoute = useCallback((draftKey: string) => {
    if (!hydratedLocalDraftKeysRef.current.has(draftKey)) {
      hydratedLocalDraftKeysRef.current.add(draftKey);
      return true;
    }
    console.warn('Blocked repeated local draft hydration after first mount.', { draftKey });
    return false;
  }, []);
  const applyInstallationSessionState = useCallback(
    (sessionState: { installationId?: string | null; installations?: LinkedInstallation[] }) => {
      const nextInstallationId = sessionState.installationId ?? null;
      const nextInstallations = sessionState.installations ?? [];
      setLinkedInstallations(nextInstallations);
      if (nextInstallationId) {
        setInstallationId(nextInstallationId);
      } else {
        clearInstallationId();
      }
      setInstId(nextInstallationId);
    },
    [],
  );
  const resetInstalledRepoSelectionState = useCallback(() => {
    clearSelectedRepo();
    setSelectedRepo(null);
    setSelectedRepoPrivate(null);
    setSelectedRepoInstallationId(null);
    setRepoFiles([]);
    setRepoSidebarFiles([]);
  }, []);
  const clearInstalledRepoSelection = useCallback(() => {
    resetInstalledRepoSelectionState();
    if (repoAccessMode === 'installed') {
      navigate(routePath.workspaces());
    }
  }, [navigate, repoAccessMode, resetInstalledRepoSelectionState]);
  const routeView = viewFromRoute(route);
  const activeView = viewPhase ?? routeView;
  const currentRouteKey = routeKeyFromRoute(route);
  const sharedRepoFullNameForPersistence =
    route.name === 'repofile' || route.name === 'repoedit'
      ? `${safeDecodeURIComponent(route.params.owner)}/${safeDecodeURIComponent(route.params.repo)}`
      : null;
  const persistence = useDocumentPersistence({
    repoAccessMode,
    installationId,
    selectedRepoInstallationId,
    selectedRepo,
    sharedRepoInstallationId,
    sharedRepoFullName: sharedRepoFullNameForPersistence,
    currentRepoDocPath,
    currentRepoDocSha,
    currentGistId,
    currentGistUpdatedAt,
    currentFileName,
    user,
    editContent,
    editingBackend,
    activeView,
    draftMode,
    currentRouteKey,
    routeName: route.name,
    showFailureToast,
  });
  const {
    currentDocumentSavedContent,
    setCurrentDocumentSavedContent,
    currentDocumentDraft,
    setCurrentDocumentDraft,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    hasUserTypedUnsavedChanges,
    setHasUserTypedUnsavedChanges,
    saving,
    setSaving,
    postSaveVerification,
    updatePostSaveVerification,
    saveInFlightRef,
    postSaveVerificationRef,
    currentDocumentDraftKey,
    shouldPreserveVerifiedContent,
    hasDivergedDocumentDraft,
    currentDocumentContent,
    hasRestorableDocumentDraft,
    saveStatusTone,
  } = persistence;
  const targetRepoEditPath =
    route.name === 'repoedit' ? safeDecodeURIComponent(route.params.path).replace(/^\/+/, '') : null;
  const repoEditLoading =
    route.name === 'repoedit' &&
    (currentRepoDocPath !== null || currentFileName !== null) &&
    (editingBackend !== 'repo' || currentRepoDocPath !== targetRepoEditPath || currentFileName !== targetRepoEditPath);
  const currentEditingDocPath = useMemo(
    () => (editingBackend === 'repo' ? currentRepoDocPath : currentFileName),
    [editingBackend, currentRepoDocPath, currentFileName],
  );
  const currentEditorDiffPreview = useMemo(() => {
    if (activeView !== 'edit' || !currentEditingDocPath) return null;
    const currentChange = effectiveReaderAiStagedChanges.find((change) => change.path === currentEditingDocPath);
    return buildEditorDiffPreview(currentChange);
  }, [activeView, currentEditingDocPath, effectiveReaderAiStagedChanges]);
  const isScratchDocument = useMemo(
    () =>
      activeView === 'edit' &&
      ((editingBackend === 'repo' && currentRepoDocPath === null) ||
        (editingBackend === 'gist' && currentFileName === null)),
    [activeView, editingBackend, currentRepoDocPath, currentFileName],
  );
  const activeScratchFile = useMemo(
    () =>
      resolveActiveScratchFile({
        editingBackend,
        route,
        routeState,
        currentRepoDocPath,
        currentGistId,
        currentFileName,
        unsavedFileLabel: UNSAVED_FILE_LABEL,
      }),
    [currentFileName, currentGistId, currentRepoDocPath, editingBackend, route, routeState],
  );
  const currentDocumentLabel =
    currentFileName ?? currentRepoDocPath ?? (isScratchDocument ? UNSAVED_FILE_LABEL : 'this document');
  const readerAiEditEligible =
    routeView === 'edit' && (isMarkdownFileName(currentFileName ?? editTitle) || isScratchDocument);
  const readerAiContentEligible =
    routeView === 'content' &&
    ((renderMode === 'markdown' && Boolean(readerAiSource)) ||
      (contentLoadPending && isMarkdownFileName(currentFileName)));
  const readerAiHistoryEligible = readerAiContentEligible || readerAiEditEligible;
  const readerAiEditLocked =
    activeView === 'edit' && (readerAiSending || readerAiApplyingChanges || inlinePromptStreaming);
  const editorLockLabel = useMemo(() => {
    const selectedModel = readerAiModels.find((model) => model.id === readerAiSelectedModel);
    return selectedModel ? formatReaderAiModelDisplayName(selectedModel) : 'Reader AI';
  }, [readerAiModels, readerAiSelectedModel]);
  const selectedReaderAiModel = useMemo(
    () => readerAiModels.find((model) => model.id === readerAiSelectedModel) ?? null,
    [readerAiModels, readerAiSelectedModel],
  );
  const readerAiAuthenticated = Boolean(user);
  const preferPaidReaderAiModelOnNextLoadRef = useRef(false);
  const resetReaderAiModelsForAuth = useCallback((authenticated: boolean) => {
    setReaderAiModels((current) => {
      const next = accessibleReaderAiModels(current, authenticated);
      setReaderAiSelectedModel((selected) => {
        if (selected && next.some((model) => model.id === selected)) return selected;
        return next[0]?.id ?? '';
      });
      return next;
    });
    if (!authenticated) preferPaidReaderAiModelOnNextLoadRef.current = false;
    setReaderAiModelsError(null);
    setReaderAiConfigured(true);
  }, []);
  const clearAuthDataCaches = useCallback(() => {
    clearGitHubCaches();
    clearGitHubAppCaches();
    setMenuGists([]);
    setMenuGistsLoaded(false);
    setMenuGistsPage(1);
    setMenuGistsAllLoaded(false);
    setMenuGistsLoading(false);
    setAutoLoadAttemptedGists(false);
    setGistsLoadError(null);
    setInstallationReposById({});
    setLoadingInstallationRepoIds(new Set());
    setAutoLoadAttemptedReposInstallationId(null);
    setReposLoadErrorsById({});
  }, []);
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
  const currentDocumentScrollKey = useMemo(
    () => routeKeyFromRoute(route) ?? readerAiHistoryDocumentKey,
    [route, readerAiHistoryDocumentKey],
  );
  const isContentRoute = useCallback((nextRoute: Route) => {
    return nextRoute.name === 'gist' || nextRoute.name === 'repofile' || nextRoute.name === 'sharefile';
  }, []);

  const clearRenderedContent = useCallback(() => {
    setRenderedHtml('');
    setRenderedCustomCss(null);
    setRenderedCustomCssScope(null);
    setRenderedText(null);
    setRenderMode('ansi');
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

  useEffect(() => {
    return onCacheEvent(() => {
      clearMarkdownLinkPreviewCache();
    });
  }, [clearMarkdownLinkPreviewCache]);

  const saveStatusText = useMemo(() => {
    if (isScratchDocument) return UNSAVED_STATUS_TEXT;
    if (!shouldPreserveVerifiedContent || !postSaveVerification) return null;
    return postSaveVerification.status === 'verifying'
      ? 'Verifying saved version...'
      : 'Showing local version while GitHub catches up';
  }, [isScratchDocument, postSaveVerification, shouldPreserveVerifiedContent]);

  const hasEffectiveUnsavedChanges = useMemo(() => {
    if (!hasUnsavedChanges) return false;
    if (activeView !== 'edit') return true;
    if (isScratchDocument) return editContent.trim().length > 0;
    if (currentDocumentSavedContent === null) return editContent.trim().length > 0;
    return editContent !== currentDocumentSavedContent || hasRestorableDocumentDraft;
  }, [
    activeView,
    currentDocumentSavedContent,
    editContent,
    hasRestorableDocumentDraft,
    hasUnsavedChanges,
    isScratchDocument,
  ]);

  useEffect(() => {
    setNavigationPrompt(
      activeView === 'edit' && hasEffectiveUnsavedChanges ? 'You have unsaved changes. Discard?' : null,
    );
  }, [activeView, hasEffectiveUnsavedChanges, setNavigationPrompt]);

  const clearOAuthRedirectGuard = useCallback(() => {
    try {
      sessionStorage.removeItem(OAUTH_REDIRECT_GUARD_KEY);
    } catch {}
  }, []);

  useEffect(() => {
    void editTitle;
    pendingGistDraftDirtyRef.current = draftMode && editingBackend === 'gist' && currentGistId === null;
  }, [currentGistId, draftMode, editTitle, editingBackend]);

  const persistPendingGistDraft = useCallback(() => {
    if (!draftMode || editingBackend !== 'gist' || currentGistId !== null) return;
    if (!pendingGistDraftDirtyRef.current) return;
    try {
      localStorage.setItem(DRAFT_TITLE_KEY, editTitle);
      localStorage.setItem(DRAFT_CONTENT_KEY, editContentRef.current);
      pendingGistDraftDirtyRef.current = false;
    } catch {
      // Best effort only; continue with OAuth redirect.
    }
  }, [currentGistId, draftMode, editTitle, editingBackend]);

  const persistNewGistFileDraft = useCallback(() => {
    if (activeView !== 'edit' || editingBackend !== 'gist' || !currentGistId || currentFileName !== null) return;
    const persisted =
      activeScratchFile?.backend === 'gist' && activeScratchFile.gistId === currentGistId
        ? activeScratchFile.draft
        : resolveNewGistFileDraft(currentGistId, routeState, { defaultTitle: UNSAVED_FILE_LABEL });
    writePersistedNewGistFileDraft(currentGistId, {
      title: editTitle || persisted?.title || UNSAVED_FILE_LABEL,
      content: editContentRef.current,
      filename: persisted?.filename || DEFAULT_SCRATCH_FILENAME,
      parentPath: persisted?.parentPath || '',
    });
  }, [activeScratchFile, activeView, currentFileName, currentGistId, editTitle, editingBackend, routeState]);

  const persistRepoNewDraft = useCallback(() => {
    if (route.name !== 'reponew') return;
    if (editingBackend !== 'repo' || currentRepoDocPath) return;
    const instId = activeInstalledRepoInstallationId ?? getInstallationId();
    const owner = safeDecodeURIComponent(route.params.owner);
    const repo = safeDecodeURIComponent(route.params.repo);
    const repoName = buildRepoFullName(owner, repo);
    if (!instId || !repoName) return;
    const path = safeDecodeURIComponent(route.params.path).replace(/^\/+/, '');
    localStorage.setItem(repoNewDraftKey(instId, repoName, path, 'title'), editTitle);
    localStorage.setItem(repoNewDraftKey(instId, repoName, path, 'content'), editContentRef.current);
  }, [route, editingBackend, currentRepoDocPath, activeInstalledRepoInstallationId, editTitle]);

  const startGitHubSignIn = useCallback(
    (returnTo: string, options?: { force?: boolean; guardKey?: string; includeGists?: boolean }) => {
      const normalizedReturnTo = returnTo.startsWith('/') ? returnTo : `/${returnTo}`;
      const currentPath = window.location.pathname;
      persistPendingGistDraft();
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
      const authUrl = new URL('/api/auth/github/start', window.location.origin);
      authUrl.searchParams.set('return_to', normalizedReturnTo);
      if (options?.includeGists === false) authUrl.searchParams.set('include_gists', '0');
      window.location.assign(authUrl.toString());
      return true;
    },
    [persistPendingGistDraft, showError],
  );

  const handleSessionExpired = useCallback(() => {
    clearInstallationId();
    clearSelectedRepo();
    setUser(null);
    setInstId(null);
    setLinkedInstallations([]);
    setSelectedRepo(null);
    setSelectedRepoPrivate(null);
    setSelectedRepoInstallationId(null);
    setSharedRepoInstallationId(null);
    setRepoAccessMode(null);
    setPublicRepoRef(null);
    setInstallationReposById({});
    setLoadingInstallationRepoIds(new Set());
    setReposLoadErrorsById({});
    setRepoFiles([]);
    setRepoSidebarFiles([]);
    setCurrentDocumentSavedContent(null);
    setCurrentDocumentDraft(null);
    setErrorMessage('Session expired. Sign in with GitHub from the header to continue.');
    setViewPhase('error');
  }, [setCurrentDocumentDraft, setCurrentDocumentSavedContent]);

  const focusEditorSoon = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.doc-editor .cm-content')?.focus();
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
        const effectiveInstallationId = repoSource?.installationId ?? activeInstalledRepoInstallationId;
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
    [activeInstalledRepoInstallationId, publicRepoRef, repoAccessMode, selectedRepo],
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
        setReaderAiSource(content);

        setContentImagePreview(null);
        setContentAlertMessage(null);
        setContentAlertDownloadHref(null);
        setContentAlertDownloadName(null);
        const wikiLinkResolver =
          wikiLinkContext && wikiLinkContext.knownMarkdownPaths.length > 0
            ? createWikiLinkResolver(wikiLinkContext.currentDocPath, wikiLinkContext.knownMarkdownPaths)
            : undefined;

        const rendered = parseMarkdownDocument(content, {
          resolveImageSrc: (src) => resolveMarkdownImageSrc(src, repoDocPath, repoSource),
          resolveWikiLinkMeta: wikiLinkResolver,
        });
        setRenderedHtml(rendered.html);
        setRenderedCustomCss(rendered.customCss);
        setRenderedCustomCssScope(rendered.customCssScope);
        setRenderedText(null);
        setRenderMode('markdown');
        setContentLoadPending(false);
        return;
      }
      setRenderedHtml('');
      setRenderedCustomCss(null);
      setRenderedCustomCssScope(null);
      setRenderedText(content);
      setRenderMode('ansi');
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
    setRenderedCustomCss(null);
    setRenderedCustomCssScope(null);
    setRenderedText(null);
    setRenderMode('image');
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
      setRenderedCustomCss(null);
      setRenderedCustomCssScope(null);
      setRenderedText(null);
      setRenderMode('ansi');
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
          const instId = activeInstalledRepoInstallationId ?? getInstallationId();
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
              recordServerLocalRateLimitFromResponse(res);
              recordGitHubRateLimitFromResponse(res);
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
    [activeInstalledRepoInstallationId, currentGistId, gistFiles, selectedRepo, user],
  );

  const fetchDocumentForStack = useCallback(
    async (rawRoute: string): Promise<StackEntry | null> => {
      const routePathname = rawRoute.replace(/^\/+/, '');
      if (!routePathname) return null;

      const routeCandidate = matchRoute(routePathname);
      let title = '';
      let content = '';
      let docPath: string | null = null;
      let repoSource: MarkdownRepoSourceContext | undefined;

      if (routeCandidate.name === 'repofile' || routeCandidate.name === 'repoedit') {
        const owner = safeDecodeURIComponent(routeCandidate.params.owner);
        const repo = safeDecodeURIComponent(routeCandidate.params.repo);
        const path = safeDecodeURIComponent(routeCandidate.params.path).replace(/^\/+/, '');
        if (!isMarkdownFileName(path)) return null;
        const repoFullName = buildRepoFullName(owner, repo);
        const selectedRepoFullName = getSelectedRepo()?.full_name ?? selectedRepo;
        const isInstalledRoute =
          routeCandidate.name === 'repoedit' ||
          (selectedRepoFullName !== null && selectedRepoFullName.toLowerCase() === repoFullName.toLowerCase());
        const instId = activeInstalledRepoInstallationId ?? getInstallationId();
        const loaded =
          isInstalledRoute && instId
            ? await getRepoContents(instId, repoFullName, path)
            : await getPublicRepoContents(owner, repo, path);
        if (!isRepoFile(loaded) || typeof loaded.content !== 'string' || loaded.encoding !== 'base64') return null;
        const bytes = decodeBase64ToBytes(loaded.content);
        if (isLikelyBinaryBytes(bytes)) return null;
        content = new TextDecoder().decode(bytes);
        title = loaded.name ?? fileNameFromPath(loaded.path);
        docPath = loaded.path;
        repoSource =
          isInstalledRoute && instId
            ? { mode: 'installed', installationId: instId, selectedRepo: repoFullName }
            : { mode: 'public', publicRepoRef: { owner, repo } };
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
            recordServerLocalRateLimitFromResponse(res);
            recordGitHubRateLimitFromResponse(res);
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

      const knownPaths = repoFiles.filter((f) => isMarkdownFileName(f.path)).map((f) => f.path);
      const wikiLinkResolver =
        docPath && knownPaths.length > 0 ? createWikiLinkResolver(docPath, knownPaths) : undefined;

      const rendered = parseMarkdownDocument(content, {
        resolveImageSrc: (src) => resolveMarkdownImageSrc(src, docPath, repoSource),
        resolveWikiLinkMeta: wikiLinkResolver,
      });

      return {
        route: routePathname,
        html: rendered.html,
        customCss: rendered.customCss,
        customCssScope: rendered.customCssScope,
        title,
        markdown: true,
      };
    },
    [
      activeInstalledRepoInstallationId,
      currentGistId,
      gistFiles,
      repoFiles,
      resolveMarkdownImageSrc,
      selectedRepo,
      user,
    ],
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
      setPendingImageUploads((prev) => {
        const next = new Set(prev);
        next.add(upload.id);
        return next;
      });
      const uploadToastId = showLoadingToast('Uploading image...');
      try {
        await putRepoFile(
          upload.installationId,
          upload.repoFullName,
          upload.imageRepoPath,
          `Add image ${upload.imageName}`,
          upload.contentB64,
        );
        setNextEditContent(
          (prev) => {
            let next = replaceFirst(prev, upload.uploadingToken, upload.finalMarkdown);
            next = replaceFirst(next, upload.failedToken, upload.finalMarkdown);
            return next;
          },
          { origin: 'appEdits' },
        );
        setFailedImageUpload((prev) => (prev?.id === upload.id ? null : prev));
        setHasUnsavedChanges(true);
        showSuccessToast(upload.resized ? 'Image resized and uploaded' : 'Image uploaded');
      } catch (err) {
        setNextEditContent((prev) => replaceFirst(prev, upload.uploadingToken, upload.failedToken), {
          origin: 'appEdits',
        });
        setFailedImageUpload(upload);
        if (isRateLimitError(err)) {
          showFailureToast(rateLimitToastMessage(err));
          return;
        }
        const message = err instanceof Error ? err.message : 'Upload failed';
        showFailureToast(`Image upload failed: ${message}`);
      } finally {
        dismissToast(uploadToastId);
        setPendingImageUploads((prev) => {
          const next = new Set(prev);
          next.delete(upload.id);
          return next;
        });
      }
    },
    [dismissToast, setNextEditContent, showFailureToast, showLoadingToast, showSuccessToast, setHasUnsavedChanges],
  );

  const onRetryFailedImageUpload = useCallback(() => {
    if (!failedImageUpload) return;
    let replaced = false;
    setNextEditContent(
      (prev) => {
        const next = replaceFirst(prev, failedImageUpload.failedToken, failedImageUpload.uploadingToken);
        replaced = next !== prev;
        return next;
      },
      { origin: 'appEdits' },
    );
    if (!replaced) {
      showFailureToast('Could not find failed upload placeholder in the editor.');
      return;
    }
    setFailedImageUpload(null);
    void runPendingImageUpload(failedImageUpload);
  }, [failedImageUpload, runPendingImageUpload, setNextEditContent, showFailureToast]);

  const onRemoveFailedImageUploadPlaceholder = useCallback(() => {
    if (!failedImageUpload) return;
    setNextEditContent((prev) => replaceFirst(prev, failedImageUpload.failedToken, ''), { origin: 'appEdits' });
    setFailedImageUpload(null);
    setHasUnsavedChanges(true);
  }, [failedImageUpload, setNextEditContent, setHasUnsavedChanges]);

  const replaceEditorSelectionContent = useCallback(
    (view: import('@codemirror/view').EditorView, insertedText: string) => {
      const { from, to } = view.state.selection.main;
      const currentContent = view.state.doc.toString();
      const nextContent = `${currentContent.slice(0, from)}${insertedText}${currentContent.slice(to)}`;
      const nextHead = from + insertedText.length;
      setNextEditContent(nextContent, { origin: 'appEdits', selection: { anchor: nextHead, head: nextHead } });
    },
    [setNextEditContent],
  );

  const handleEditorPaste = useCallback(
    async (event: ClipboardEvent, view: import('@codemirror/view').EditorView) => {
      const pastedText = event.clipboardData?.getData('text/plain') ?? '';
      const normalizedBlockquotePaste = normalizeBlockquotePaste(
        view.state,
        view.state.selection.main.from,
        pastedText,
      );
      if (normalizedBlockquotePaste !== null) {
        event.preventDefault();
        const { from, to } = view.state.selection.main;
        const head = from + normalizedBlockquotePaste.length;
        view.dispatch({
          changes: { from, to, insert: normalizedBlockquotePaste },
          selection: { anchor: head, head },
        });
        return;
      }

      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const imageItem = clipboardItems.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
      if (!imageItem) return;

      event.preventDefault();

      if (editingBackend !== 'repo' || !currentRepoDocPath || !selectedRepo || !activeInstalledRepoInstallationId) {
        showFailureToast('Save your document before uploading images');
        return;
      }

      const file = imageItem.getAsFile();
      if (!file) {
        showFailureToast('Failed to read pasted image.');
        return;
      }
      try {
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const baseExt = extensionFromMimeType(file.type);
        const imageName = `pasted-${stamp}-${Math.random().toString(36).slice(2, 8)}.${baseExt}`;
        const docDir = dirName(currentRepoDocPath);
        const assetDir = docDir ? `${docDir}/.assets` : '.assets';
        const imageRepoPath = `${assetDir}/${imageName}`;
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const uploadingToken = `[image-upload:${uploadId}:pending:${imageName}]`;
        const failedToken = `[image-upload:${uploadId}:failed:${imageName}]`;
        replaceEditorSelectionContent(view, uploadingToken);
        setHasUserTypedUnsavedChanges(true);
        setHasUnsavedChanges(true);

        void (async () => {
          try {
            const processed = await maybeResizePastedImage(file);
            const finalMarkdown = buildImageMarkdown(imageName, `./.assets/${imageName}`, processed.dimensions);
            const upload: PendingImageUpload = {
              id: uploadId,
              installationId: activeInstalledRepoInstallationId,
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
            await runPendingImageUpload(upload);
          } catch (err) {
            setNextEditContent((prev) => replaceFirst(prev, uploadingToken, failedToken), { origin: 'appEdits' });
            const message = err instanceof Error ? err.message : 'Upload failed';
            showFailureToast(`Image upload failed: ${message}`);
          }
        })();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to process pasted image.';
        showFailureToast(message);
      }
    },
    [
      currentRepoDocPath,
      editingBackend,
      activeInstalledRepoInstallationId,
      replaceEditorSelectionContent,
      runPendingImageUpload,
      selectedRepo,
      setNextEditContent,
      showFailureToast,
      setHasUnsavedChanges,
      setHasUserTypedUnsavedChanges,
    ],
  );

  // --- Auth ---
  // Returns whether auth is present and whether it navigated away from the current route.
  const tryRestoreAuth = useCallback(async (): Promise<{ authenticated: boolean; navigated: boolean }> => {
    try {
      const session = await getAuthSession();
      if (!session.authenticated || !session.user) {
        setUser(null);
        resetReaderAiModelsForAuth(false);
        clearInstallationId();
        clearSelectedRepo();
        setInstId(null);
        setLinkedInstallations([]);
        setSelectedRepo(null);
        setSelectedRepoPrivate(null);
        setSelectedRepoInstallationId(null);
        setInstallationReposById({});
        setReposLoadErrorsById({});
        setLoadingInstallationRepoIds(new Set());
        return { authenticated: false, navigated: false };
      }
      clearOAuthRedirectGuard();
      preferPaidReaderAiModelOnNextLoadRef.current = true;
      setUser(session.user);
      resetReaderAiModelsForAuth(true);
      const pendingInstallationId = getPendingInstallationId();
      if (pendingInstallationId) {
        try {
          const nextSessionState = await createInstallationSession(pendingInstallationId);
          applyInstallationSessionState(nextSessionState);
          clearPendingInstallationId();
          setWorkspaceNotice('GitHub App installation connected. Review your installation details below.');
        } catch (err) {
          if (!(err instanceof Error && err.message === 'Unauthorized')) {
            clearPendingInstallationId();
          }
        }
      }
      applyInstallationSessionState(session);
      return { authenticated: true, navigated: false };
    } catch {
      setUser(null);
      resetReaderAiModelsForAuth(false);
      return { authenticated: false, navigated: false };
    }
  }, [applyInstallationSessionState, clearOAuthRedirectGuard, resetReaderAiModelsForAuth]);

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
      if (!session.authenticated || !session.user) {
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
      setUser(session.user);
      resetReaderAiModelsForAuth(true);
      const nextSessionState = await createInstallationSession(id);
      applyInstallationSessionState(nextSessionState);
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
    setWorkspaceNotice('Installation updated!');

    navigate(routePath.workspaces(), { replace: true, state: null });
    return true;
  }, [
    applyInstallationSessionState,
    navigate,
    resetReaderAiModelsForAuth,
    showError,
    showRateLimitToastIfNeeded,
    startGitHubSignIn,
  ]);

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
    const result = await getRepoTree(instId, repoName, undefined, false);
    return repoDocFilesFromTree(result, true);
  }, []);

  const loadRepoAllFiles = useCallback(async (instId: string, repoName: string): Promise<RepoDocFile[]> => {
    const result = await getRepoTree(instId, repoName, undefined, false);
    return repoDocFilesFromTree(result, false);
  }, []);

  const loadPublicRepoMarkdownFiles = useCallback(async (owner: string, repo: string): Promise<RepoDocFile[]> => {
    const result = await getPublicRepoTree(owner, repo, undefined, false);
    return repoDocFilesFromTree(result, true);
  }, []);

  const loadPublicRepoAllFiles = useCallback(async (owner: string, repo: string): Promise<RepoDocFile[]> => {
    const result = await getPublicRepoTree(owner, repo, undefined, false);
    return repoDocFilesFromTree(result, false);
  }, []);

  const refreshRepoTreeAfterWrite = useCallback(async (): Promise<RepoDocFile[] | null> => {
    if (repoAccessMode !== 'installed' || !activeInstalledRepoInstallationId || !selectedRepo) return null;
    const files = await loadRepoAllFiles(activeInstalledRepoInstallationId, selectedRepo);
    setRepoSidebarFiles(files);
    setRepoFiles(files.filter((file) => isMarkdownFileName(file.path)));
    return files;
  }, [repoAccessMode, activeInstalledRepoInstallationId, selectedRepo, loadRepoAllFiles]);

  const onSelectRepo = useCallback(
    (fullName: string, id: number, isPrivate: boolean) => {
      const instId = installationId ?? getInstallationId();
      setSelectedRepo(fullName);
      setSelectedRepoPrivate(isPrivate);
      setSelectedRepoInstallationId(instId);
      storeSelectedRepo({ full_name: fullName, id, private: isPrivate, installationId: instId ?? undefined });
    },
    [installationId],
  );

  const ensureInstalledRepoSession = useCallback(
    async (targetInstallationId: string) => {
      if (targetInstallationId === installationId) return targetInstallationId;
      const nextSessionState = await selectGitHubInstallation(targetInstallationId);
      applyInstallationSessionState(nextSessionState);
      resetInstalledRepoSelectionState();
      return targetInstallationId;
    },
    [applyInstallationSessionState, installationId, resetInstalledRepoSelectionState],
  );

  const primeInstalledRepoState = useCallback(
    async (
      fullName: string,
      options?: {
        id?: number;
        isPrivate?: boolean;
        allFiles?: RepoDocFile[];
        installationId?: string;
      },
    ): Promise<{
      repoRef: { owner: string; repo: string };
      allFiles: RepoDocFile[];
      markdownFiles: RepoDocFile[];
    } | null> => {
      const instId = options?.installationId ?? installationId ?? getInstallationId();
      if (options && typeof options.id === 'number' && typeof options.isPrivate === 'boolean') {
        setSelectedRepo(fullName);
        setSelectedRepoPrivate(options.isPrivate);
        setSelectedRepoInstallationId(instId);
        storeSelectedRepo({
          full_name: fullName,
          id: options.id,
          private: options.isPrivate,
          installationId: instId ?? undefined,
        });
      } else {
        setSelectedRepo(fullName);
        setSelectedRepoInstallationId(instId);
        storeSelectedRepo({ full_name: fullName, installationId: instId ?? undefined });
      }

      const repoRef = parseRepoFullName(fullName);
      if (!repoRef || !instId) return null;

      const allFiles = options?.allFiles ?? (await loadRepoAllFiles(instId, fullName));
      const markdownFiles = allFiles.filter((file) => isMarkdownFileName(file.path));
      setRepoAccessMode('installed');
      setPublicRepoRef(null);
      setRepoFiles(markdownFiles);
      setRepoSidebarFiles(allFiles);
      return { repoRef, allFiles, markdownFiles };
    },
    [installationId, loadRepoAllFiles],
  );

  const openInstalledRepo = useCallback(
    async (
      fullName: string,
      options?: {
        id?: number;
        isPrivate?: boolean;
        replace?: boolean;
        allFiles?: RepoDocFile[];
        installationId?: string;
      },
    ) => {
      try {
        const prepared = await primeInstalledRepoState(fullName, options);
        if (!prepared) {
          navigate(routePath.workspaces(), options?.replace ? { replace: true } : undefined);
          return;
        }
        const target = pickPreferredRepoMarkdownFile(prepared.markdownFiles);
        if (target) {
          navigate(
            routePath.repoFile(prepared.repoRef.owner, prepared.repoRef.repo, target.path),
            options?.replace ? { replace: true } : undefined,
          );
          return;
        }

        navigate(
          routePath.repoNew(prepared.repoRef.owner, prepared.repoRef.repo, DEFAULT_NEW_FILENAME),
          options?.replace ? { replace: true } : undefined,
        );
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        showError(err instanceof Error ? err.message : 'Failed to load repository documents');
      }
    },
    [handleSessionExpired, navigate, primeInstalledRepoState, showError, showRateLimitToastIfNeeded],
  );

  // --- Data loaders ---
  const loadGist = useCallback(
    async (id: string, filename: string | undefined, anonymous: boolean) => {
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        if (anonymous) {
          let res: Response;
          try {
            res = await fetchWithTimeout(`https://api.github.com/gists/${encodeURIComponent(id)}`, {}, 4000);
          } catch (err) {
            if (!(err instanceof DOMException && err.name === 'AbortError')) throw err;
            console.warn('GitHub API request timed out, falling back to gist proxy');
            res = await fetch(`/api/gists/${encodeURIComponent(id)}`);
            recordServerLocalRateLimitFromResponse(res);
            recordGitHubRateLimitFromResponse(res);
          }
          if (!res.ok) {
            console.warn(`GitHub API failed (${res.status}), falling back to gist proxy`);
            res = await fetch(`/api/gists/${encodeURIComponent(id)}`);
            recordServerLocalRateLimitFromResponse(res);
            recordGitHubRateLimitFromResponse(res);
          }
          if (!res.ok) throw await responseToApiError(res);
          const data = await res.json();
          const files = data.files as Record<string, GistFile>;
          setGistFiles(files);
          setCurrentGistCreatedAt(typeof data.created_at === 'string' ? data.created_at : null);
          setCurrentGistUpdatedAt(typeof data.updated_at === 'string' ? data.updated_at : null);
          setCurrentGistId(id);
          setRepoAccessMode(null);
          setPublicRepoRef(null);
          setCurrentRepoDocPath(null);
          setCurrentRepoDocSha(null);
          setEditingBackend(null);
          setRepoFiles([]);
          setRepoSidebarFiles([]);
          setHasUnsavedChanges(false);

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
            setCurrentDocumentSavedContent(null);
            renderImageFileContent(file.filename, file.raw_url);
          } else {
            setCurrentDocumentSavedContent(content ?? '');
            renderDocumentContent(content ?? '', file.filename, null, undefined, {
              currentDocPath: file.filename,
              knownMarkdownPaths: fileKeys,
            });
          }
          setViewPhase(null);
          return;
        }

        const gist = await getGist(id);
        setGistFiles(gist.files);
        setCurrentGistCreatedAt(gist.created_at);
        setCurrentGistUpdatedAt(gist.updated_at);
        setCurrentGistId(gist.id);
        setRepoAccessMode(null);
        setPublicRepoRef(null);
        setCurrentRepoDocPath(null);
        setCurrentRepoDocSha(null);
        setEditingBackend(null);
        setRepoFiles([]);
        setRepoSidebarFiles([]);
        setHasUnsavedChanges(false);

        const fileKeys = Object.keys(gist.files);
        const targetName = filename ? safeDecodeURIComponent(filename) : fileKeys[0];
        const file = targetName ? gist.files[targetName] : null;
        if (!file) {
          showError('File not found in gist');
          return;
        }

        setCurrentFileName(file.filename);
        if (isSafeImageFileName(file.filename)) {
          setCurrentDocumentSavedContent(null);
          renderImageFileContent(file.filename, file.raw_url);
        } else {
          setCurrentDocumentSavedContent(file.content ?? '');
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
    [
      showError,
      renderDocumentContent,
      renderImageFileContent,
      activeView,
      currentFileName,
      showRateLimitToastIfNeeded,
      setCurrentDocumentSavedContent,
      setHasUnsavedChanges,
    ],
  );

  const presentLoadedFileContent = useCallback(
    (opts: {
      name: string;
      path: string;
      binary: boolean;
      decoded: string;
      forEdit: boolean;
      editSessionId?: number;
      suppressBinaryEditAlert?: boolean;
      binaryUrl: string;
      onBinaryEditRedirect: () => void;
      repoSource?: MarkdownRepoSourceContext;
      knownMarkdownPaths: string[];
    }): boolean => {
      if (opts.forEdit) {
        if (opts.editSessionId != null && !canApplyExternalEditSession(opts.editSessionId)) {
          return true;
        }
        if (opts.binary) {
          if (!opts.suppressBinaryEditAlert) {
            void showAlert(
              isSafeImageFileName(opts.name)
                ? 'Images cannot be edited in the editor.'
                : 'Binary files cannot be edited in the editor.',
            );
          }
          opts.onBinaryEditRedirect();
          return true;
        }
        setEditingBackend('repo');
        setEditTitle(opts.name.replace(/\.(?:md(?:own|wn)?|markdown)$/i, ''));
        setNextEditContent(opts.decoded, { origin: 'external' });
        setCurrentDocumentSavedContent(opts.decoded);
        setHasUnsavedChanges(false);
        return false;
      }
      if (opts.binary && isSafeImageFileName(opts.name)) {
        setEditingBackend(null);
        setHasUnsavedChanges(false);
        setCurrentDocumentSavedContent(null);
        renderImageFileContent(opts.name, opts.binaryUrl);
      } else if (opts.binary) {
        setEditingBackend(null);
        setHasUnsavedChanges(false);
        setCurrentDocumentSavedContent(null);
        renderBinaryFileContent(opts.name, opts.binaryUrl);
      } else {
        setEditingBackend(null);
        setHasUnsavedChanges(false);
        setCurrentDocumentSavedContent(opts.decoded);
        renderDocumentContent(opts.decoded, opts.name, opts.path, opts.repoSource, {
          currentDocPath: opts.path,
          knownMarkdownPaths: opts.knownMarkdownPaths,
        });
      }
      return false;
    },
    [
      canApplyExternalEditSession,
      showAlert,
      setNextEditContent,
      setCurrentDocumentSavedContent,
      setHasUnsavedChanges,
      renderDocumentContent,
      renderImageFileContent,
      renderBinaryFileContent,
    ],
  );

  const loadRepoFile = useCallback(
    async (
      owner: string,
      repo: string,
      path: string,
      forEdit: boolean,
      options?: { suppressError?: boolean; editSessionId?: number },
    ): Promise<boolean> => {
      const instId = activeInstalledRepoInstallationId ?? getInstallationId();
      const repoName = buildRepoFullName(owner, repo);
      if (!instId) {
        return false;
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
        if (forEdit && options?.editSessionId != null && !canApplyExternalEditSession(options.editSessionId)) {
          setViewPhase(null);
          return true;
        }
        const contentBytes = contents.content ? decodeBase64ToBytes(contents.content) : new Uint8Array();
        const binary = isLikelyBinaryBytes(contentBytes);
        const decoded = binary ? '' : new TextDecoder().decode(contentBytes);
        const storedSelectedRepo = getSelectedRepo();
        const currentSelectedRepo = storedSelectedRepo?.full_name ?? null;
        const currentSelectedRepoInstallationId = storedSelectedRepo?.installationId ?? null;
        if (
          !currentSelectedRepo ||
          currentSelectedRepo.toLowerCase() !== repoName.toLowerCase() ||
          currentSelectedRepoInstallationId !== instId
        ) {
          setSelectedRepo(repoName);
          setSelectedRepoInstallationId(instId);
          storeSelectedRepo({ full_name: repoName, installationId: instId });
        }
        setRepoAccessMode('installed');
        setPublicRepoRef(null);
        setCurrentRepoDocPath(contents.path);
        setCurrentRepoDocSha(contents.sha);
        setSharedRepoInstallationId(null);
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
        const wikiPaths = knownMarkdownPaths.includes(contents.path)
          ? knownMarkdownPaths
          : [...knownMarkdownPaths, contents.path];
        const redirected = presentLoadedFileContent({
          name: contents.name,
          path: contents.path,
          binary,
          decoded,
          forEdit,
          editSessionId: options?.editSessionId,
          suppressBinaryEditAlert: options?.suppressError,
          binaryUrl: repoRawFileUrl(instId, repoName, contents.path),
          onBinaryEditRedirect: () => {
            if (owner && repo && contents.path) {
              navigate(routePath.repoFile(owner, repo, contents.path));
            } else {
              navigate(routePath.workspaces());
            }
          },
          repoSource: { mode: 'installed', installationId: instId, selectedRepo: repoName },
          knownMarkdownPaths: wikiPaths,
        });
        if (redirected) {
          setViewPhase(null);
          return true;
        }
        setViewPhase(null);
        return true;
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return false;
        }
        showRateLimitToastIfNeeded(err);
        if (!options?.suppressError) {
          showError(err instanceof Error ? err.message : 'Failed to load file');
        }
        return false;
      }
    },
    [
      navigate,
      handleSessionExpired,
      showError,
      repoFiles,
      loadRepoMarkdownFiles,
      presentLoadedFileContent,
      activeInstalledRepoInstallationId,
      activeView,
      currentFileName,
      showRateLimitToastIfNeeded,
      canApplyExternalEditSession,
    ],
  );

  const loadPublicRepoFile = useCallback(
    async (owner: string, repo: string, path: string, options?: { suppressError?: boolean }): Promise<boolean> => {
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
          setCurrentDocumentSavedContent(null);
          renderImageFileContent(contents.name, publicRepoRawFileUrl(owner, repo, contents.path));
        } else if (binary) {
          setCurrentDocumentSavedContent(null);
          renderBinaryFileContent(contents.name, publicRepoRawFileUrl(owner, repo, contents.path));
        } else {
          setCurrentDocumentSavedContent(decoded);
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
        return true;
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        if (!options?.suppressError) {
          showError(err instanceof Error ? err.message : 'Failed to load file');
        }
        return false;
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
      setCurrentDocumentSavedContent,
    ],
  );

  const loadEditorSharedRepoFile = useCallback(
    async (
      owner: string,
      repo: string,
      path: string,
      forEdit: boolean,
      options?: { suppressError?: boolean; editSessionId?: number },
    ) => {
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        const shared = await getEditorSharedRepoFile(owner, repo, path);
        if (forEdit && options?.editSessionId != null && !canApplyExternalEditSession(options.editSessionId)) {
          setViewPhase(null);
          return true;
        }
        const contentBytes = decodeBase64ToBytes(shared.content);
        const binary = isLikelyBinaryBytes(contentBytes);
        const decoded = binary ? '' : new TextDecoder().decode(contentBytes);
        const sharedFile = {
          name: shared.name,
          path: shared.path,
          sha: shared.sha,
        };
        setRepoAccessMode('shared');
        setSelectedRepo(null);
        setSelectedRepoPrivate(null);
        setSelectedRepoInstallationId(null);
        setPublicRepoRef(null);
        setSharedRepoInstallationId(shared.installationId);
        setRepoFiles([sharedFile]);
        setRepoSidebarFiles([sharedFile]);
        setCurrentRepoDocPath(shared.path);
        setCurrentRepoDocSha(shared.sha);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(shared.path);
        const blobUrl = binary
          ? URL.createObjectURL(new Blob([new Uint8Array(contentBytes)], { type: 'application/octet-stream' }))
          : '';
        const redirected = presentLoadedFileContent({
          name: shared.name,
          path: shared.path,
          binary,
          decoded,
          forEdit,
          editSessionId: options?.editSessionId,
          suppressBinaryEditAlert: options?.suppressError,
          binaryUrl: blobUrl,
          onBinaryEditRedirect: () => {
            if (owner && repo && shared.path) {
              navigate(routePath.repoFile(owner, repo, shared.path));
            }
          },
          knownMarkdownPaths: [shared.path],
        });
        if (redirected) {
          setViewPhase(null);
          return true;
        }
        setViewPhase(null);
        return true;
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return false;
        }
        showRateLimitToastIfNeeded(err);
        if (!options?.suppressError) {
          showError(err instanceof Error ? err.message : 'Failed to load shared editor file');
        }
        return false;
      }
    },
    [
      activeView,
      currentFileName,
      handleSessionExpired,
      navigate,
      presentLoadedFileContent,
      showError,
      showRateLimitToastIfNeeded,
      canApplyExternalEditSession,
    ],
  );

  const loadSharedRepoFile = useCallback(
    async (params: { token: string } | { owner: string; repo: string; path: string; token: string }) => {
      const shouldShowLoading = !(activeView === 'content' || activeView === 'edit') || currentFileName === null;
      if (shouldShowLoading) {
        setViewPhase('loading');
      }
      try {
        const shared =
          'owner' in params
            ? await getSharedRepoFileByRef(params.owner, params.repo, params.path, params.token)
            : await getSharedRepoFile(params.token);
        const contentBytes = decodeBase64ToBytes(shared.content);
        const binary = isLikelyBinaryBytes(contentBytes);
        const decoded = binary ? '' : new TextDecoder().decode(contentBytes);
        const sharedFile = {
          name: shared.name,
          path: shared.path,
          sha: shared.sha,
        };
        setRepoAccessMode(null);
        setSelectedRepo(null);
        setSelectedRepoPrivate(null);
        setSelectedRepoInstallationId(null);
        setPublicRepoRef(null);
        setSharedRepoInstallationId(null);
        setRepoFiles([sharedFile]);
        setRepoSidebarFiles([sharedFile]);
        setCurrentRepoDocPath(shared.path);
        setCurrentRepoDocSha(shared.sha);
        setCurrentGistId(null);
        setGistFiles(null);
        setCurrentFileName(shared.path);
        setEditingBackend(null);
        if (binary && isSafeImageFileName(shared.name)) {
          setCurrentDocumentSavedContent(null);
          const imageBlobBytes = new Uint8Array(contentBytes);
          const imageBlob = new Blob([imageBlobBytes], { type: 'application/octet-stream' });
          const imageBlobUrl = URL.createObjectURL(imageBlob);
          renderImageFileContent(shared.name, imageBlobUrl);
        } else if (binary) {
          setCurrentDocumentSavedContent(null);
          const blobBytes = new Uint8Array(contentBytes);
          const blob = new Blob([blobBytes], { type: 'application/octet-stream' });
          const blobUrl = URL.createObjectURL(blob);
          renderBinaryFileContent(shared.name, blobUrl);
        } else {
          setCurrentDocumentSavedContent(decoded);
          renderDocumentContent(decoded, shared.name, shared.path, undefined, {
            currentDocPath: shared.path,
            knownMarkdownPaths: [shared.path],
          });
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
      setCurrentDocumentSavedContent,
    ],
  );

  // --- Route handler ---
  const handleRoute = useCallback(
    async (r: Route, authenticatedOverride?: boolean) => {
      const isAuthenticated = authenticatedOverride ?? Boolean(user);

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
          setCurrentDocumentSavedContent(null);
          setViewPhase(null);
          return;
        case 'repodocuments': {
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const repoFullName = buildRepoFullName(owner, repo);
          const selectedRepoFullName = getSelectedRepo()?.full_name ?? selectedRepo;
          const instId = activeInstalledRepoInstallationId ?? getInstallationId();
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
          if (routeKeyFromRoute(r) === postSaveVerificationRef.current?.routeKey) {
            setViewPhase(null);
            setContentLoadPending(false);
            return;
          }
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const decodedPath = safeDecodeURIComponent(r.params.path).replace(/^\/+/, '');
          const instId = activeInstalledRepoInstallationId ?? getInstallationId();
          const repoFullName = buildRepoFullName(owner, repo).toLowerCase();
          const hasLoadedInstallationRepos =
            Boolean(instId) && loadedReposInstallationId !== null && loadedReposInstallationId === instId;
          const routeRepoIsInstalled = hasLoadedInstallationRepos
            ? installationRepos.some((candidate) => candidate.full_name.toLowerCase() === repoFullName)
            : (selectedRepo ?? '').toLowerCase() === repoFullName;
          const shouldTryInstalled =
            Boolean(isAuthenticated && instId) && (!hasLoadedInstallationRepos || routeRepoIsInstalled);
          if (shouldTryInstalled) {
            const loadedInstalled = await loadRepoFile(owner, repo, decodedPath, false, { suppressError: true });
            if (loadedInstalled) return;
          }
          const loadedPublic = await loadPublicRepoFile(owner, repo, decodedPath, { suppressError: true });
          if (loadedPublic) return;
          if (isAuthenticated) {
            const loadedShared = await loadEditorSharedRepoFile(owner, repo, decodedPath, false, {
              suppressError: true,
            });
            if (loadedShared) return;
          }
          await loadPublicRepoFile(owner, repo, decodedPath);
          return;
        }
        case 'sharefile': {
          const token = new URLSearchParams(window.location.search).get('t');
          if (!token) {
            showError('Invalid or expired share token');
            return;
          }
          await loadSharedRepoFile({
            owner: safeDecodeURIComponent(r.params.owner),
            repo: safeDecodeURIComponent(r.params.repo),
            path: safeDecodeURIComponent(r.params.path).replace(/^\/+/, ''),
            token,
          });
          return;
        }
        case 'sharetoken':
          await loadSharedRepoFile({ token: safeDecodeURIComponent(r.params.token) });
          return;
        case 'reponew': {
          beginExternalEditSession();
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const path = safeDecodeURIComponent(r.params.path).replace(/^\/+/, '');
          const repoName = buildRepoFullName(owner, repo);
          const switchingRepos = (selectedRepo ?? '').toLowerCase() !== repoName.toLowerCase();
          const instId = activeInstalledRepoInstallationId ?? getInstallationId();
          if (!instId || !isAuthenticated) {
            navigate(routePath.workspaces());
            return;
          }
          if ((selectedRepo ?? '').toLowerCase() !== repoName.toLowerCase()) {
            setSelectedRepo(repoName);
            setSelectedRepoInstallationId(instId);
            storeSelectedRepo({ full_name: repoName, installationId: instId });
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
          if (switchingRepos) {
            setRepoFiles([]);
            setRepoSidebarFiles([]);
          }
          setCurrentDocumentSavedContent(null);
          setHasUnsavedChanges(false);
          setEditTitle(UNSAVED_FILE_LABEL);
          setNextEditContent('', { origin: 'external' });
          setPreviewVisible(defaultPreviewVisible());
          const pendingForkRepoDraft = parsePendingForkRepoDraftState(routeState);
          const titleDraftKey = repoNewDraftKey(instId, repoName, path, 'title');
          const contentDraftKey = repoNewDraftKey(instId, repoName, path, 'content');
          const shouldHydrateTitle = pendingForkRepoDraft === null && shouldHydrateLocalDraftForRoute(titleDraftKey);
          const shouldHydrateContent =
            pendingForkRepoDraft === null && shouldHydrateLocalDraftForRoute(contentDraftKey);
          if (pendingForkRepoDraft) {
            setEditTitle(pendingForkRepoDraft.title || UNSAVED_FILE_LABEL);
            setNextEditContent(pendingForkRepoDraft.content, { origin: 'external' });
            setHasUnsavedChanges(Boolean(pendingForkRepoDraft.content));
          } else if (shouldHydrateTitle) {
            setEditTitle(localStorage.getItem(titleDraftKey) || UNSAVED_FILE_LABEL);
          }
          if (shouldHydrateContent) {
            const persistedRepoNewContent = localStorage.getItem(contentDraftKey) ?? '';
            setNextEditContent(persistedRepoNewContent, { origin: 'external' });
            setHasUnsavedChanges(Boolean(persistedRepoNewContent));
          }
          setViewPhase(null);
          return;
        }
        case 'repoedit': {
          const editSessionId = beginExternalEditSession();
          if (routeKeyFromRoute(r) === postSaveVerificationRef.current?.routeKey) {
            setViewPhase(null);
            return;
          }
          const owner = safeDecodeURIComponent(r.params.owner);
          const repo = safeDecodeURIComponent(r.params.repo);
          const path = safeDecodeURIComponent(r.params.path).replace(/^\/+/, '');
          setDraftMode(false);
          const loadedInstalled = await loadRepoFile(owner, repo, path, true, {
            suppressError: true,
            editSessionId,
          });
          if (loadedInstalled) return;
          if (!isAuthenticated) {
            showError('Sign in with GitHub to edit this document.');
            return;
          }
          await loadEditorSharedRepoFile(owner, repo, path, true, { editSessionId });
          return;
        }
        case 'new': {
          beginExternalEditSession();
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
          setCurrentDocumentSavedContent(null);
          setPreviewVisible(defaultPreviewVisible());
          const shouldHydrateDraftTitle = shouldHydrateLocalDraftForRoute(DRAFT_TITLE_KEY);
          const shouldHydrateDraftContent = shouldHydrateLocalDraftForRoute(DRAFT_CONTENT_KEY);
          if (shouldHydrateDraftTitle) {
            setEditTitle(localStorage.getItem(DRAFT_TITLE_KEY) || UNSAVED_FILE_LABEL);
          }
          if (shouldHydrateDraftContent) {
            setNextEditContent(localStorage.getItem(DRAFT_CONTENT_KEY) ?? '', { origin: 'external' });
          }
          setViewPhase(null);
          if (activeView === 'edit') focusEditorSoon();
          return;
        }
        case 'edit': {
          const editSessionId = beginExternalEditSession();
          if (routeKeyFromRoute(r) === postSaveVerificationRef.current?.routeKey) {
            setViewPhase(null);
            return;
          }
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
          const newGistFileDraft = !r.params.filename ? resolveNewGistFileDraft(r.params.id, routeState) : null;
          if (newGistFileDraft) {
            setViewPhase('loading');
            try {
              const gist = currentGistId === r.params.id && gistFiles ? null : await getGist(r.params.id);
              if (!canApplyExternalEditSession(editSessionId)) {
                setViewPhase(null);
                return;
              }
              if (gist) {
                setGistFiles(gist.files);
                setCurrentGistCreatedAt(gist.created_at);
                setCurrentGistUpdatedAt(gist.updated_at);
              }
              setEditingBackend('gist');
              setCurrentGistId(r.params.id);
              setCurrentFileName(null);
              setCurrentRepoDocPath(null);
              setCurrentRepoDocSha(null);
              setRepoFiles([]);
              setRepoSidebarFiles([]);
              setEditTitle(newGistFileDraft.title);
              setNextEditContent(newGistFileDraft.content, { origin: 'external' });
              setCurrentDocumentSavedContent('');
              setHasUnsavedChanges(Boolean(newGistFileDraft.content));
              setViewPhase(null);
              if (activeView === 'edit') focusEditorSoon();
            } catch (err) {
              showRateLimitToastIfNeeded(err);
              showError(err instanceof Error ? err.message : 'Failed to load gist');
            }
            return;
          }
          // Serve from cache if we already have this gist's files
          const cachedFiles = currentGistId === r.params.id ? gistFiles : null;
          if (cachedFiles) {
            const cacheKeys = Object.keys(cachedFiles);
            const cacheName = r.params.filename ? safeDecodeURIComponent(r.params.filename) : cacheKeys[0];
            const cacheFile = cacheName ? cachedFiles[cacheName] : null;
            if (cacheFile) {
              if (isSafeImageFileName(cacheFile.filename)) {
                void showAlert('Images cannot be edited in the editor.');
                navigate(routePath.gistView(r.params.id, cacheFile.filename));
                return;
              }

              const needsFullContent = cacheFile.truncated || cacheFile.content == null;
              if (needsFullContent) {
                setViewPhase('loading');
                let full: Awaited<ReturnType<typeof fetchFullGistFileText>>;
                try {
                  full = await fetchFullGistFileText(cacheFile);
                } catch (err) {
                  showRateLimitToastIfNeeded(err);
                  void showAlert(err instanceof Error ? err.message : 'Failed to load full file content');
                  setViewPhase(null);
                  navigate(routePath.gistView(r.params.id, cacheFile.filename));
                  return;
                }

                if (!full.ok) {
                  if ('binary' in full) {
                    void showAlert('Binary files cannot be edited in the editor.');
                  } else {
                    void showAlert(`Failed to load full file content. ${full.error}`);
                  }
                  setViewPhase(null);
                  navigate(routePath.gistView(r.params.id, cacheFile.filename));
                  return;
                }
                if (!canApplyExternalEditSession(editSessionId)) {
                  setViewPhase(null);
                  return;
                }

                setGistFiles((prev) => {
                  if (!prev) return prev;
                  const current = prev[cacheFile.filename];
                  if (!current) return prev;
                  return {
                    ...prev,
                    [cacheFile.filename]: { ...current, content: full.content, truncated: false },
                  };
                });
                setEditingBackend('gist');
                setCurrentGistId(r.params.id);
                setCurrentFileName(cacheFile.filename);
                setCurrentRepoDocPath(null);
                setCurrentRepoDocSha(null);
                setRepoFiles([]);
                setRepoSidebarFiles([]);
                setEditTitle(fileNameFromPath(cacheFile.filename).replace(/\.(?:md(?:own|wn)?|markdown)$/i, ''));
                setNextEditContent(full.content, { origin: 'external' });
                setCurrentDocumentSavedContent(full.content);
                setHasUnsavedChanges(false);
                setViewPhase(null);
                return;
              }
              setEditingBackend('gist');
              setCurrentGistId(r.params.id);
              setCurrentFileName(cacheFile.filename);
              setCurrentRepoDocPath(null);
              setCurrentRepoDocSha(null);
              setRepoFiles([]);
              setRepoSidebarFiles([]);
              setEditTitle(fileNameFromPath(cacheFile.filename).replace(/\.(?:md(?:own|wn)?|markdown)$/i, ''));
              setNextEditContent(cacheFile.content ?? '', { origin: 'external' });
              setCurrentDocumentSavedContent(cacheFile.content ?? '');
              setHasUnsavedChanges(false);
              setViewPhase(null);
              return;
            }
          }
          setViewPhase('loading');
          try {
            const gist = await getGist(r.params.id);
            if (!canApplyExternalEditSession(editSessionId)) {
              setViewPhase(null);
              return;
            }
            setGistFiles(gist.files);
            setCurrentGistCreatedAt(gist.created_at);
            setCurrentGistUpdatedAt(gist.updated_at);

            const fileKeys = Object.keys(gist.files);
            const targetName = r.params.filename ? safeDecodeURIComponent(r.params.filename) : fileKeys[0];
            const file = targetName ? gist.files[targetName] : null;
            if (!file) {
              showError('File not found in gist');
              return;
            }

            if (isSafeImageFileName(file.filename)) {
              void showAlert('Images cannot be edited in the editor.');
              navigate(routePath.gistView(gist.id, file.filename));
              return;
            }

            let editableContent = file.content ?? '';
            if (file.truncated || file.content == null) {
              const full = await fetchFullGistFileText(file);
              if (!full.ok) {
                if ('binary' in full) {
                  void showAlert('Binary files cannot be edited in the editor.');
                  navigate(routePath.gistView(gist.id, file.filename));
                  return;
                }
                void showAlert(`Failed to load full file content. ${full.error}`);
                navigate(routePath.gistView(gist.id, file.filename));
                return;
              }
              if (!canApplyExternalEditSession(editSessionId)) {
                setViewPhase(null);
                return;
              }
              editableContent = full.content;
              setGistFiles((prev) => {
                const base = prev ?? gist.files;
                const current = base[file.filename];
                if (!current) return base;
                return { ...base, [file.filename]: { ...current, content: full.content, truncated: false } };
              });
            }

            setEditingBackend('gist');
            setCurrentGistId(gist.id);
            setCurrentFileName(file.filename);
            setCurrentRepoDocPath(null);
            setCurrentRepoDocSha(null);
            setRepoFiles([]);
            setRepoSidebarFiles([]);
            setEditTitle(fileNameFromPath(file.filename).replace(/\.(?:md(?:own|wn)?|markdown)$/i, ''));
            setNextEditContent(editableContent, { origin: 'external' });
            setCurrentDocumentSavedContent(editableContent);
            setHasUnsavedChanges(false);
            setViewPhase(null);
          } catch (err) {
            showRateLimitToastIfNeeded(err);
            showError(err instanceof Error ? err.message : 'Failed to load gist');
          }
          return;
        }
        case 'gist': {
          if (routeKeyFromRoute(r) === postSaveVerificationRef.current?.routeKey) {
            setViewPhase(null);
            setContentLoadPending(false);
            return;
          }
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
          setCurrentDocumentSavedContent(null);
          setViewPhase(null);
      }
    },
    [
      navigate,
      loadRepoFile,
      loadEditorSharedRepoFile,
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
      showAlert,
      defaultPreviewVisible,
      selectedRepo,
      installationRepos,
      loadedReposInstallationId,
      setNextEditContent,
      routeState,
      postSaveVerificationRef.current?.routeKey,
      setCurrentDocumentSavedContent,
      setHasUnsavedChanges,
      activeInstalledRepoInstallationId,
      beginExternalEditSession,
      canApplyExternalEditSession,
      shouldHydrateLocalDraftForRoute,
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
    const shouldPreserveHeaderLeftControls =
      Boolean(user) &&
      routeShowsHeaderLeftControls(prevRoute.current, true) &&
      routeShowsHeaderLeftControls(route, true);
    setPreserveHeaderLeftControlsWhileLoading(shouldPreserveHeaderLeftControls);
    if (isContentRoute(route) && !shouldPreserveVerifiedContent) {
      clearRenderedContent();
      setContentLoadPending(true);
    } else {
      setContentLoadPending(false);
    }
    prevRoute.current = route;
    documentStack.clearStack();
    handleRoute(route);
  }, [clearRenderedContent, documentStack, handleRoute, isContentRoute, route, shouldPreserveVerifiedContent, user]);

  useEffect(() => {
    if (viewPhase === 'loading') return;
    setPreserveHeaderLeftControlsWhileLoading(false);
  }, [viewPhase]);

  // --- Draft persistence ---
  useEffect(() => {
    if (!draftMode) return;
    const timerId = window.setTimeout(() => {
      persistPendingGistDraft();
    }, DRAFT_PERSIST_DELAY_MS);
    return () => window.clearTimeout(timerId);
  }, [draftMode, persistPendingGistDraft]);

  useEffect(() => {
    if (activeView !== 'edit' || editingBackend !== 'gist' || !currentGistId || currentFileName !== null) return;
    const timerId = window.setTimeout(() => {
      persistNewGistFileDraft();
    }, DRAFT_PERSIST_DELAY_MS);
    return () => window.clearTimeout(timerId);
  }, [activeView, editingBackend, currentGistId, currentFileName, persistNewGistFileDraft]);

  useEffect(() => {
    if (route.name !== 'reponew') return;
    if (editingBackend !== 'repo' || currentRepoDocPath) return;
    const timerId = window.setTimeout(() => {
      persistRepoNewDraft();
    }, DRAFT_PERSIST_DELAY_MS);
    return () => window.clearTimeout(timerId);
  }, [route, editingBackend, currentRepoDocPath, persistRepoNewDraft]);

  useEffect(() => {
    const flushDraftPersistence = () => {
      persistPendingGistDraft();
      persistNewGistFileDraft();
      persistRepoNewDraft();
    };
    window.addEventListener('pagehide', flushDraftPersistence);
    window.addEventListener('beforeunload', flushDraftPersistence);
    return () => {
      window.removeEventListener('pagehide', flushDraftPersistence);
      window.removeEventListener('beforeunload', flushDraftPersistence);
    };
  }, [persistNewGistFileDraft, persistPendingGistDraft, persistRepoNewDraft]);

  useEffect(() => {
    void installationId;
    void user?.login;
    setInstallationReposById({});
    setLoadingInstallationRepoIds(new Set());
    setAutoLoadAttemptedReposInstallationId(null);
    setReposLoadErrorsById({});
    setGistsLoadError(null);
    setMenuGistsLoaded(false);
    setMenuGistsPage(1);
    setMenuGistsAllLoaded(false);
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

  useEffect(() => {
    setLocalRateLimit(readStoredGitHubRateLimitSnapshot('serverLocal'));
    setServerRateLimit(readStoredGitHubRateLimitSnapshot('server'));
    return subscribeGitHubRateLimitUpdates((source, snapshot) => {
      if (source === 'serverLocal') {
        setLocalRateLimit(snapshot);
        return;
      }
      setServerRateLimit(snapshot);
    });
  }, []);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(EDITOR_PREVIEW_VISIBLE_KEY, previewVisible ? 'true' : 'false');
    } catch {}
  }, [previewVisible]);

  useEffect(() => {
    if (currentGistId !== null) return;
    setCurrentGistCreatedAt(null);
    setCurrentGistUpdatedAt(null);
  }, [currentGistId]);

  useLayoutEffect(() => {
    const wasRouteName = prevRouteNameRef.current;
    const onNewRoute = route.name === 'new';
    const leftNewRoute = wasRouteName === 'new' && !onNewRoute;
    prevRouteNameRef.current = route.name;

    if (onNewRoute) {
      setReaderAiVisible(false);
      return;
    }

    if (!leftNewRoute) return;

    readerAiSkipPersistVisibleRef.current = true;
    try {
      setReaderAiVisible(localStorage.getItem(READER_AI_VISIBLE_KEY) === 'true');
    } catch {
      setReaderAiVisible(false);
    }
  }, [route.name]);

  useLayoutEffect(() => {
    if (route.name === 'new') return;
    if (readerAiSkipPersistVisibleRef.current) {
      readerAiSkipPersistVisibleRef.current = false;
      return;
    }
    try {
      localStorage.setItem(READER_AI_VISIBLE_KEY, readerAiVisible ? 'true' : 'false');
    } catch {}
  }, [readerAiVisible, route.name]);

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
      if (sidebarVisibilityOverride === null) {
        localStorage.removeItem(SIDEBAR_VISIBLE_KEY);
      } else {
        localStorage.setItem(SIDEBAR_VISIBLE_KEY, sidebarVisibilityOverride ? 'true' : 'false');
      }
    } catch {}
  }, [sidebarVisibilityOverride]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_FILE_FILTER_KEY, sidebarFileFilter);
    } catch {}
  }, [sidebarFileFilter]);

  useEffect(() => {
    if (sidebarFileFilter === 'all' || sidebarFileFilter === 'text' || sidebarFileFilter === 'markdown') {
      let active = true;
      void (async () => {
        try {
          if (repoAccessMode === 'installed' && activeInstalledRepoInstallationId && selectedRepo) {
            const files = await loadRepoAllFiles(activeInstalledRepoInstallationId, selectedRepo);
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
    activeInstalledRepoInstallationId,
    selectedRepo,
    publicRepoRef,
    loadRepoAllFiles,
    loadPublicRepoAllFiles,
    showRateLimitToastIfNeeded,
  ]);

  const onTogglePreview = useCallback(() => {
    setPreviewVisible((visible) => {
      const nextVisible = !visible;
      if (nextVisible) {
        setReaderAiVisible(false);
      }
      return nextVisible;
    });
  }, []);

  const onToggleReaderAi = useCallback(() => {
    setReaderAiVisible((visible) => {
      const nextVisible = !visible;
      if (nextVisible) {
        setPreviewVisible(false);
      }
      return nextVisible;
    });
  }, []);

  const onOpenReaderAi = useCallback(() => {
    setReaderAiVisible((visible) => {
      if (visible) return true;
      setPreviewVisible(false);
      return true;
    });
  }, []);

  const focusReaderAiComposerInput = useCallback(() => {
    const focusWithRetry = (attempt: number) => {
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>('.reader-ai-panel .reader-ai-input');
        if (input && !input.disabled) {
          input.focus();
          return;
        }
        if (attempt >= 8) return;
        window.setTimeout(() => focusWithRetry(attempt + 1), 25);
      });
    };
    focusWithRetry(0);
  }, []);

  const loadReaderAiModels = useCallback(async () => {
    setReaderAiModelsLoading(true);
    setReaderAiModelsError(null);
    try {
      const models = prioritizeReaderAiModels(await listReaderAiModels());
      const preferredPaidModelId = preferPaidReaderAiModelOnNextLoadRef.current ? firstPaidReaderAiModelId(models) : '';
      preferPaidReaderAiModelOnNextLoadRef.current = false;
      setReaderAiConfigured(true);
      setReaderAiModels(models);
      setReaderAiSelectedModel((current) => {
        if (preferredPaidModelId) return preferredPaidModelId;
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

  const enableLocalCodexModels = useCallback(() => {
    setLocalCodexEnabledByPreference(true);
    setLocalCodexEnabled(true);
    void loadReaderAiModels();
  }, [loadReaderAiModels]);

  useEffect(() => {
    const prevHistoryKey = readerAiPrevHistoryKeyRef.current;
    if (readerAiHistoryEligible && readerAiHistoryDocumentKey) {
      if (prevHistoryKey !== readerAiHistoryDocumentKey) {
        readerAiSkipPersistHistoryKeyRef.current = readerAiHistoryDocumentKey;
        readerAiAbortRef.current?.abort();
        readerAiAbortRef.current = null;
        setReaderAiSending(false);
        setReaderAiToolStatus(null);
        const loaded = loadReaderAiEntryFromHistory(readerAiHistoryDocumentKey);
        setReaderAiMessages(loaded.messages);
        setReaderAiSummary(loaded.summary ?? '');
        setReaderAiConversationScope(loaded.scope ?? null);
        setReaderAiHasEligibleSelection(false);
        setReaderAiToolLog(loaded.toolLog ?? []);
        setReaderAiStagedChanges(loaded.stagedChanges ?? []);
        setReaderAiSelectedChangeIds(
          new Set(
            (loaded.stagedChanges ?? [])
              .map((change) => change.id)
              .filter((id): id is string => typeof id === 'string'),
          ),
        );
        setReaderAiSelectedHunkIdsByChangeId(
          Object.fromEntries(
            (loaded.stagedChanges ?? [])
              .filter((change) => change.id && Array.isArray(change.hunks))
              .map((change) => [
                change.id as string,
                new Set(
                  (change.hunks ?? []).map((hunk) => hunk.id).filter((id): id is string => typeof id === 'string'),
                ),
              ]),
          ),
        );
        setReaderAiStagedChangesInvalid(loaded.stagedChangesInvalid === true);
        setReaderAiStagedFileContents(loaded.stagedFileContents ?? {});
        setReaderAiAppliedChanges(loaded.appliedChanges ?? []);
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
    setReaderAiToolLog([]);
    setReaderAiStagedChanges([]);
    setReaderAiSelectedChangeIds(new Set());
    setReaderAiSelectedHunkIdsByChangeId({});
    setReaderAiAppliedChanges([]);
    setReaderAiStagedChangesInvalid(false);
    setReaderAiStagedFileContents({});
    setReaderAiMessages([]);
    setReaderAiSummary('');
    setReaderAiConversationScope(null);
    setReaderAiHasEligibleSelection(false);
    setReaderAiError(null);
  }, [readerAiHistoryEligible, readerAiHistoryDocumentKey]);

  useEffect(() => {
    if (!readerAiHistoryEligible || !readerAiHistoryDocumentKey) return;
    if (readerAiSkipPersistHistoryKeyRef.current === readerAiHistoryDocumentKey) {
      readerAiSkipPersistHistoryKeyRef.current = null;
      return;
    }
    persistReaderAiMessagesToHistory(
      readerAiHistoryDocumentKey,
      readerAiMessages,
      readerAiSummary || undefined,
      readerAiConversationScope ?? undefined,
      readerAiToolLog.length > 0 ? readerAiToolLog : undefined,
      readerAiStagedChanges.length > 0 ? readerAiStagedChanges : undefined,
      Object.keys(readerAiStagedFileContents).length > 0 ? readerAiStagedFileContents : undefined,
      readerAiAppliedChanges.length > 0 ? readerAiAppliedChanges : undefined,
    );
  }, [
    readerAiHistoryEligible,
    readerAiMessages,
    readerAiSummary,
    readerAiConversationScope,
    readerAiHistoryDocumentKey,
    readerAiToolLog,
    readerAiStagedChanges,
    readerAiStagedFileContents,
    readerAiAppliedChanges,
  ]);

  useEffect(() => {
    return () => {
      readerAiAbortRef.current?.abort();
      readerAiAbortRef.current = null;
    };
  }, []);

  const showReaderAiToggleCandidate = readerAiHistoryEligible;

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

  const previousReaderAiAuthenticatedRef = useRef<boolean | null>(null);

  useEffect(() => {
    const previous = previousReaderAiAuthenticatedRef.current;
    previousReaderAiAuthenticatedRef.current = readerAiAuthenticated;
    if (previous === null || previous === readerAiAuthenticated) return;
    if (readerAiAuthenticated) preferPaidReaderAiModelOnNextLoadRef.current = true;
    resetReaderAiModelsForAuth(readerAiAuthenticated);
    if (!showReaderAiToggleCandidate) return;
    void loadReaderAiModels();
  }, [loadReaderAiModels, readerAiAuthenticated, resetReaderAiModelsForAuth, showReaderAiToggleCandidate]);

  const readerAiEnabled = showReaderAiToggleCandidate && readerAiConfigured;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'l') return;
      if (!readerAiEnabled) return;
      event.preventDefault();
      onOpenReaderAi();
      focusReaderAiComposerInput();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusReaderAiComposerInput, onOpenReaderAi, readerAiEnabled]);

  // ── Repo mode availability ──
  const REPO_MODE_MAX_FILES = 100;
  const REPO_MODE_MAX_FILE_SIZE = 50 * 1024 * 1024;

  const isGistContext = currentGistId !== null && gistFiles !== null;
  const repoModeAvailable = Boolean(user) && (repoAccessMode !== null || isGistContext);

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

  const repoModeToggleDisabledReason = useMemo((): string | null => {
    if (readerAiRepoMode && readerAiMessages.length > 0) {
      return 'Clear chat to disable project mode';
    }
    return repoModeDisabledReason;
  }, [readerAiRepoMode, readerAiMessages.length, repoModeDisabledReason]);

  // Reset repo mode when navigating away from a repo/gist
  useEffect(() => {
    if (!repoModeAvailable) {
      setReaderAiRepoMode(false);
      setReaderAiRepoFiles(null);
      setReaderAiRetryAfterProjectModeEnable(false);
      if (readerAiProjectId) {
        void deleteReaderAiProjectSession(readerAiProjectId, readerAiSelectedModel);
        setReaderAiProjectId(null);
      }
    }
  }, [repoModeAvailable, readerAiProjectId, readerAiSelectedModel]);

  // Auto-enable repo mode when all files are already cached
  useEffect(() => {
    if (!repoModeAvailable || readerAiRepoMode || readerAiRepoModeLoading || repoModeDisabledReason) return;
    const allFiles = repoSidebarFiles.length > 0 ? repoSidebarFiles : repoFiles;
    if (allFiles.length === 0) return;

    let cached: RepoFileEntry[] | null = null;
    if (repoAccessMode === 'installed' && activeInstalledRepoInstallationId && selectedRepo) {
      cached = tryBuildRepoFilesFromCache(
        { installationId: activeInstalledRepoInstallationId, repoFullName: selectedRepo },
        allFiles,
      );
    } else if (repoAccessMode === 'public' && publicRepoRef) {
      cached = tryBuildRepoFilesFromCache({ owner: publicRepoRef.owner, repo: publicRepoRef.repo }, allFiles);
    }
    if (cached && cached.length > 0) {
      setReaderAiRepoFiles(cached);
      setReaderAiRepoMode(true);
      // Upload to server for project session
      void createReaderAiProjectSession(cached, readerAiSelectedModel)
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
    activeInstalledRepoInstallationId,
    selectedRepo,
    publicRepoRef,
    readerAiSelectedModel,
  ]);

  const onToggleRepoMode = useCallback(
    async (enabled: boolean) => {
      if (!enabled) {
        if (readerAiMessages.length > 0) {
          setReaderAiError('Clear chat before disabling project mode.');
          return;
        }
        setReaderAiRepoMode(false);
        setReaderAiRepoFiles(null);
        setReaderAiRetryAfterProjectModeEnable(false);
        if (readerAiProjectId) {
          void deleteReaderAiProjectSession(readerAiProjectId, readerAiSelectedModel);
          setReaderAiProjectId(null);
        }
        return;
      }
      const shouldRetryAfterEnable = readerAiSuggestProjectMode;

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
        } else if (repoAccessMode === 'installed' && activeInstalledRepoInstallationId && selectedRepo) {
          files = await getRepoTarball(activeInstalledRepoInstallationId, selectedRepo);
        } else if (repoAccessMode === 'public' && publicRepoRef) {
          files = await getPublicRepoTarball(publicRepoRef.owner, publicRepoRef.repo);
        } else {
          return;
        }
        // Upload files to server and get a project session ID
        const ps = await createReaderAiProjectSession(files, readerAiSelectedModel);
        setReaderAiRepoFiles(files);
        setReaderAiProjectId(ps.projectId);
        setReaderAiRepoMode(true);
        setReaderAiSuggestProjectMode(false);
        setReaderAiRetryAfterProjectModeEnable(shouldRetryAfterEnable);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        setReaderAiError(err instanceof Error ? err.message : 'Failed to load repo files');
        setReaderAiRepoMode(false);
        setReaderAiRepoFiles(null);
        setReaderAiProjectId(null);
        setReaderAiRetryAfterProjectModeEnable(false);
      } finally {
        setReaderAiRepoModeLoading(false);
      }
    },
    [
      repoAccessMode,
      activeInstalledRepoInstallationId,
      selectedRepo,
      publicRepoRef,
      showRateLimitToastIfNeeded,
      readerAiProjectId,
      readerAiSuggestProjectMode,
      readerAiMessages.length,
      isGistContext,
      gistFiles,
      readerAiSelectedModel,
    ],
  );

  const streamReaderAiAssistant = useCallback(
    async (baseMessages: ReaderAiMessage[], options?: { edited?: boolean }) => {
      const model = readerAiSelectedModel;
      // Read editContent from a ref to avoid recreating this callback on every keystroke.
      const currentEditContent = editContentRef.current;
      const documentSource = trimReaderAiSource(
        stripCriticMarkupComments(activeView === 'edit' ? currentEditContent : readerAiSource),
      );
      if (!model) return false;
      const assistantEdited = options?.edited === true;
      const nextConversationScope =
        readerAiConversationScope ??
        (() => {
          if (readerAiRepoMode || activeView !== 'edit') return { kind: 'document' } as ReaderAiConversationScope;
          const selection = editViewControllerRef.current?.getSelectionText(READER_AI_SELECTION_MAX_CHARS);
          if (!selection) return { kind: 'document' } as ReaderAiConversationScope;
          const sanitizedSelection = stripCriticMarkupComments(selection);
          if (!sanitizedSelection.trim()) return { kind: 'document' } as ReaderAiConversationScope;
          return {
            kind: 'selection',
            source: sanitizedSelection,
          } satisfies ReaderAiConversationScope;
        })();
      const source =
        !readerAiRepoMode && nextConversationScope.kind === 'selection' ? nextConversationScope.source : documentSource;
      readerAiAbortRef.current?.abort();
      const controller = new AbortController();
      readerAiAbortRef.current = controller;
      if (readerAiConversationScope === null) {
        setReaderAiConversationScope(nextConversationScope);
      }
      setReaderAiMessages([
        ...baseMessages,
        assistantEdited ? { role: 'assistant', content: '', edited: true } : { role: 'assistant', content: '' },
      ]);

      setReaderAiSending(true);
      setReaderAiToolStatus(null);
      setReaderAiToolLog([]);
      setReaderAiStagedChanges([]);
      setReaderAiSelectedChangeIds(new Set());
      setReaderAiSelectedHunkIdsByChangeId({});
      setReaderAiStagedChangesInvalid(false);
      setReaderAiStagedFileContents({});
      setReaderAiDocumentEditedContent(null);
      setReaderAiSuggestedCommitMessage('');
      setReaderAiError(null);
      setReaderAiSuggestProjectMode(false);
      let received = false;
      let receivedStagedChanges = false;
      let separateNextTurnOutput = false;
      let streamErrorMessage: string | null = null;
      let streamedResponseChars = 0;

      let effectiveProjectId = readerAiProjectId;
      const projectCurrentDocPath =
        activeView === 'edit' ? currentEditingDocPath : (currentRepoDocPath ?? currentFileName);
      const sanitizedMessages = baseMessages.map((message) => ({
        role: message.role,
        content: stripCriticMarkupComments(message.content),
      }));
      const streamContextLog = buildReaderAiContextLogPayload({
        model: selectedReaderAiModel,
        source,
        messages: sanitizedMessages,
        summary: readerAiSummary || undefined,
        mode: 'default',
        projectMode: readerAiRepoMode,
        currentDocPath: projectCurrentDocPath,
      });
      let loggedReceiveStart = false;
      const logReceiveStart = (trigger: string) => {
        if (loggedReceiveStart) return;
        loggedReceiveStart = true;
        console.log('[reader-ai-context] stream started', { ...streamContextLog, trigger });
      };
      console.log('[reader-ai-context] sending request', streamContextLog);

      try {
        // In edit mode, update the current file in the existing project session
        // instead of creating a brand-new session on every send.
        if (activeView === 'edit' && readerAiRepoMode && currentEditingDocPath && readerAiRepoFiles) {
          const contentSize = new TextEncoder().encode(currentEditContent).length;
          const fileExists = readerAiRepoFiles.some((file) => file.path === currentEditingDocPath);
          const nextFiles = fileExists
            ? readerAiRepoFiles.map((file) =>
                file.path === currentEditingDocPath
                  ? { ...file, content: currentEditContent, size: contentSize }
                  : file,
              )
            : [...readerAiRepoFiles, { path: currentEditingDocPath, content: currentEditContent, size: contentSize }];
          if (effectiveProjectId) {
            try {
              await updateReaderAiProjectSessionFile(
                effectiveProjectId,
                currentEditingDocPath,
                currentEditContent,
                readerAiSelectedModel,
              );
            } catch (err) {
              // Recover from expired/missing project session by creating a fresh one.
              if (!(err instanceof ApiError) || err.status !== 404) throw err;
              const nextProject = await createReaderAiProjectSession(nextFiles, readerAiSelectedModel);
              effectiveProjectId = nextProject.projectId;
              setReaderAiProjectId(nextProject.projectId);
            }
          } else {
            const nextProject = await createReaderAiProjectSession(nextFiles, readerAiSelectedModel);
            effectiveProjectId = nextProject.projectId;
            setReaderAiProjectId(nextProject.projectId);
          }
          setReaderAiRepoFiles(nextFiles);
        }

        // Build project context if repo mode is active (send project_id, not files)
        // If the project session was invalidated but we still have files, recreate it.
        if (readerAiRepoMode && !effectiveProjectId && readerAiRepoFiles) {
          const nextProject = await createReaderAiProjectSession(readerAiRepoFiles, readerAiSelectedModel);
          effectiveProjectId = nextProject.projectId;
          setReaderAiProjectId(nextProject.projectId);
        }
        let projectContext: { projectId: string; currentDocPath: string | null } | undefined;
        if (readerAiRepoMode && effectiveProjectId) {
          projectContext = {
            projectId: effectiveProjectId,
            currentDocPath: projectCurrentDocPath,
          };
        }

        await askReaderAiStream(
          model,
          source,
          sanitizedMessages,
          {
            signal: controller.signal,
            onSummary: (summary) => setReaderAiSummary(summary),
            onToolCall: (event) => {
              logReceiveStart('tool_call');
              const labels: Record<string, string> = {
                read_document: 'Reading document…',
                search_document: 'Searching document…',
                read_file: 'Reading file…',
                search_files: 'Searching files…',
                list_files: 'Listing files…',
                propose_edit_file: 'Proposing file edit…',
                propose_edit_document: 'Proposing document edit…',
                propose_create_file: 'Proposing file creation…',
                propose_delete_file: 'Proposing file deletion…',
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
                {
                  type: 'call',
                  name: event.name,
                  detail: typeof detail === 'string' ? detail : undefined,
                  taskId: event.name === 'task' ? event.id : undefined,
                },
              ]);
            },
            onToolResult: (event) => {
              logReceiveStart('tool_result');
              setReaderAiToolStatus(null);
              setReaderAiToolLog((log) => [
                ...log,
                {
                  type: 'result',
                  name: event.name,
                  detail: event.error ? `${event.error}${event.preview ? ` — ${event.preview}` : ''}` : event.preview,
                  taskId: event.name === 'task' ? event.id : undefined,
                  taskStatus: event.error ? 'error' : event.name === 'task' ? 'completed' : undefined,
                },
              ]);
            },
            onTaskProgress: (event) => {
              logReceiveStart('task_progress');
              const phaseLabel =
                event.phase === 'started'
                  ? 'Started'
                  : event.phase === 'iteration_start'
                    ? `Iteration ${event.iteration ?? '?'}`
                    : event.phase === 'tool_call'
                      ? 'Running tool'
                      : event.phase === 'tool_result'
                        ? 'Tool finished'
                        : event.phase === 'completed'
                          ? 'Completed'
                          : 'Error';
              const detail = event.detail ? `${phaseLabel}: ${event.detail}` : phaseLabel;
              setReaderAiToolStatus(detail);
              setReaderAiToolLog((log) => [...log, { type: 'progress', name: 'task', detail, taskId: event.id }]);
            },
            onStagedChanges: (changes, suggestedCommitMessage, documentContent, fileContents) => {
              logReceiveStart('staged_changes');
              receivedStagedChanges = changes.length > 0;
              const previousChangeIds = new Set(
                readerAiStagedChangesRef.current
                  .map((change) => change.id)
                  .filter((id): id is string => typeof id === 'string'),
              );
              const previousHunkIdsByChangeId = Object.fromEntries(
                readerAiStagedChangesRef.current
                  .filter((change) => change.id && Array.isArray(change.hunks))
                  .map((change) => [
                    change.id as string,
                    new Set(
                      (change.hunks ?? []).map((hunk) => hunk.id).filter((id): id is string => typeof id === 'string'),
                    ),
                  ]),
              );
              setReaderAiStagedChanges(changes);
              setReaderAiSelectedChangeIds((prev) => {
                const latestSelectedChangeIds = readerAiSelectedChangeIdsRef.current;
                const next = new Set<string>();
                for (const change of changes) {
                  if (!change.id) continue;
                  if (!previousChangeIds.has(change.id) || latestSelectedChangeIds.has(change.id)) next.add(change.id);
                }
                return next;
              });
              setReaderAiSelectedHunkIdsByChangeId((prev) => {
                const latestSelectedHunkIdsByChangeId = readerAiSelectedHunkIdsByChangeIdRef.current;
                const next: Record<string, Set<string>> = {};
                for (const change of changes) {
                  if (!change.id || !Array.isArray(change.hunks) || change.hunks.length === 0) continue;
                  const previousHunkIds = previousHunkIdsByChangeId[change.id] ?? new Set<string>();
                  const previousSelectedHunkIds = latestSelectedHunkIdsByChangeId[change.id] ?? new Set<string>();
                  next[change.id] = new Set(
                    change.hunks
                      .map((hunk) => hunk.id)
                      .filter(
                        (hunkId) => !previousHunkIds.has(hunkId) || previousSelectedHunkIds.has(hunkId),
                      ),
                  );
                }
                return next;
              });
              setReaderAiStagedChangesInvalid(false);
              setReaderAiStagedFileContents(() => {
                const next: Record<string, string> = {};
                const source = fileContents ?? {};
                for (const change of changes) {
                  if (change.type === 'delete') continue;
                  const content = source[change.path];
                  if (typeof content === 'string') next[change.path] = content;
                }
                return next;
              });
              setReaderAiDocumentEditedContent(typeof documentContent === 'string' ? documentContent : null);
              setReaderAiSuggestedCommitMessage(suggestedCommitMessage ?? '');
            },
            onTurnStart: (iteration) => {
              logReceiveStart('turn_start');
              if (iteration <= 0 || !separateNextTurnOutput) return;
              setReaderAiMessages((current) => {
                if (current.length === 0) return current;
                const updated = [...current];
                const lastIndex = updated.length - 1;
                const last = updated[lastIndex];
                if (last.role !== 'assistant' || !last.content.trim()) return current;
                if (last.content.endsWith('\n\n')) return current;
                updated[lastIndex] = { ...last, content: `${last.content}\n\n` };
                return updated;
              });
              separateNextTurnOutput = false;
            },
            onTurnEnd: (_iteration, reason) => {
              if (reason === 'tool_calls') separateNextTurnOutput = true;
            },
            onStreamError: (message) => {
              logReceiveStart('stream_error');
              streamErrorMessage = message;
              setReaderAiError(message);
            },
            onDelta: (delta) => {
              if (!delta) return;
              logReceiveStart('delta');
              received = true;
              streamedResponseChars += delta.length;
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
          projectCurrentDocPath,
          activeView === 'edit',
        );
        console.log('[reader-ai-context] stream finished', {
          ...streamContextLog,
          status: 'completed',
          receivedResponseChars: streamedResponseChars,
          hadStagedChanges: receivedStagedChanges,
        });
        if (!received) {
          const fallback = streamErrorMessage
            ? streamErrorMessage
            : receivedStagedChanges
              ? 'Done — see the proposed changes above.'
              : model.trim().toLowerCase().endsWith(':free')
                ? 'No response. Using a free endpoint, consider trying a different model.'
                : 'No response.';
          setReaderAiMessages((current) => {
            if (current.length === 0) {
              return assistantEdited
                ? [{ role: 'assistant', content: fallback, edited: true }]
                : [{ role: 'assistant', content: fallback }];
            }
            const updated = [...current];
            const lastIndex = updated.length - 1;
            const last = updated[lastIndex];
            if (last.role !== 'assistant') {
              updated.push(
                assistantEdited
                  ? { role: 'assistant', content: fallback, edited: true }
                  : { role: 'assistant', content: fallback },
              );
              return updated;
            }
            if (!last.content.trim()) updated[lastIndex] = { ...last, content: fallback };
            return updated;
          });
        }

        // Detect project mode suggestion marker from the AI and strip it.
        const PROJECT_MODE_MARKER = '<<SUGGEST_PROJECT_MODE>>';
        setReaderAiMessages((current) => {
          if (current.length === 0) return current;
          const last = current[current.length - 1];
          if (last.role !== 'assistant' || !last.content.includes(PROJECT_MODE_MARKER)) return current;
          setReaderAiSuggestProjectMode(true);
          const cleaned = last.content.replace(PROJECT_MODE_MARKER, '').replace(/^\s*\n/, '');
          const updated = [...current];
          updated[updated.length - 1] = { ...last, content: cleaned };
          return updated;
        });

        return true;
      } catch (err) {
        console.log('[reader-ai-context] stream finished', {
          ...streamContextLog,
          status: err instanceof DOMException && err.name === 'AbortError' ? 'aborted' : 'errored',
          error: err instanceof Error ? err.message : String(err),
          receivedResponseChars: streamedResponseChars,
        });
        setReaderAiMessages((current) => {
          if (current.length === 0) return current;
          const last = current[current.length - 1];
          if (last.role === 'assistant' && !last.content.trim()) return current.slice(0, -1);
          return current;
        });
        if (err instanceof DOMException && err.name === 'AbortError') return true;
        // Detect expired project session (404) and invalidate so the next send recreates it
        if (err instanceof ApiError && err.status === 404 && readerAiRepoMode && readerAiProjectId) {
          setReaderAiProjectId(null);
          setReaderAiError('Project session expired. Please try again.');
          return false;
        }
        setReaderAiError(err instanceof Error ? err.message : 'Reader AI request failed');
        return false;
      } finally {
        if (readerAiAbortRef.current === controller) readerAiAbortRef.current = null;
        setReaderAiSending(false);
        setReaderAiToolStatus(null);
      }
    },
    [
      readerAiSelectedModel,
      readerAiSource,
      readerAiSummary,
      readerAiConversationScope,
      readerAiRepoMode,
      readerAiProjectId,
      currentRepoDocPath,
      currentFileName,
      activeView,
      currentEditingDocPath,
      readerAiRepoFiles,
      selectedReaderAiModel,
    ],
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
    setReaderAiConversationScope(null);

    setReaderAiToolStatus(null);
    setReaderAiToolLog([]);
    setReaderAiStagedChanges([]);
    setReaderAiSelectedChangeIds(new Set());
    setReaderAiSelectedHunkIdsByChangeId({});
    setReaderAiAppliedChanges([]);
    setReaderAiUndoState(null);
    setReaderAiStagedChangesInvalid(false);
    setReaderAiStagedFileContents({});
    setReaderAiDocumentEditedContent(null);
    setReaderAiError(null);
    setReaderAiSuggestProjectMode(false);
    if (readerAiProjectId) void resetReaderAiProjectSession(readerAiProjectId, readerAiSelectedModel);
  }, [readerAiHistoryDocumentKey, readerAiProjectId, readerAiSelectedModel]);

  const onReaderAiApplyChanges = useCallback(
    async (mode: 'without-saving' | 'commit', commitMessage?: string) => {
      if (readerAiApplyingChanges || effectiveReaderAiStagedChanges.length === 0) return;
      setReaderAiApplyingChanges(true);
      setReaderAiError(null);

      const applied: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      const selectedChanges = effectiveReaderAiStagedChanges;
      const selectedFileContents = effectiveReaderAiStagedFileContents;
      const changeTypeByPath = new Map(selectedChanges.map((change) => [change.path, change.type]));
      const modifiedMap = new Map(Object.entries(selectedFileContents));
      const recordAppliedChanges = (paths: string[]) => {
        if (paths.length === 0) return;
        const appliedAt = new Date().toISOString();
        setReaderAiAppliedChanges((prev) => {
          const next = [
            ...prev,
            ...paths.map((path) => ({
              path,
              type: (changeTypeByPath.get(path) ?? 'edit') as 'edit' | 'create' | 'delete',
              appliedAt,
            })),
          ];
          return next.slice(-100);
        });
      };
      const hasCompleteStagedContent = selectedChanges.every(
        (change) => change.type === 'delete' || typeof selectedFileContents[change.path] === 'string',
      );
      const canCommitToGist =
        !readerAiStagedChangesInvalid && hasCompleteStagedContent && Boolean(isGistContext && currentGistId && user);
      const canCommitToRepo =
        !readerAiStagedChangesInvalid &&
        hasCompleteStagedContent &&
        Boolean(repoAccessMode === 'installed' && activeInstalledRepoInstallationId && selectedRepo);

      try {
        if (mode === 'without-saving') {
          if (activeView !== 'edit') throw new Error('Cannot apply without saving outside edit view');
          const currentPath = currentEditingDocPath;
          const nextContent =
            !readerAiProjectId && typeof readerAiDocumentEditedContent === 'string'
              ? readerAiDocumentEditedContent
              : currentPath
                ? modifiedMap.get(currentPath)
                : undefined;
          if (typeof nextContent !== 'string') {
            throw new Error('No staged document content to apply');
          }
          const previousContent = editContentRef.current;
          const previousRevision = editContentRevision;
          setNextEditContent(nextContent, { origin: 'appEdits' });
          setHasUserTypedUnsavedChanges(false);
          setHasUnsavedChanges(true);
          if (currentPath) {
            setReaderAiUndoState({
              path: currentPath,
              content: previousContent,
              revision: previousRevision,
            });
          } else {
            setReaderAiUndoState(null);
          }
          if (!canCommitToGist && !canCommitToRepo) {
            if (currentPath) recordAppliedChanges([currentPath]);
            setReaderAiStagedChanges([]);
            setReaderAiStagedFileContents({});
            setReaderAiDocumentEditedContent(null);
          }
          return;
        }

        const handleApplyConflict = async (conflict: { path: string; currentContent: string | null }) => {
          const conflictMessage =
            conflict.currentContent !== null
              ? 'The document changed after Reader AI generated this edit. Review the latest content, then retry.'
              : 'The document changed after Reader AI generated this edit. Refresh the file and retry.';
          setReaderAiError(conflictMessage);
          await showAlert(conflictMessage);
        };

        if (canCommitToGist && currentGistId) {
          const result = await applyReaderAiChanges(
            { kind: 'gist', gistId: currentGistId },
            selectedChanges,
            selectedFileContents,
            commitMessage,
          );
          if (result.conflict) {
            await handleApplyConflict(result.conflict);
            return;
          }
          applied.push(...result.applied);
          failed.push(...result.failed);
        } else if (canCommitToRepo && activeInstalledRepoInstallationId && selectedRepo) {
          const result = await applyReaderAiChanges(
            { kind: 'repo', installationId: activeInstalledRepoInstallationId, repoFullName: selectedRepo },
            selectedChanges,
            selectedFileContents,
            commitMessage,
          );
          if (result.conflict) {
            await handleApplyConflict(result.conflict);
            return;
          }
          applied.push(...result.applied);
          failed.push(...result.failed);
        } else {
          throw new Error('Cannot apply changes: no write access');
        }

        if (failed.length > 0 && applied.length > 0) {
          // Partial success
          recordAppliedChanges(applied);
          setReaderAiStagedChanges((prev) => prev.filter((c) => !applied.includes(c.path)));
          setReaderAiStagedFileContents((prev) => {
            const next = { ...prev };
            for (const path of applied) delete next[path];
            return next;
          });
          const failedPaths = failed.map((f) => f.path).join(', ');
          setReaderAiError(`Applied ${applied.length} file(s), but ${failed.length} failed: ${failedPaths}`);
        } else if (failed.length > 0) {
          const failedPaths = failed.map((f) => `${f.path}: ${f.error}`).join('; ');
          setReaderAiError(`Failed to apply changes: ${failedPaths}`);
        } else {
          // Full success — clear staged changes
          recordAppliedChanges(applied);
          setReaderAiStagedChanges([]);
          setReaderAiStagedFileContents({});
          if (readerAiProjectId) void resetReaderAiProjectSession(readerAiProjectId, readerAiSelectedModel);
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
      effectiveReaderAiStagedChanges,
      effectiveReaderAiStagedFileContents,
      readerAiDocumentEditedContent,
      readerAiProjectId,
      activeView,
      currentEditingDocPath,
      editContentRevision,
      user,
      isGistContext,
      currentGistId,
      repoAccessMode,
      activeInstalledRepoInstallationId,
      selectedRepo,
      readerAiStagedChangesInvalid,
      setNextEditContent,
      showAlert,
      showRateLimitToastIfNeeded,
      readerAiSelectedModel,
      setHasUnsavedChanges,
      setHasUserTypedUnsavedChanges,
    ],
  );

  const onReaderAiIgnoreChanges = useCallback(() => {
    setReaderAiStagedChanges([]);
    setReaderAiSelectedChangeIds(new Set());
    setReaderAiSelectedHunkIdsByChangeId({});
    setReaderAiStagedChangesInvalid(false);
    setReaderAiStagedFileContents({});
    setReaderAiDocumentEditedContent(null);
    setReaderAiUndoState(null);
    setReaderAiError(null);
  }, []);

  const canUndoReaderAiApply =
    readerAiUndoState !== null &&
    activeView === 'edit' &&
    currentEditingDocPath === readerAiUndoState.path &&
    editContentRevision === readerAiUndoState.revision + 1;

  const onReaderAiUndoApply = useCallback(() => {
    if (!readerAiUndoState) return;
    if (activeView !== 'edit' || currentEditingDocPath !== readerAiUndoState.path) {
      setReaderAiUndoState(null);
      return;
    }
    if (editContentRevision !== readerAiUndoState.revision + 1) {
      setReaderAiUndoState(null);
      return;
    }
    setNextEditContent(readerAiUndoState.content, { origin: 'appEdits', revision: readerAiUndoState.revision });
    setHasUserTypedUnsavedChanges(false);
    setHasUnsavedChanges(readerAiUndoState.content !== currentDocumentSavedContent);
    setReaderAiUndoState(null);
  }, [
    activeView,
    currentDocumentSavedContent,
    currentEditingDocPath,
    editContentRevision,
    readerAiUndoState,
    setNextEditContent,
    setHasUnsavedChanges,
    setHasUserTypedUnsavedChanges,
  ]);

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

  const cancelInlinePrompt = useCallback(() => {
    inlinePromptAbortRef.current?.abort();
    inlinePromptAbortRef.current = null;
  }, []);

  const onInlinePromptSubmit = useCallback(
    async ({ prompt, from, to, documentContent }: InlinePromptRequest) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || inlinePromptStreaming || readerAiSending || readerAiApplyingChanges) return;
      if (!readerAiSelectedModel) {
        showFailureToast('Select a Reader AI model before running an inline prompt.');
        return;
      }

      const controller = new AbortController();
      inlinePromptAbortRef.current?.abort();
      inlinePromptAbortRef.current = controller;
      setInlinePromptStreaming(true);

      let streamed = '';
      let completed = false;
      const sanitizedDocumentContent = trimReaderAiSource(stripCriticMarkupComments(documentContent));
      const sanitizedPromptMessage = stripCriticMarkupComments(trimmedPrompt);
      const inlineContextLog = buildReaderAiContextLogPayload({
        model: selectedReaderAiModel,
        source: sanitizedDocumentContent,
        messages: [{ role: 'user', content: sanitizedPromptMessage }],
        mode: 'default',
        projectMode: false,
        currentDocPath: currentEditingDocPath,
      });
      let loggedReceiveStart = false;
      const logReceiveStart = (trigger: string) => {
        if (loggedReceiveStart) return;
        loggedReceiveStart = true;
        console.log('[reader-ai-context] stream started', { ...inlineContextLog, trigger });
      };
      console.log('[reader-ai-context] sending request', inlineContextLog);

      editViewControllerRef.current?.startStreamingCursorTracking(from);
      editViewControllerRef.current?.applyExternalChange({
        from,
        to,
        insert: '',
        selection: { anchor: from, head: from },
        addToHistory: true,
        isolateHistory: 'before',
      });
      setNextEditContent((previousContent) => previousContent.slice(0, from) + previousContent.slice(to), {
        origin: 'streaming',
        selection: { anchor: from, head: from },
      });
      setHasUserTypedUnsavedChanges(true);
      setHasUnsavedChanges(true);

      try {
        await askReaderAiStream(
          readerAiSelectedModel,
          sanitizedDocumentContent,
          [{ role: 'user', content: sanitizedPromptMessage }],
          {
            signal: controller.signal,
            onTurnStart: () => logReceiveStart('turn_start'),
            onStreamError: () => logReceiveStart('stream_error'),
            onDelta: (delta) => {
              if (!delta) return;
              logReceiveStart('delta');
              const insertAt = from + streamed.length;
              editViewControllerRef.current?.applyExternalChange({
                from: insertAt,
                to: insertAt,
                insert: delta,
                addToHistory: true,
              });
              streamed += delta;
              editViewControllerRef.current?.updateStreamingCursorTracking(insertAt + delta.length);
              setNextEditContent(
                (previousContent) => previousContent.slice(0, insertAt) + delta + previousContent.slice(insertAt),
                { origin: 'streaming' },
              );
            },
          },
          undefined,
          undefined,
          currentEditingDocPath,
          true,
        );
        console.log('[reader-ai-context] stream finished', {
          ...inlineContextLog,
          status: 'completed',
          receivedResponseChars: streamed.length,
        });
        completed = true;
      } catch (err) {
        console.log('[reader-ai-context] stream finished', {
          ...inlineContextLog,
          status: err instanceof DOMException && err.name === 'AbortError' ? 'aborted' : 'errored',
          error: err instanceof Error ? err.message : String(err),
          receivedResponseChars: streamed.length,
        });
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          showFailureToast(err instanceof Error ? err.message : 'Inline AI prompt failed');
        }
      } finally {
        if (inlinePromptAbortRef.current === controller) inlinePromptAbortRef.current = null;
        editViewControllerRef.current?.stopStreamingCursorTracking();
        if (completed) {
          const end = from + streamed.length;
          editViewControllerRef.current?.applyExternalChange({
            from: end,
            to: end,
            insert: '',
            selection: { anchor: end, head: end },
            addToHistory: true,
            isolateHistory: 'after',
          });
          setNextEditContent((previousContent) => previousContent, {
            origin: 'streaming',
            selection: { anchor: end, head: end },
          });
        }
        setInlinePromptStreaming(false);
      }
    },
    [
      currentEditingDocPath,
      inlinePromptStreaming,
      readerAiApplyingChanges,
      readerAiSelectedModel,
      selectedReaderAiModel,
      readerAiSending,
      setNextEditContent,
      showFailureToast,
      setHasUnsavedChanges,
      setHasUserTypedUnsavedChanges,
    ],
  );

  const onBracePromptStream = useCallback(
    async (
      {
        prompt,
        documentContent,
        paragraphTail,
        mode,
        candidateCount,
        excludeOptions,
        chatMessages,
      }: BracePromptRequest,
      callbacks: { onDelta: (delta: string) => void },
      signal: AbortSignal,
    ) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) return;
      if (!readerAiSelectedModel) {
        throw new Error('Select a Reader AI model before requesting suggestions.');
      }

      const sanitizedDocumentContent = trimReaderAiSource(
        stripLeadingFrontMatter(stripCriticMarkupComments(documentContent)),
      );
      const requestPrompt = stripCriticMarkupComments(trimmedPrompt);
      const sanitizedParagraphTail = stripCriticMarkupComments(paragraphTail).trimEnd();
      const hasParagraphTail = mode === 'replace-with-paragraph-tail' && sanitizedParagraphTail;
      const requestContent = [
        hasParagraphTail
          ? 'The source contains a document with an inline brace query inside a paragraph.'
          : 'The source contains a document ending with an inline brace query.',
        `Brace query: ${requestPrompt}`,
        hasParagraphTail ? `Text after the brace in the same paragraph:\n${sanitizedParagraphTail}` : null,
        `Return exactly ${candidateCount} candidate replacement fragments for the text inside the braces.`,
        excludeOptions.length > 0
          ? `Already shown options that must not be repeated:\n${excludeOptions.map((option) => `- ${option}`).join('\n')}`
          : null,
        'Rules:',
        '- Output plain text only.',
        '- One option per line.',
        '- No numbering, bullets, quotes, or commentary.',
        '- Keep each option brief.',
        '- Each option must contain only the replacement fragment, not the full sentence or paragraph.',
        '- Do not repeat any surrounding document text.',
        excludeOptions.length > 0 ? '- Do not repeat, restate, or lightly paraphrase any already shown option.' : null,
        hasParagraphTail ? '- Do not repeat or continue the provided paragraph-tail context.' : null,
        hasParagraphTail
          ? '- Each option should read naturally when followed immediately by the provided paragraph-tail context.'
          : null,
        '- Each option should be ready to insert directly in place of the brace contents.',
        '- Unless the user explicitly asks, complete at maximum a single sentence, without adding new clauses through semicolons or em dashes.',
      ]
        .filter(Boolean)
        .join('\n');

      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user', content: requestContent },
      ];

      if (chatMessages.length > 0) {
        for (const chatMsg of chatMessages) {
          if (chatMsg.role === 'options') {
            messages.push({ role: 'assistant', content: chatMsg.content });
          } else {
            messages.push({
              role: 'user',
              content: [
                chatMsg.content,
                `Return exactly ${candidateCount} new candidate replacement fragments.`,
                'Follow the same rules as before.',
              ].join('\n'),
            });
          }
        }
      }

      await askReaderAiStream(
        readerAiSelectedModel,
        sanitizedDocumentContent,
        messages,
        {
          signal,
          onDelta: (delta) => {
            if (!delta) return;
            callbacks.onDelta(delta);
          },
        },
        undefined,
        undefined,
        currentEditingDocPath,
        true,
      );
    },
    [currentEditingDocPath, readerAiSelectedModel],
  );

  const onPromptListSubmit = useCallback(
    async ({
      prompt,
      documentContent,
      messages,
      answerIndent,
      insertFrom,
      insertTo,
      insertedPrefix,
      answerFrom,
    }: PromptListRequest) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || inlinePromptStreaming || readerAiSending || readerAiApplyingChanges) return;
      if (!readerAiSelectedModel) {
        showFailureToast('Select a Reader AI model before running a prompt question.');
        return;
      }

      const controller = new AbortController();
      inlinePromptAbortRef.current?.abort();
      inlinePromptAbortRef.current = controller;
      setInlinePromptStreaming(true);

      let streamedRaw = '';
      let bufferedRaw = '';
      let streamedAnswer = '';
      let completed = false;
      const sanitizedMessages = messages.map((message) => ({
        role: message.role,
        content: stripCriticMarkupComments(message.content),
      }));
      const promptListContextLog = buildReaderAiContextLogPayload({
        model: selectedReaderAiModel,
        source: '',
        messages: sanitizedMessages,
        mode: 'prompt_list',
        projectMode: false,
        currentDocPath: currentEditingDocPath,
      });
      let loggedReceiveStart = false;
      const logReceiveStart = (trigger: string) => {
        if (loggedReceiveStart) return;
        loggedReceiveStart = true;
        console.log('[reader-ai-context] stream started', { ...promptListContextLog, trigger });
      };
      console.log('[reader-ai-context] sending request', promptListContextLog);

      const applyPromptListAnswer = (nextRaw: string) => {
        const nextAnswer = formatPromptListAnswer(nextRaw, answerIndent);
        if (nextAnswer === streamedAnswer) return;
        const prefix = commonPrefixLength(streamedAnswer, nextAnswer);
        const suffix = commonSuffixLength(streamedAnswer, nextAnswer, prefix);
        const replaceFrom = answerFrom + prefix;
        const replaceTo = answerFrom + streamedAnswer.length - suffix;
        const insertText = nextAnswer.slice(prefix, nextAnswer.length - suffix);
        editViewControllerRef.current?.applyExternalChange({
          from: replaceFrom,
          to: replaceTo,
          insert: insertText,
          addToHistory: true,
        });
        streamedAnswer = nextAnswer;
        editViewControllerRef.current?.updateStreamingCursorTracking(answerFrom + streamedAnswer.length);
        setNextEditContent(
          (previousContent) => previousContent.slice(0, replaceFrom) + insertText + previousContent.slice(replaceTo),
          { origin: 'streaming' },
        );
      };

      editViewControllerRef.current?.applyExternalChange({
        from: insertFrom,
        to: insertTo,
        insert: insertedPrefix,
        selection: { anchor: answerFrom, head: answerFrom },
        scrollIntoView: true,
        addToHistory: true,
        isolateHistory: 'before',
      });
      editViewControllerRef.current?.startStreamingCursorTracking(answerFrom);
      setNextEditContent(
        (previousContent) => previousContent.slice(0, insertFrom) + insertedPrefix + previousContent.slice(insertTo),
        {
          origin: 'streaming',
          selection: { anchor: answerFrom, head: answerFrom },
        },
      );
      setHasUserTypedUnsavedChanges(true);
      setHasUnsavedChanges(true);

      try {
        await askReaderAiStream(
          readerAiSelectedModel,
          '',
          sanitizedMessages,
          {
            signal: controller.signal,
            mode: 'prompt_list',
            onTurnStart: () => logReceiveStart('turn_start'),
            onStreamError: () => logReceiveStart('stream_error'),
            onDelta: (delta) => {
              if (delta) logReceiveStart('delta');
              bufferedRaw += delta;
              const { stable, remainder } = splitPromptListStableText(bufferedRaw);
              bufferedRaw = remainder;
              if (!stable) return;
              streamedRaw += stable;
              applyPromptListAnswer(streamedRaw);
            },
          },
          undefined,
          undefined,
          currentEditingDocPath,
          true,
        );
        console.log('[reader-ai-context] stream finished', {
          ...promptListContextLog,
          status: 'completed',
          receivedResponseChars: streamedRaw.length + bufferedRaw.length,
        });
        if (bufferedRaw) {
          streamedRaw += bufferedRaw;
          bufferedRaw = '';
          applyPromptListAnswer(streamedRaw);
        }
        completed = true;
      } catch (err) {
        console.log('[reader-ai-context] stream finished', {
          ...promptListContextLog,
          status: err instanceof DOMException && err.name === 'AbortError' ? 'aborted' : 'errored',
          error: err instanceof Error ? err.message : String(err),
          receivedResponseChars: streamedRaw.length + bufferedRaw.length,
        });
        if (streamedAnswer.length === 0) {
          setNextEditContent(documentContent, {
            origin: 'appEdits',
            selection: { anchor: insertFrom, head: insertFrom },
          });
        }
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          showFailureToast(err instanceof Error ? err.message : 'Prompt question failed');
        }
      } finally {
        if (inlinePromptAbortRef.current === controller) inlinePromptAbortRef.current = null;
        editViewControllerRef.current?.stopStreamingCursorTracking();
        if (completed) {
          const end = answerFrom + streamedAnswer.length;
          editViewControllerRef.current?.applyExternalChange({
            from: end,
            to: end,
            insert: '',
            selection: { anchor: end, head: end },
            addToHistory: true,
            isolateHistory: 'after',
          });
          setNextEditContent((previousContent) => previousContent, {
            origin: 'streaming',
            selection: { anchor: end, head: end },
          });
        }
        setInlinePromptStreaming(false);
      }
    },
    [
      currentEditingDocPath,
      inlinePromptStreaming,
      readerAiApplyingChanges,
      readerAiSelectedModel,
      selectedReaderAiModel,
      readerAiSending,
      setNextEditContent,
      showFailureToast,
      setHasUnsavedChanges,
      setHasUserTypedUnsavedChanges,
    ],
  );

  useEffect(() => {
    if (!readerAiRetryAfterProjectModeEnable || !readerAiRepoMode || readerAiSending) return;
    setReaderAiRetryAfterProjectModeEnable(false);
    void onReaderAiRetryLastMessage();
  }, [readerAiRetryAfterProjectModeEnable, readerAiRepoMode, readerAiSending, onReaderAiRetryLastMessage]);

  // --- Sign out ---
  const signOut = useCallback(() => {
    void (async () => {
      await logout().catch(() => {});
      clearAuthDataCaches();
      resetReaderAiModelsForAuth(false);
      clearInstallationId();
      clearSelectedRepo();
      setUser(null);
      setInstId(null);
      setSelectedRepo(null);
      setSelectedRepoPrivate(null);
      setSelectedRepoInstallationId(null);
      setRepoAccessMode(null);
      setPublicRepoRef(null);
      setCurrentGistId(null);
      setRepoFiles([]);
      setRepoSidebarFiles([]);
      navigate(routePath.home());
    })();
  }, [clearAuthDataCaches, navigate, resetReaderAiModelsForAuth]);

  const selectedRepoRef = useMemo(() => parseRepoFullName(selectedRepo), [selectedRepo]);
  const currentRouteRepoRef = useMemo(() => {
    if (route.name === 'repofile' || route.name === 'repoedit') {
      return {
        owner: safeDecodeURIComponent(route.params.owner),
        repo: safeDecodeURIComponent(route.params.repo),
      };
    }
    return null;
  }, [route]);
  const currentMenuRepoRef = useMemo(() => {
    if (
      route.name === 'repodocuments' ||
      route.name === 'repofile' ||
      route.name === 'repoedit' ||
      route.name === 'sharefile'
    ) {
      return {
        owner: safeDecodeURIComponent(route.params.owner),
        repo: safeDecodeURIComponent(route.params.repo),
      };
    }
    return null;
  }, [route]);
  const currentMenuRepoFullName = useMemo(() => {
    if (repoAccessMode === 'installed' && selectedRepo) return selectedRepo;
    if (repoAccessMode === 'public' && publicRepoRef) return buildRepoFullName(publicRepoRef.owner, publicRepoRef.repo);
    if (currentMenuRepoRef) return buildRepoFullName(currentMenuRepoRef.owner, currentMenuRepoRef.repo);
    return null;
  }, [currentMenuRepoRef, publicRepoRef, repoAccessMode, selectedRepo]);

  useEffect(() => {
    if (!currentMenuRepoFullName) return;
    const nextRecentRepo: RecentRepoVisit =
      repoAccessMode === 'installed'
        ? {
            fullName: currentMenuRepoFullName,
            installationId: activeInstalledRepoInstallationId ?? installationId ?? null,
            source: 'installed',
          }
        : {
            fullName: currentMenuRepoFullName,
            installationId: null,
            source: 'public',
          };
    setRecentRepos((previous) => {
      const next = pushRecentRepoVisit(previous, nextRecentRepo);
      writeStoredRecentRepos(next);
      return next;
    });
  }, [activeInstalledRepoInstallationId, currentMenuRepoFullName, installationId, repoAccessMode]);

  const onEdit = useCallback(() => {
    const repoRef =
      repoAccessMode === 'installed' ? selectedRepoRef : repoAccessMode === 'shared' ? currentRouteRepoRef : null;
    if ((repoAccessMode === 'installed' || repoAccessMode === 'shared') && currentRepoDocPath && repoRef) {
      navigate(routePath.repoEdit(repoRef.owner, repoRef.repo, currentRepoDocPath));
    } else if (currentGistId && currentFileName) navigate(routePath.gistEdit(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistEdit(currentGistId));
  }, [
    repoAccessMode,
    currentRepoDocPath,
    currentGistId,
    currentFileName,
    navigate,
    selectedRepoRef,
    currentRouteRepoRef,
  ]);

  const onToggleContentSourceView = useCallback(() => {
    setContentSourceViewVisible((current) => !current);
  }, []);

  useEffect(() => {
    if (activeView === 'content' && repoAccessMode === 'public') return;
    setContentSourceViewVisible(false);
  }, [activeView, repoAccessMode]);

  const onCancel = useCallback(async () => {
    if (readerAiEditLocked) return;
    if (pendingImageUploads.size > 0) {
      void showAlert('Wait for image uploads to finish before leaving the editor.');
      return;
    }
    const currentEditContent = editContentRef.current;
    if (
      activeView === 'edit' &&
      (hasEffectiveUnsavedChanges || isScratchDocument) &&
      currentEditContent.trim().length > 0
    ) {
      const leave = await showConfirm('Leave the editor? You have unsaved changes.', {
        title: 'Unsaved changes',
        defaultFocus: 'cancel',
      });
      if (!leave) return;
    }
    if (!hasUnsavedChanges && editingBackend === 'gist' && currentGistId && currentFileName === null) {
      clearPersistedNewGistFileDraft(currentGistId);
    }
    const returnToPath = parseScratchReturnPathState(routeState);
    if (returnToPath) {
      navigate(returnToPath, { replace: true, state: null });
      return;
    }
    const currentDocRepoRef =
      repoAccessMode === 'installed' ? selectedRepoRef : repoAccessMode === 'shared' ? currentRouteRepoRef : null;
    if (currentRepoDocPath && currentDocRepoRef) {
      navigate(routePath.repoFile(currentDocRepoRef.owner, currentDocRepoRef.repo, currentRepoDocPath));
    } else if (currentGistId && currentFileName) navigate(routePath.gistView(currentGistId, currentFileName));
    else if (currentGistId) navigate(routePath.gistView(currentGistId));
    else if (selectedRepoRef) await openInstalledRepo(buildRepoFullName(selectedRepoRef.owner, selectedRepoRef.repo));
    else navigate(routePath.workspaces());
  }, [
    activeView,
    hasEffectiveUnsavedChanges,
    isScratchDocument,
    readerAiEditLocked,
    pendingImageUploads,
    showAlert,
    showConfirm,
    editingBackend,
    currentRepoDocPath,
    currentGistId,
    currentFileName,
    currentRouteRepoRef,
    repoAccessMode,
    selectedRepoRef,
    openInstalledRepo,
    navigate,
    routeState,
    hasUnsavedChanges,
  ]);

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
          const instId = activeInstalledRepoInstallationId ?? getInstallationId();
          if (!instId) {
            showFailureToast('Sharing is not available for this file');
            return;
          }
          const shareLink = await createRepoFileShareLink(instId, selectedRepo, currentRepoDocPath);
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
    activeInstalledRepoInstallationId,
  ]);

  const loadCompactCommits = useCallback(async () => {
    if (!activeInstalledRepoInstallationId || !selectedRepo) return;
    setCompactCommitsLoading(true);
    setCompactCommitsError(null);
    try {
      const data = await listRepoRecentCommits(activeInstalledRepoInstallationId, selectedRepo, 20);
      setCompactCommitsData(data);
      setCompactCommitSelection(new Set());
      setCompactCommitMessage('Compact recent commits');
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
        return;
      }
      showRateLimitToastIfNeeded(err);
      setCompactCommitsData(null);
      setCompactCommitsError(err instanceof Error ? err.message : 'Failed to load recent commits');
    } finally {
      setCompactCommitsLoading(false);
    }
  }, [activeInstalledRepoInstallationId, handleSessionExpired, selectedRepo, showRateLimitToastIfNeeded]);

  const openCompactCommitsDialog = useCallback(() => {
    if (repoAccessMode !== 'installed' || !activeInstalledRepoInstallationId || !selectedRepo) return;
    setCompactCommitsOpen(true);
    void loadCompactCommits();
  }, [activeInstalledRepoInstallationId, loadCompactCommits, repoAccessMode, selectedRepo]);

  const closeCompactCommitsDialog = useCallback(() => {
    if (compactCommitsSubmitting) return;
    setCompactCommitsOpen(false);
    setCompactCommitsError(null);
    setCompactCommitsLoading(false);
    setCompactCommitsData(null);
    setCompactCommitSelection(new Set());
    setCompactCommitMessage('Compact recent commits');
  }, [compactCommitsSubmitting]);

  const toggleCompactCommitSelection = useCallback(
    (sha: string, checked: boolean) => {
      setCompactCommitSelection(() => {
        const commits = compactCommitsData?.commits ?? [];
        const targetIndex = commits.findIndex((commit) => commit.sha === sha);
        if (targetIndex < 0) return new Set<string>();

        if (checked) {
          return new Set(commits.slice(0, targetIndex + 1).map((commit) => commit.sha));
        }

        return new Set(commits.slice(0, targetIndex).map((commit) => commit.sha));
      });
    },
    [compactCommitsData],
  );

  const toggleAllCompactCommits = useCallback(() => {
    setCompactCommitSelection((current) => {
      const commits = compactCommitsData?.commits ?? [];
      if (commits.length === 0) return current;
      if (current.size > 0) return new Set<string>();
      let compactablePrefixLength = 0;
      while (compactablePrefixLength < commits.length && commits[compactablePrefixLength]!.parentCount === 1) {
        compactablePrefixLength += 1;
      }
      return new Set(commits.slice(0, compactablePrefixLength).map((commit) => commit.sha));
    });
  }, [compactCommitsData]);

  const submitCompactCommits = useCallback(async () => {
    if (!activeInstalledRepoInstallationId || !selectedRepo || !compactCommitsData?.headSha) return;
    const selectedShas = compactCommitsData.commits
      .filter((commit) => compactCommitSelection.has(commit.sha))
      .map((commit) => commit.sha);
    if (selectedShas.length < 2) return;

    const confirmed = await showConfirm(
      `Compact ${selectedShas.length} recent commits on ${selectedRepo} and force push ${compactCommitsData.branch}?`,
      {
        title: 'Compact recent commits',
        confirmLabel: 'Force push',
        cancelLabel: 'Cancel',
        intent: 'danger',
        defaultFocus: 'cancel',
      },
    );
    if (!confirmed) return;

    setCompactCommitsSubmitting(true);
    try {
      const result = await compactRepoRecentCommits(activeInstalledRepoInstallationId, selectedRepo, {
        headSha: compactCommitsData.headSha,
        selectedShas,
        message: compactCommitMessage.trim(),
      });
      showSuccessToast(`Compacted ${result.replacedCommitCount} commits on ${result.branch}`);
      setCompactCommitsOpen(false);
      setCompactCommitsError(null);
      setCompactCommitsData(null);
      setCompactCommitSelection(new Set());
      setCompactCommitMessage('Compact recent commits');
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
        return;
      }
      if (err instanceof ApiError && err.code === 'repo_ref_conflict') {
        setCompactCommitsError(err.message);
        void loadCompactCommits();
        return;
      }
      showRateLimitToastIfNeeded(err);
      setCompactCommitsError(err instanceof Error ? err.message : 'Failed to compact commits');
    } finally {
      setCompactCommitsSubmitting(false);
    }
  }, [
    activeInstalledRepoInstallationId,
    compactCommitMessage,
    compactCommitSelection,
    compactCommitsData,
    handleSessionExpired,
    loadCompactCommits,
    selectedRepo,
    showConfirm,
    showRateLimitToastIfNeeded,
    showSuccessToast,
  ]);

  const applyDraftContentToEditor = useCallback(
    (content: string) => {
      if (activeView !== 'edit') return;
      setNextEditContent(content, { origin: 'appEdits' });
      setHasUserTypedUnsavedChanges(false);
      setHasUnsavedChanges(content !== currentDocumentSavedContent);
    },
    [activeView, currentDocumentSavedContent, setNextEditContent, setHasUnsavedChanges, setHasUserTypedUnsavedChanges],
  );

  const discardCurrentDocumentChanges = useCallback(() => {
    if (currentDocumentDraftKey) {
      removeDocumentDraft(currentDocumentDraftKey);
      setCurrentDocumentDraft(null);
    }
    if (editingBackend === 'gist' && currentGistId && currentFileName === null) {
      clearPersistedNewGistFileDraft(currentGistId);
    }
    setHasUserTypedUnsavedChanges(false);
    setHasUnsavedChanges(false);
  }, [
    currentDocumentDraftKey,
    editingBackend,
    currentGistId,
    currentFileName,
    setCurrentDocumentDraft,
    setHasUnsavedChanges,
    setHasUserTypedUnsavedChanges,
  ]);

  const requestScratchFileName = useCallback(
    async (defaultValue: string, existingPaths?: Set<string>, folderPath = ''): Promise<string | null> => {
      const MAX_ATTEMPTS = 10;
      let proposedValue = defaultValue;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const input = await showPrompt('Filename:', proposedValue);
        if (input === null) return null;
        const filename = sanitizeScratchFileNameInput(input);
        if (!filename) {
          await showAlert('Enter a valid filename without folder separators.');
          proposedValue = input;
          continue;
        }
        const path = folderPath ? `${folderPath}/${filename}` : filename;
        if (existingPaths?.has(path)) {
          await showAlert(`"${path}" already exists.`);
          proposedValue = filename;
          continue;
        }
        return filename;
      }
      return null;
    },
    [showAlert, showPrompt],
  );

  const commitDocumentContent = useCallback(
    async (options?: { content?: string; title?: string }): Promise<CommitResult | null> => {
      if (saveInFlightRef.current || readerAiEditLocked) return null;
      if (pendingImageUploads.size > 0) {
        void showAlert('Wait for image uploads to finish before saving.');
        return null;
      }
      const title = (options?.title ?? editTitle).trim() || DEFAULT_NEW_FILENAME;
      const content = options?.content ?? editContentRef.current;
      let scratchFilename: string | null = null;

      if (editingBackend === 'repo' && currentRepoDocPath === null) {
        const folderPath = activeScratchFile?.backend === 'repo' ? activeScratchFile.parentPath : '';
        scratchFilename = await requestScratchFileName(
          DEFAULT_SCRATCH_FILENAME,
          new Set(repoSidebarFiles.map((file) => file.path)),
          folderPath,
        );
        if (!scratchFilename) return null;
      } else if (editingBackend === 'gist' && currentFileName === null) {
        const gistScratchDraft = activeScratchFile?.backend === 'gist' ? activeScratchFile.draft : null;
        if (currentGistId) {
          scratchFilename = await requestScratchFileName(
            gistScratchDraft?.filename || DEFAULT_SCRATCH_FILENAME,
            new Set(Object.keys(gistFiles ?? {})),
            gistScratchDraft?.parentPath || '',
          );
          if (!scratchFilename) return null;
          writePersistedNewGistFileDraft(currentGistId, {
            title: gistScratchDraft?.title || editTitle || UNSAVED_FILE_LABEL,
            content,
            filename: scratchFilename,
            parentPath: gistScratchDraft?.parentPath || '',
          });
        } else {
          scratchFilename = await requestScratchFileName(DEFAULT_SCRATCH_FILENAME);
          if (!scratchFilename) return null;
        }
      }
      let saved = false;
      let commitResult: CommitResult | null = null;
      saveInFlightRef.current = true;
      setSaving(true);

      try {
        const instId = activeInstalledRepoInstallationId ?? getInstallationId();
        const repoName = selectedRepo ?? getSelectedRepo()?.full_name ?? null;
        const currentRepoRef =
          repoAccessMode === 'installed' ? selectedRepoRef : repoAccessMode === 'shared' ? currentRouteRepoRef : null;
        const currentRepoFullName =
          repoAccessMode === 'installed'
            ? repoName
            : repoAccessMode === 'shared' && currentRouteRepoRef
              ? `${currentRouteRepoRef.owner}/${currentRouteRepoRef.repo}`
              : null;

        if (editingBackend === 'repo' && currentRepoDocPath && repoAccessMode === 'shared' && currentRepoRef) {
          const contentB64 = encodeUtf8ToBase64(content);
          const result = await putEditorSharedRepoFile(
            currentRepoRef.owner,
            currentRepoRef.repo,
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
          setCurrentDocumentSavedContent(content);
          if (currentDocumentDraftKey) {
            removeDocumentDraft(currentDocumentDraftKey);
            setCurrentDocumentDraft(null);
          }

          renderDocumentContent(content, currentRepoDocPath.split('/').pop() ?? null, currentRepoDocPath, undefined, {
            currentDocPath: currentRepoDocPath,
            knownMarkdownPaths: [currentRepoDocPath],
          });
          if (sharedRepoInstallationId && currentRepoFullName) {
            const routeKey = routeKeyForRepo(currentRepoRef.owner, currentRepoRef.repo, currentRepoDocPath);
            updatePostSaveVerification({
              routeKey,
              status: 'verifying',
              kind: 'repo',
              installationId: sharedRepoInstallationId,
              repoFullName: currentRepoFullName,
              path: currentRepoDocPath,
              expectedSha: result.content.sha,
            });
            commitResult = {
              kind: 'repo',
              created: false,
              owner: currentRepoRef.owner,
              repo: currentRepoRef.repo,
              path: currentRepoDocPath,
              routeKey,
            };
          } else {
            commitResult = {
              kind: 'repo',
              created: false,
              owner: currentRepoRef.owner,
              repo: currentRepoRef.repo,
              path: currentRepoDocPath,
              routeKey: null,
            };
          }
        } else if (editingBackend === 'repo' && currentRepoDocPath && instId && repoName) {
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
          setCurrentDocumentSavedContent(content);
          if (currentDocumentDraftKey) {
            removeDocumentDraft(currentDocumentDraftKey);
            setCurrentDocumentDraft(null);
          }

          const knownMarkdownPaths = repoFiles.filter((file) => isMarkdownFileName(file.path)).map((file) => file.path);
          renderDocumentContent(content, currentRepoDocPath.split('/').pop() ?? null, currentRepoDocPath, undefined, {
            currentDocPath: currentRepoDocPath,
            knownMarkdownPaths: knownMarkdownPaths.includes(currentRepoDocPath)
              ? knownMarkdownPaths
              : [...knownMarkdownPaths, currentRepoDocPath],
          });
          if (currentRepoRef) {
            const routeKey = routeKeyForRepo(currentRepoRef.owner, currentRepoRef.repo, currentRepoDocPath);
            updatePostSaveVerification({
              routeKey,
              status: 'verifying',
              kind: 'repo',
              installationId: instId,
              repoFullName: repoName,
              path: currentRepoDocPath,
              expectedSha: result.content.sha,
            });
            commitResult = {
              kind: 'repo',
              created: false,
              owner: currentRepoRef.owner,
              repo: currentRepoRef.repo,
              path: currentRepoDocPath,
              routeKey,
            };
          } else {
            commitResult = {
              kind: 'repo',
              created: false,
              owner: null,
              repo: null,
              path: currentRepoDocPath,
              routeKey: null,
            };
          }
        } else if (editingBackend === 'repo' && repoName && instId) {
          const draftPath =
            activeScratchFile?.backend === 'repo' ? activeScratchFile.draftPath : resolveRepoNewDraftPath(route);
          const path = scratchFilename
            ? resolveRepoNewFilePath(route, scratchFilename, { literal: true })
            : resolveRepoNewFilePath(route, title);
          const contentB64 = encodeUtf8ToBase64(content);
          const result = await putRepoFile(instId, repoName, path, `Create ${fileNameFromPath(path)}`, contentB64);
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
          if (draftPath) {
            localStorage.removeItem(repoNewDraftKey(instId, repoName, draftPath, 'title'));
            localStorage.removeItem(repoNewDraftKey(instId, repoName, draftPath, 'content'));
          }
          setCurrentRepoDocPath(result.content.path);
          setCurrentRepoDocSha(result.content.sha);
          setCurrentFileName(result.content.path);
          setCurrentDocumentSavedContent(content);

          const knownMarkdownPaths = repoFiles.filter((file) => isMarkdownFileName(file.path)).map((file) => file.path);
          const createdPath = result.content.path;
          renderDocumentContent(content, fileNameFromPath(createdPath), createdPath, undefined, {
            currentDocPath: createdPath,
            knownMarkdownPaths: knownMarkdownPaths.includes(createdPath)
              ? knownMarkdownPaths
              : [...knownMarkdownPaths, createdPath],
          });
          if (selectedRepoRef) {
            const routeKey = routeKeyForRepo(selectedRepoRef.owner, selectedRepoRef.repo, createdPath);
            updatePostSaveVerification({
              routeKey,
              status: 'verifying',
              kind: 'repo',
              installationId: instId,
              repoFullName: repoName,
              path: createdPath,
              expectedSha: result.content.sha,
            });
            commitResult = {
              kind: 'repo',
              created: true,
              owner: selectedRepoRef.owner,
              repo: selectedRepoRef.repo,
              path: createdPath,
              routeKey,
            };
          } else {
            commitResult = {
              kind: 'repo',
              created: true,
              owner: null,
              repo: null,
              path: createdPath,
              routeKey: null,
            };
          }
        } else {
          let gist: GistDetail;
          const gistScratchDraft = activeScratchFile?.backend === 'gist' ? activeScratchFile.draft : null;
          const filename =
            currentFileName ??
            (scratchFilename
              ? buildScratchFilePath(gistScratchDraft?.parentPath, scratchFilename)
              : sanitizeTitleToFileName(title));
          const created = currentGistId === null;
          if (currentGistId) {
            gist = await updateGist(currentGistId, content, filename);
            if (currentFileName === null) {
              clearPersistedNewGistFileDraft(currentGistId);
            }
          } else {
            gist = await createGist(content, filename, title === UNSAVED_FILE_LABEL ? undefined : title);
            markGistRecentlyCreated(user?.login ?? null, gist);
          }
          setCurrentGistId(gist.id);
          setCurrentFileName(filename);
          setGistFiles(gist.files);
          setCurrentGistCreatedAt(gist.created_at);
          setCurrentGistUpdatedAt(gist.updated_at);
          setCurrentDocumentSavedContent(content);
          if (currentDocumentDraftKey) {
            removeDocumentDraft(currentDocumentDraftKey);
            setCurrentDocumentDraft(null);
          }
          if (draftMode) {
            localStorage.removeItem(DRAFT_TITLE_KEY);
            localStorage.removeItem(DRAFT_CONTENT_KEY);
            setDraftMode(false);
          }

          renderDocumentContent(content, filename, null, undefined, {
            currentDocPath: filename,
            knownMarkdownPaths: Object.keys(gist.files),
          });
          const routeKey = routeKeyForGist(gist.id, filename);
          updatePostSaveVerification({
            routeKey,
            status: 'verifying',
            kind: 'gist',
            gistId: gist.id,
            filename,
            expectedUpdatedAt: gist.updated_at,
          });
          commitResult = {
            kind: 'gist',
            created,
            gistId: gist.id,
            filename,
            routeKey,
          };
        }
        showSuccessToast('Saved');
        saved = true;
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return null;
        }
        showRateLimitToastIfNeeded(err);
        const staleRepoWrite = editingBackend === 'repo' && isRepoWriteConflictError(err);
        const message = staleRepoWrite
          ? "Save failed: your write wasn't persisted because the file changed upstream. Copy your edits, reload, merge, and save again."
          : err instanceof Error
            ? err.message
            : 'Failed to save';
        void showAlert(message);
        return null;
      } finally {
        saveInFlightRef.current = false;
        setSaving(false);
        if (saved) setHasUnsavedChanges(false);
      }

      return commitResult;
    },
    [
      currentDocumentDraftKey,
      currentFileName,
      currentGistId,
      currentRepoDocPath,
      currentRepoDocSha,
      currentRouteRepoRef,
      draftMode,
      editTitle,
      editingBackend,
      handleSessionExpired,
      pendingImageUploads,
      readerAiEditLocked,
      renderDocumentContent,
      repoAccessMode,
      repoSidebarFiles,
      repoFiles,
      route,
      activeScratchFile,
      requestScratchFileName,
      selectedRepoRef,
      showAlert,
      showRateLimitToastIfNeeded,
      showSuccessToast,
      updatePostSaveVerification,
      user,
      gistFiles,
      saveInFlightRef,
      setCurrentDocumentDraft,
      setCurrentDocumentSavedContent,
      setHasUnsavedChanges,
      setSaving,
      sharedRepoInstallationId,
      activeInstalledRepoInstallationId,
      selectedRepo,
    ],
  );

  const onResetDraftChanges = useCallback(async () => {
    if (!currentDocumentDraftKey || !currentDocumentDraft || currentDocumentSavedContent === null) return;
    const action = await showDiffChoice(
      `Discard the saved local draft for "${currentDocumentLabel}" and keep the backend version?`,
      [
        {
          path: currentFileName ?? currentRepoDocPath ?? currentDocumentLabel,
          diff: generateUnifiedDiff(
            currentFileName ?? currentRepoDocPath ?? 'document.md',
            currentDocumentDraft.content,
            currentDocumentSavedContent,
          ),
        },
      ],
      {
        title: 'Reset changes',
        secondaryActionLabel: 'Reset without commit',
        primaryActionLabel: 'Reset and commit',
        primaryActionInSecondaryMenu: true,
        cancelLabel: 'Cancel',
        secondaryActionIntent: 'default',
        primaryActionIntent: 'danger',
        defaultFocus: 'cancel',
        leftLabel: 'Will be discarded',
        rightLabel: 'After reset',
      },
    );
    if (action === 'cancel') return;
    removeDocumentDraft(currentDocumentDraftKey);
    setCurrentDocumentDraft(null);
    applyDraftContentToEditor(currentDocumentSavedContent);
    if (action === 'primary' && activeView === 'edit') {
      await commitDocumentContent({ content: currentDocumentSavedContent });
    }
  }, [
    activeView,
    applyDraftContentToEditor,
    currentDocumentDraft,
    currentDocumentDraftKey,
    currentDocumentLabel,
    currentDocumentSavedContent,
    currentFileName,
    currentRepoDocPath,
    commitDocumentContent,
    showDiffChoice,
    setCurrentDocumentDraft,
  ]);

  const stayOnEditRouteAfterCommit = useCallback(
    (commitResult: CommitResult) => {
      if (commitResult.kind === 'repo') {
        if (!commitResult.owner || !commitResult.repo) return;
        const target = routePath.repoEdit(commitResult.owner, commitResult.repo, commitResult.path);
        const isSameRoute =
          route.name === 'repoedit' &&
          safeDecodeURIComponent(route.params.owner) === commitResult.owner &&
          safeDecodeURIComponent(route.params.repo) === commitResult.repo &&
          safeDecodeURIComponent(route.params.path).replace(/^\/+/, '') === commitResult.path;
        if (!isSameRoute) {
          navigate(target, { replace: true, state: null });
        }
        return;
      }

      const target = routePath.gistEdit(commitResult.gistId, commitResult.filename);
      const isSameRoute =
        route.name === 'edit' &&
        route.params.id === commitResult.gistId &&
        (route.params.filename ? safeDecodeURIComponent(route.params.filename) : undefined) === commitResult.filename;
      if (!isSameRoute) {
        navigate(target, { replace: true, state: null });
      }
    },
    [navigate, route],
  );

  const exitEditRouteAfterCommit = useCallback(
    (commitResult: CommitResult) => {
      if (commitResult.kind === 'repo') {
        if (commitResult.owner && commitResult.repo) {
          navigate(routePath.repoFile(commitResult.owner, commitResult.repo, commitResult.path), { state: null });
        } else if (currentRepoDocPath) {
          const repoRef =
            repoAccessMode === 'installed' ? selectedRepoRef : repoAccessMode === 'shared' ? currentRouteRepoRef : null;
          if (repoRef) {
            navigate(routePath.repoFile(repoRef.owner, repoRef.repo, currentRepoDocPath), { state: null });
            return;
          }
        } else {
          navigate(routePath.workspaces(), { state: null });
        }
        return;
      }

      navigate(routePath.gistView(commitResult.gistId, commitResult.filename), { state: null });
    },
    [currentRepoDocPath, currentRouteRepoRef, navigate, repoAccessMode, selectedRepoRef],
  );

  const commitAndStayInEdit = useCallback(
    async (options?: { content?: string; title?: string }) => {
      const commitResult = await commitDocumentContent(options);
      if (!commitResult) return false;
      stayOnEditRouteAfterCommit(commitResult);
      return true;
    },
    [commitDocumentContent, stayOnEditRouteAfterCommit],
  );

  const commitAndExitEdit = useCallback(async () => {
    const commitResult = await commitDocumentContent();
    if (!commitResult) return false;
    exitEditRouteAfterCommit(commitResult);
    return true;
  }, [commitDocumentContent, exitEditRouteAfterCommit]);

  const onRestoreDraft = useCallback(async () => {
    if (
      !currentDocumentDraftKey ||
      !hasRestorableDocumentDraft ||
      !currentDocumentDraft ||
      currentDocumentContent === null
    )
      return;
    const action = await showDiffChoice(
      `Restore previous unsaved changes for "${currentDocumentLabel}"?`,
      [
        {
          path: currentFileName ?? currentRepoDocPath ?? currentDocumentLabel,
          diff: generateUnifiedDiff(
            currentFileName ?? currentRepoDocPath ?? 'document.md',
            currentDocumentContent,
            currentDocumentDraft.content,
          ),
        },
      ],
      {
        title: 'Restore previous changes',
        secondaryActionLabel: 'Restore without commit',
        primaryActionLabel: 'Restore and commit',
        primaryActionInSecondaryMenu: true,
        cancelLabel: 'Cancel',
        tertiaryActionLabel: 'Discard changes',
        tertiaryActionIntent: 'danger',
        secondaryActionIntent: 'default',
        primaryActionIntent: 'success',
        defaultFocus: 'cancel',
        leftLabel: 'Current document',
        rightLabel: 'Previous unsaved changes',
      },
    );
    if (action === 'cancel') return;
    const restoredContent = currentDocumentDraft.content;
    removeDocumentDraft(currentDocumentDraftKey);
    setCurrentDocumentDraft(null);
    if (action === 'tertiary') {
      return;
    }
    if (activeView === 'edit') {
      applyDraftContentToEditor(restoredContent);
      if (action === 'primary') {
        await commitAndStayInEdit({ content: restoredContent });
      }
      return;
    }
    const restoreRepoRef =
      repoAccessMode === 'installed' ? selectedRepoRef : repoAccessMode === 'shared' ? currentRouteRepoRef : null;
    if ((repoAccessMode === 'installed' || repoAccessMode === 'shared') && currentRepoDocPath && restoreRepoRef) {
      navigate(routePath.repoEdit(restoreRepoRef.owner, restoreRepoRef.repo, currentRepoDocPath), {
        state: {
          restoreDraft: {
            documentDraftKey: currentDocumentDraftKey,
            content: restoredContent,
            saveAfterRestore: action === 'primary',
          },
        },
      });
      return;
    }
    if (currentGistId && currentFileName) {
      navigate(routePath.gistEdit(currentGistId, currentFileName), {
        state: {
          restoreDraft: {
            documentDraftKey: currentDocumentDraftKey,
            content: restoredContent,
            saveAfterRestore: action === 'primary',
          },
        },
      });
    }
  }, [
    activeView,
    applyDraftContentToEditor,
    currentDocumentDraft,
    currentDocumentDraftKey,
    currentDocumentContent,
    currentDocumentLabel,
    currentFileName,
    currentGistId,
    currentRepoDocPath,
    currentRouteRepoRef,
    hasRestorableDocumentDraft,
    navigate,
    repoAccessMode,
    commitAndStayInEdit,
    selectedRepoRef,
    showDiffChoice,
    setCurrentDocumentDraft,
  ]);

  const onSave = useCallback(async () => {
    await commitAndStayInEdit();
  }, [commitAndStayInEdit]);

  const onSaveAndExit = useCallback(async () => {
    await commitAndExitEdit();
  }, [commitAndExitEdit]);

  useEffect(() => {
    if (activeView !== 'edit' || !currentDocumentDraftKey || currentDocumentSavedContent === null) return;
    const pendingRestore = parsePendingDraftRestore(routeState);
    if (!pendingRestore || pendingRestore.documentDraftKey !== currentDocumentDraftKey) return;
    if (editContentRef.current !== pendingRestore.content) {
      setNextEditContent(pendingRestore.content, { origin: 'appEdits' });
    }
    setHasUserTypedUnsavedChanges(false);
    setHasUnsavedChanges(pendingRestore.content !== currentDocumentSavedContent);
    const currentPath = window.location.pathname.replace(/^\/+/, '') || routePath.home();
    navigate(currentPath, { replace: true, state: null });
    if (pendingRestore.saveAfterRestore) {
      void commitAndStayInEdit({ content: pendingRestore.content });
    }
  }, [
    activeView,
    currentDocumentDraftKey,
    currentDocumentSavedContent,
    commitAndStayInEdit,
    navigate,
    routeState,
    setNextEditContent,
    setHasUnsavedChanges,
    setHasUserTypedUnsavedChanges,
  ]);

  const getActiveDocumentStore = useCallback(() => {
    if (currentGistId) {
      return createGistDocumentStore(currentGistId);
    }

    if (repoAccessMode === 'installed' && selectedRepo) {
      const instId = activeInstalledRepoInstallationId ?? getInstallationId();
      const repoName = selectedRepo ?? getSelectedRepo()?.full_name;
      if (!instId || !repoName) return null;
      return createRepoDocumentStore(instId, repoName);
    }

    return null;
  }, [activeInstalledRepoInstallationId, currentGistId, repoAccessMode, selectedRepo]);

  const onClearCaches = useCallback(async () => {
    const confirmed = await showConfirm(
      'Clear cached data and API requests? This may cause additional reload requests.',
      { confirmLabel: 'Clear cache', intent: 'danger', defaultFocus: 'cancel' },
    );
    if (!confirmed) return;
    clearAuthDataCaches();
    showSuccessToast('Caches cleared');
  }, [clearAuthDataCaches, showConfirm, showSuccessToast]);

  // --- Sidebar actions ---
  const navigateToSidebarFile = useCallback(
    (filePath: string) => {
      discardCurrentDocumentChanges();
      const shouldEditFile = activeView === 'edit' && isEditableTextFilePath(filePath);
      if (currentGistId) {
        navigate(
          shouldEditFile ? routePath.gistEdit(currentGistId, filePath) : routePath.gistView(currentGistId, filePath),
        );
      } else if (repoAccessMode === 'installed' && selectedRepoRef) {
        navigate(
          shouldEditFile
            ? routePath.repoEdit(selectedRepoRef.owner, selectedRepoRef.repo, filePath)
            : routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, filePath),
        );
      } else if (repoAccessMode === 'shared' && currentRouteRepoRef) {
        navigate(
          shouldEditFile
            ? routePath.repoEdit(currentRouteRepoRef.owner, currentRouteRepoRef.repo, filePath)
            : routePath.repoFile(currentRouteRepoRef.owner, currentRouteRepoRef.repo, filePath),
        );
      } else if (repoAccessMode === 'public' && publicRepoRef) {
        navigate(routePath.publicRepoFile(publicRepoRef.owner, publicRepoRef.repo, filePath));
      }
    },
    [
      activeView,
      currentGistId,
      discardCurrentDocumentChanges,
      repoAccessMode,
      selectedRepoRef,
      currentRouteRepoRef,
      publicRepoRef,
      navigate,
    ],
  );

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (activeView === 'edit' && readerAiEditLocked) {
        showFailureToast('Reader AI is working. Wait for it to finish before switching files.');
        return;
      }
      if (activeView === 'edit' && pendingImageUploads.size > 0) {
        showFailureToast('Wait for image uploads to finish before switching files.');
        return;
      }
      if (activeView === 'edit' && hasEffectiveUnsavedChanges) {
        const action = await showConfirm('You have unsaved changes. Discard and switch files?');
        if (action) navigateToSidebarFile(filePath);
        return;
      }
      navigateToSidebarFile(filePath);
    },
    [
      activeView,
      readerAiEditLocked,
      pendingImageUploads,
      hasEffectiveUnsavedChanges,
      navigateToSidebarFile,
      showConfirm,
      showFailureToast,
    ],
  );

  const handleClearSelectedFile = useCallback(async () => {
    if (!currentRepoDocPath && !currentFileName) return;
    if (activeView === 'edit' && readerAiEditLocked) {
      showFailureToast('Reader AI is working. Wait for it to finish before clearing the current file.');
      return;
    }
    if (activeView === 'edit' && pendingImageUploads.size > 0) {
      showFailureToast('Wait for image uploads to finish before clearing the current file.');
      return;
    }
    if (activeView === 'edit' && hasEffectiveUnsavedChanges) {
      const discard = await showConfirm('You have unsaved changes. Discard them and stop editing this file?');
      if (!discard) return;
    }
    if (editingBackend === 'gist' && currentGistId && currentFileName === null) {
      clearPersistedNewGistFileDraft(currentGistId);
    }
    setHasUnsavedChanges(false);
    setCurrentRepoDocPath(null);
    setCurrentRepoDocSha(null);
    setCurrentFileName(null);
    setEditingBackend(null);
    setEditTitle('');
    setNextEditContent('', { origin: 'appEdits' });
    clearRenderedContent();
    setViewPhase(null);
  }, [
    activeView,
    clearRenderedContent,
    currentFileName,
    currentRepoDocPath,
    hasEffectiveUnsavedChanges,
    readerAiEditLocked,
    pendingImageUploads,
    showConfirm,
    editingBackend,
    currentGistId,
    setNextEditContent,
    showFailureToast,
    setHasUnsavedChanges,
  ]);

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
          const createdFile: RepoDocFile = {
            name: fileNameFromPath(result.content.path),
            path: result.content.path,
            sha: result.content.sha,
            size: 0,
          };
          setRepoSidebarFiles((prev) => upsertRepoFile(prev, createdFile));
          if (isMarkdownFileName(createdFile.path)) {
            setRepoFiles((prev) => upsertRepoFile(prev, createdFile));
          }
          setHasUnsavedChanges(false);
          if (selectedRepoRef) {
            if (isEditableTextFilePath(result.content.path)) {
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
    [
      getActiveDocumentStore,
      currentGistId,
      navigate,
      showAlert,
      showRateLimitToastIfNeeded,
      selectedRepoRef,
      setHasUnsavedChanges,
    ],
  );

  const handleConfirmImplicitMarkdownExtension = useCallback(
    async (fileName: string) =>
      showConfirm(`Create "${fileName}.md" instead of "${fileName}"?`, {
        confirmLabel: 'Add .md',
        cancelLabel: 'Cancel',
      }),
    [showConfirm],
  );

  const handleCreateScratchFile = useCallback(
    async (parentPath: string) => {
      const normalizedParentPath = parentPath.replace(/^\/+|\/+$/g, '');
      const returnToPath = window.location.pathname.replace(/^\/+/, '') || routePath.home();
      if (
        activeView === 'edit' &&
        ((editingBackend === 'repo' &&
          currentRepoDocPath === null &&
          route.name === 'reponew' &&
          selectedRepoRef !== null &&
          selectedRepoRef.owner === safeDecodeURIComponent(route.params.owner) &&
          selectedRepoRef.repo === safeDecodeURIComponent(route.params.repo)) ||
          (editingBackend === 'gist' && currentFileName === null && currentGistId !== null && route.name === 'edit'))
      ) {
        focusEditorSoon();
        return;
      }
      if (activeView === 'edit' && readerAiEditLocked) {
        showFailureToast('Reader AI is working. Wait for it to finish before creating a file.');
        return;
      }
      if (activeView === 'edit' && pendingImageUploads.size > 0) {
        showFailureToast('Wait for image uploads to finish before creating a file.');
        return;
      }

      if (activeView === 'edit' && hasEffectiveUnsavedChanges) {
        const saveFirst = await showConfirm('You have unsaved changes. Save before creating another file?');
        if (saveFirst) {
          const saved = await commitAndStayInEdit();
          if (!saved) return;
        } else {
          const discard = await showConfirm('Discard unsaved changes and continue creating another file?');
          if (!discard) return;
          discardCurrentDocumentChanges();
        }
      }

      if (currentGistId) {
        writePersistedNewGistFileDraft(currentGistId, {
          title: UNSAVED_FILE_LABEL,
          content: '',
          filename: DEFAULT_SCRATCH_FILENAME,
          parentPath: normalizedParentPath,
        });
        navigate(routePath.gistEdit(currentGistId), {
          state: {
            newGistFile: {
              title: UNSAVED_FILE_LABEL,
              filename: DEFAULT_SCRATCH_FILENAME,
              parentPath: normalizedParentPath,
            },
            returnToPath,
          },
        });
        return;
      }

      if (!selectedRepoRef) {
        navigate(routePath.workspaces());
        return;
      }

      const draftPath = normalizedParentPath ? `${normalizedParentPath}/${DEFAULT_NEW_FILENAME}` : DEFAULT_NEW_FILENAME;
      navigate(routePath.repoNew(selectedRepoRef.owner, selectedRepoRef.repo, draftPath), {
        state: {
          returnToPath,
        },
      });
    },
    [
      activeView,
      editingBackend,
      currentRepoDocPath,
      route,
      readerAiEditLocked,
      pendingImageUploads,
      hasEffectiveUnsavedChanges,
      currentFileName,
      currentGistId,
      selectedRepoRef,
      navigate,
      showConfirm,
      showFailureToast,
      commitAndStayInEdit,
      discardCurrentDocumentChanges,
      focusEditorSoon,
    ],
  );

  const handleCreateDirectory = useCallback(
    async (directoryPath: string) => {
      try {
        const store = getActiveDocumentStore();
        if (!store) return;

        const seedFilePath = `${directoryPath}/.keep`;
        if (store.kind === 'gist') {
          const gist = await store.createFile(seedFilePath);
          setGistFiles(gist.files);
          setHasUnsavedChanges(false);
        } else {
          if (!activeInstalledRepoInstallationId || !selectedRepo) return;
          await createRepoFilesAtomic(
            activeInstalledRepoInstallationId,
            selectedRepo,
            [{ path: seedFilePath, content: '' }],
            `Create folder "${directoryPath}"`,
          );
          const createdSeedFile: RepoDocFile = {
            name: fileNameFromPath(seedFilePath),
            path: seedFilePath,
            sha: '',
            size: 0,
          };
          setRepoSidebarFiles((prev) => upsertRepoFile(prev, createdSeedFile));
          setHasUnsavedChanges(false);
        }
        setSidebarFileFilter('all');
        navigateToSidebarFile(seedFilePath);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to create directory');
      }
    },
    [
      getActiveDocumentStore,
      showAlert,
      showRateLimitToastIfNeeded,
      activeInstalledRepoInstallationId,
      selectedRepo,
      navigateToSidebarFile,
      setHasUnsavedChanges,
    ],
  );

  const handleUploadFileToSidebar = useCallback(
    async (file: File, targetFolderPath: string) => {
      if (repoAccessMode !== 'installed' || !activeInstalledRepoInstallationId || !selectedRepo) {
        showFailureToast('File upload is only available in installed repositories.');
        return;
      }

      const fileName = sanitizeDroppedFileName(file.name);
      if (!fileName) {
        showFailureToast('Invalid file name.');
        return;
      }

      if (file.size > SIDEBAR_UPLOAD_MAX_BYTES) {
        showFailureToast(`"${fileName}" is larger than 5 MB.`);
        return;
      }

      const folder = targetFolderPath.trim().replace(/^\/+|\/+$/g, '');
      const path = folder ? `${folder}/${fileName}` : fileName;

      const confirmed = await showConfirm(`Upload "${fileName}" (${formatBytes(file.size)}) to "${path}"?`, {
        title: 'Upload file',
        confirmLabel: 'Upload',
        defaultFocus: 'cancel',
      });
      if (!confirmed) return;

      const uploadToastId = showLoadingToast('Uploading file...');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const contentB64 = encodeBytesToBase64(bytes);
        const result = await putRepoFile(
          activeInstalledRepoInstallationId,
          selectedRepo,
          path,
          `Upload ${fileName}`,
          contentB64,
        );
        const createdFile: RepoDocFile = {
          name: fileNameFromPath(result.content.path),
          path: result.content.path,
          sha: result.content.sha,
          size: file.size,
        };
        setRepoSidebarFiles((prev) => upsertRepoFile(prev, createdFile));
        if (isMarkdownFileName(createdFile.path)) {
          setRepoFiles((prev) => upsertRepoFile(prev, createdFile));
        }
        showSuccessToast('File uploaded');
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        dismissToast(uploadToastId);
      }
    },
    [
      repoAccessMode,
      activeInstalledRepoInstallationId,
      selectedRepo,
      showConfirm,
      showLoadingToast,
      dismissToast,
      showFailureToast,
      showSuccessToast,
      showAlert,
      showRateLimitToastIfNeeded,
    ],
  );

  const handleEditFile = useCallback(
    async (filePath: string) => {
      if (activeView === 'edit' && readerAiEditLocked) {
        showFailureToast('Reader AI is working. Wait for it to finish before switching files.');
        return;
      }
      if (!isEditableTextFilePath(filePath)) return;
      if (activeView === 'edit' && currentFileName === filePath) return;

      const target = currentGistId
        ? routePath.gistEdit(currentGistId, filePath)
        : repoAccessMode === 'installed' && selectedRepoRef
          ? routePath.repoEdit(selectedRepoRef.owner, selectedRepoRef.repo, filePath)
          : repoAccessMode === 'shared' && currentRouteRepoRef
            ? routePath.repoEdit(currentRouteRepoRef.owner, currentRouteRepoRef.repo, filePath)
            : null;
      if (!target) return;

      if (activeView === 'edit' && hasEffectiveUnsavedChanges) {
        const saveFirst = await showConfirm('You have unsaved changes. Save before editing another file?');
        if (saveFirst) {
          await onSave();
        } else {
          const discard = await showConfirm('Discard unsaved changes and continue editing another file?');
          if (!discard) return;
          discardCurrentDocumentChanges();
        }
      }

      navigate(target);
    },
    [
      currentGistId,
      repoAccessMode,
      selectedRepoRef,
      currentRouteRepoRef,
      activeView,
      readerAiEditLocked,
      currentFileName,
      hasEffectiveUnsavedChanges,
      onSave,
      navigate,
      discardCurrentDocumentChanges,
      showConfirm,
      showFailureToast,
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
          : repoAccessMode === 'shared' && currentRouteRepoRef
            ? `${currentRouteRepoRef.owner}/${currentRouteRepoRef.repo}`
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
    [currentGistId, repoAccessMode, selectedRepo, currentRouteRepoRef, publicRepoRef],
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
          : repoAccessMode === 'shared' && currentRouteRepoRef
            ? `${currentRouteRepoRef.owner}/${currentRouteRepoRef.repo}`
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
    [currentGistId, repoAccessMode, selectedRepo, currentRouteRepoRef, publicRepoRef],
  );

  const onHeaderViewInGitHub = useCallback(() => {
    if (route.name === 'new' && !user) {
      window.open(`https://github.com/${INPUT_GITHUB_REPO_FULL_NAME}`, '_blank', 'noopener,noreferrer');
      return;
    }
    if (currentGistId) {
      handleViewOnGitHub(currentFileName ?? '');
      return;
    }
    if (!currentRepoDocPath) return;
    handleViewOnGitHub(currentRepoDocPath);
  }, [route.name, user, currentGistId, currentFileName, currentRepoDocPath, handleViewOnGitHub]);

  const onHeaderViewSource = useCallback(() => {
    if (route.name === 'new' && !user) {
      navigate(routePath.publicRepoFile('inputmd', 'input', INPUT_GITHUB_SOURCE_PATH));
      return;
    }
    onToggleContentSourceView();
  }, [route.name, user, navigate, onToggleContentSourceView]);

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
            navigate(routePath.gistView(currentGistId));
          }
        } else {
          const repoFile = findRepoDocFile(repoSidebarFiles, filePath);
          if (!repoFile) return;
          await store.deleteFile(repoFile);
          await refreshRepoTreeAfterWrite();
          const deletedCurrent = currentRepoDocPath === repoFile.path;
          if (deletedCurrent) {
            if (selectedRepoRef) {
              await openInstalledRepo(buildRepoFullName(selectedRepoRef.owner, selectedRepoRef.repo));
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
        void showAlert(err instanceof Error ? err.message : 'Failed to delete file');
      }
    },
    [
      getActiveDocumentStore,
      currentFileName,
      repoSidebarFiles,
      currentRepoDocPath,
      navigate,
      handleSessionExpired,
      showConfirm,
      showAlert,
      showRateLimitToastIfNeeded,
      currentGistId,
      selectedRepoRef,
      openInstalledRepo,
      refreshRepoTreeAfterWrite,
    ],
  );

  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      const gistTargets = Object.keys(gistFiles ?? {}).filter((path) => isPathInFolder(path, folderPath));
      const repoTargets = repoSidebarFiles.filter((file) => isPathInFolder(file.path, folderPath));
      const targetPaths = currentGistId ? gistTargets : repoTargets.map((file) => file.path);
      const deleteCount = targetPaths.length;
      if (deleteCount === 0) return;
      if (
        !(await showConfirm(folderDeleteConfirmMessage(folderPath, targetPaths), {
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
              navigate(routePath.gistView(gistId));
            }
          }
        } else {
          if (!activeInstalledRepoInstallationId || !selectedRepo) return;
          await deleteRepoPathsAtomic(
            activeInstalledRepoInstallationId,
            selectedRepo,
            repoTargets.map((file) => file.path),
            `Delete folder "${folderPath}"`,
          );
          completedCount = repoTargets.length;
          const remainingSidebar = (await refreshRepoTreeAfterWrite()) ?? [];
          const deletedCurrent = currentRepoDocPath
            ? !remainingSidebar.some((file) => file.path === currentRepoDocPath)
            : false;
          if (deletedCurrent) {
            if (selectedRepoRef) {
              await openInstalledRepo(buildRepoFullName(selectedRepoRef.owner, selectedRepoRef.repo), {
                allFiles: remainingSidebar,
              });
            } else {
              navigate(routePath.workspaces());
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
      currentRepoDocPath,
      handleSessionExpired,
      showAlert,
      showLoadingToast,
      showRateLimitToastIfNeeded,
      showSuccessToast,
      dismissToast,
      activeInstalledRepoInstallationId,
      selectedRepo,
      selectedRepoRef,
      openInstalledRepo,
      refreshRepoTreeAfterWrite,
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
          if (currentFileNameRef.current === oldPath) {
            setCurrentFileName(newPath);
            navigate(routePath.gistView(currentGistId, newPath));
          }
        } else {
          if (!activeInstalledRepoInstallationId || !selectedRepo) return;
          const renames = [{ from: oldPath, to: newPath }];
          await renameRepoPathsAtomic(
            activeInstalledRepoInstallationId,
            selectedRepo,
            renames,
            `Rename ${oldPath} to ${newPath}`,
          );
          const nextSidebarFiles = renameRepoDocFiles(repoSidebarFiles, renames);
          setRepoSidebarFiles(nextSidebarFiles);
          setRepoFiles(nextSidebarFiles.filter((file) => isMarkdownFileName(file.path)));
          if (currentFileNameRef.current === oldPath) {
            if (selectedRepoRef) {
              navigate(routePath.repoFile(selectedRepoRef.owner, selectedRepoRef.repo, newPath));
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
        if (isRepoWriteConflictError(err)) {
          void showAlert(
            `${err instanceof Error ? err.message : 'Rename conflict.'} The destination may already exist, or the repository changed while renaming. Refresh and retry.`,
          );
          return;
        }
        void showAlert(err instanceof Error ? err.message : 'Failed to rename file');
      }
    },
    [
      getActiveDocumentStore,
      currentGistId,
      navigate,
      handleSessionExpired,
      showAlert,
      showRateLimitToastIfNeeded,
      selectedRepoRef,
      activeInstalledRepoInstallationId,
      selectedRepo,
      repoSidebarFiles,
    ],
  );

  const handleBeforeRenameFile = useCallback(
    async (path: string): Promise<boolean> => {
      if (!isMarkdownFileName(path)) return true;
      if (activeView !== 'edit' || !hasEffectiveUnsavedChanges) return true;

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
    [activeView, hasEffectiveUnsavedChanges, editingBackend, currentRepoDocPath, currentFileName, showConfirm, onSave],
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
              const nextCurrentPath = renamePathWithNewFolder(currentFileName, oldPath, newPath);
              setCurrentFileName(nextCurrentPath);
              navigate(routePath.gistView(gistId, nextCurrentPath));
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
          if (!activeInstalledRepoInstallationId || !selectedRepo) return;
          const paths = repoSidebarFiles.filter((file) => isPathInFolder(file.path, oldPath));
          if (paths.length === 0) {
            dismissToast(renameToastId);
            return;
          }
          const renames = paths.map((file) => ({
            from: file.path,
            to: renamePathWithNewFolder(file.path, oldPath, newPath),
          }));
          await renameRepoPathsAtomic(
            activeInstalledRepoInstallationId,
            selectedRepo,
            renames,
            `Rename folder "${oldPath}" to "${newPath}"`,
          );
          completedCount = paths.length;
          const nextSidebarFiles = renameRepoDocFiles(repoSidebarFiles, renames);
          setRepoSidebarFiles(nextSidebarFiles);
          setRepoFiles(nextSidebarFiles.filter((file) => isMarkdownFileName(file.path)));
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
      activeInstalledRepoInstallationId,
      selectedRepo,
      selectedRepoRef,
    ],
  );

  const handleMoveFile = useCallback(
    async (filePath: string, targetFolderPath: string) => {
      const currentFolderPath = dirName(filePath);
      if (currentFolderPath === targetFolderPath) return;
      const nextPath = targetFolderPath
        ? `${targetFolderPath}/${fileNameFromPath(filePath)}`
        : fileNameFromPath(filePath);
      if (nextPath === filePath) return;

      if (activeScratchFile?.backend === 'repo' && filePath === activeScratchFile.filePath && selectedRepoRef) {
        const confirmed = await showConfirm(`Move this file to "${nextPath}"?`, {
          title: 'Move file',
          confirmLabel: 'Move',
          defaultFocus: 'action',
        });
        if (!confirmed) return;

        const currentDraftPath = activeScratchFile.draftPath;
        const nextDraftPath = buildRepoNewDraftPath(targetFolderPath);
        const instId = activeInstalledRepoInstallationId ?? getInstallationId();
        const repoName = selectedRepo ?? buildRepoFullName(selectedRepoRef.owner, selectedRepoRef.repo);
        if (instId && repoName && currentDraftPath) {
          try {
            localStorage.setItem(repoNewDraftKey(instId, repoName, nextDraftPath, 'title'), editTitle);
            localStorage.setItem(repoNewDraftKey(instId, repoName, nextDraftPath, 'content'), editContentRef.current);
            if (currentDraftPath !== nextDraftPath) {
              localStorage.removeItem(repoNewDraftKey(instId, repoName, currentDraftPath, 'title'));
              localStorage.removeItem(repoNewDraftKey(instId, repoName, currentDraftPath, 'content'));
            }
          } catch {
            // Best effort only; the in-memory draft remains active.
          }
        }
        navigate(routePath.repoNew(selectedRepoRef.owner, selectedRepoRef.repo, nextDraftPath), {
          replace: true,
          state: routeState,
        });
        return;
      }

      if (activeScratchFile?.backend === 'gist' && filePath === activeScratchFile.filePath) {
        const confirmed = await showConfirm(`Move this file to "${nextPath}"?`, {
          title: 'Move file',
          confirmLabel: 'Move',
          defaultFocus: 'action',
        });
        if (!confirmed) return;

        const nextDraft = {
          ...(activeScratchFile.draft ?? {
            title: UNSAVED_FILE_LABEL,
            content: '',
            filename: activeScratchFile.filename,
            parentPath: activeScratchFile.parentPath,
          }),
          title: editTitle || activeScratchFile.draft?.title || UNSAVED_FILE_LABEL,
          content: editContentRef.current,
          parentPath: targetFolderPath,
        };
        writePersistedNewGistFileDraft(activeScratchFile.gistId, nextDraft);
        navigate(routePath.gistEdit(activeScratchFile.gistId), {
          replace: true,
          state: mergeScratchRouteState(routeState, {
            title: nextDraft.title,
            filename: nextDraft.filename,
            parentPath: nextDraft.parentPath,
          }),
        });
        return;
      }

      const canRename = await handleBeforeRenameFile(filePath);
      if (!canRename) return;

      const confirmed = await showConfirm(`Move this file to "${nextPath}"?`, {
        title: 'Move file',
        confirmLabel: 'Move',
        defaultFocus: 'action',
      });
      if (!confirmed) return;

      await handleRenameFile(filePath, nextPath);
    },
    [
      activeInstalledRepoInstallationId,
      activeScratchFile,
      editTitle,
      handleBeforeRenameFile,
      handleRenameFile,
      navigate,
      routeState,
      selectedRepo,
      selectedRepoRef,
      showConfirm,
    ],
  );

  const handleMoveFolder = useCallback(
    async (folderPath: string, targetFolderPath: string) => {
      const currentFolderPath = parentFolderPath(folderPath);
      if (currentFolderPath === targetFolderPath) return;
      if (targetFolderPath === folderPath || targetFolderPath.startsWith(`${folderPath}/`)) return;

      const nextPath = targetFolderPath
        ? `${targetFolderPath}/${fileNameFromPath(folderPath)}`
        : fileNameFromPath(folderPath);
      if (nextPath === folderPath) return;

      const currentEditingPath = editingBackend === 'repo' ? currentRepoDocPath : currentFileName;
      if (currentEditingPath && isPathInFolder(currentEditingPath, folderPath)) {
        const canRename = await handleBeforeRenameFile(currentEditingPath);
        if (!canRename) return;
      }

      const confirmed = await showConfirm(`Move folder "${folderPath}" to "${nextPath}"?`, {
        title: 'Move folder',
        confirmLabel: 'Move',
        defaultFocus: 'cancel',
      });
      if (!confirmed) return;

      await handleRenameFolder(folderPath, nextPath);
    },
    [currentFileName, currentRepoDocPath, editingBackend, handleBeforeRenameFile, handleRenameFolder, showConfirm],
  );

  // --- GitHub App callbacks ---
  const onOpenRepoFromWorkspaces = useCallback(
    async (fullName: string, id: number, isPrivate: boolean) => {
      await openInstalledRepo(fullName, { id, isPrivate });
    },
    [openInstalledRepo],
  );

  const fetchInstallationReposForId = useCallback(async (targetInstallationId: string): Promise<InstallationRepo[]> => {
    const repos = await listInstallationRepos(targetInstallationId);
    setInstallationReposById((prev) => ({ ...prev, [targetInstallationId]: repos.repositories }));
    setReposLoadErrorsById((prev) => {
      if (!(targetInstallationId in prev)) return prev;
      const next = { ...prev };
      delete next[targetInstallationId];
      return next;
    });
    return repos.repositories;
  }, []);

  const loadInstallationReposForId = useCallback(
    async (
      targetInstallationId: string,
      options?: {
        force?: boolean;
        notifyOnError?: boolean;
      },
    ): Promise<InstallationRepo[]> => {
      if (!options?.force) {
        const cachedRepos = installationReposById[targetInstallationId];
        if (cachedRepos && !reposLoadErrorsById[targetInstallationId]) return cachedRepos;
      }

      setLoadingInstallationRepoIds((current) => {
        const next = new Set(current);
        next.add(targetInstallationId);
        return next;
      });
      try {
        return await fetchInstallationReposForId(targetInstallationId);
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        if (options?.notifyOnError !== false) {
          showRateLimitToastIfNeeded(err);
        }
        setInstallationReposById((prev) => ({ ...prev, [targetInstallationId]: [] }));
        setReposLoadErrorsById((prev) => ({
          ...prev,
          [targetInstallationId]: err instanceof Error ? err.message : 'Failed to load repos',
        }));
        return [];
      } finally {
        setLoadingInstallationRepoIds((current) => {
          if (!current.has(targetInstallationId)) return current;
          const next = new Set(current);
          next.delete(targetInstallationId);
          return next;
        });
      }
    },
    [fetchInstallationReposForId, installationReposById, reposLoadErrorsById, showRateLimitToastIfNeeded],
  );

  const syncForkRepoDialogInstallation = useCallback(
    async (targetInstallationId: string, options?: { force?: boolean }) => {
      try {
        const repos = await loadInstallationReposForId(targetInstallationId, {
          force: options?.force,
          notifyOnError: false,
        });
        setForkRepoDialog((current) => {
          if (!current || current.selectedInstallationId !== targetInstallationId) return current;
          return {
            ...current,
            selectedRepoFullName: resolveForkTargetRepoFullName(repos, {
              preferredRepoFullName:
                selectedRepoInstallationId === targetInstallationId ? selectedRepo : current.selectedRepoFullName,
            }),
          };
        });
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
        }
      }
    },
    [handleSessionExpired, loadInstallationReposForId, selectedRepo, selectedRepoInstallationId],
  );

  const onOpenForkRepoDialog = useCallback(async () => {
    if (!user || activeView !== 'content' || !currentRepoDocPath || currentDocumentContent === null) return;
    if (!isMarkdownFileName(currentRepoDocPath)) return;
    if (linkedInstallations.length === 0) {
      await showAlert('Connect a GitHub installation before forking this file into a repo.');
      return;
    }

    const targetInstallationId = resolveForkTargetInstallationId(
      linkedInstallations,
      activeInstalledRepoInstallationId ?? installationId,
    );
    if (!targetInstallationId) {
      await showAlert('Connect a GitHub installation before forking this file into a repo.');
      return;
    }

    setForkRepoDialog({
      installations: linkedInstallations,
      selectedInstallationId: targetInstallationId,
      selectedRepoFullName: '',
      sourcePath: currentRepoDocPath,
      sourceContent: currentDocumentContent,
    });
    await syncForkRepoDialogInstallation(targetInstallationId);
  }, [
    activeInstalledRepoInstallationId,
    activeView,
    currentDocumentContent,
    currentRepoDocPath,
    installationId,
    linkedInstallations,
    showAlert,
    syncForkRepoDialogInstallation,
    user,
  ]);

  const onSelectForkRepoInstallation = useCallback(
    (nextInstallationId: string) => {
      setForkRepoDialog((current) =>
        current
          ? {
              ...current,
              selectedInstallationId: nextInstallationId,
              selectedRepoFullName: '',
            }
          : current,
      );
      void syncForkRepoDialogInstallation(nextInstallationId);
    },
    [syncForkRepoDialogInstallation],
  );

  const onConfirmForkRepo = useCallback(async () => {
    if (!forkRepoDialog) return;
    const targetRepos = installationReposById[forkRepoDialog.selectedInstallationId] ?? [];
    const targetRepo = targetRepos.find((repo) => repo.full_name === forkRepoDialog.selectedRepoFullName);
    if (!targetRepo) {
      await showAlert('Choose a target repo.');
      return;
    }

    setForkRepoSubmitting(true);
    try {
      await ensureInstalledRepoSession(forkRepoDialog.selectedInstallationId);
      const allFiles = await loadRepoAllFiles(forkRepoDialog.selectedInstallationId, targetRepo.full_name);
      const prepared = await primeInstalledRepoState(targetRepo.full_name, {
        id: targetRepo.id,
        isPrivate: targetRepo.private,
        installationId: forkRepoDialog.selectedInstallationId,
        allFiles,
      });
      if (!prepared) {
        navigate(routePath.workspaces());
        return;
      }

      const draftPath = DEFAULT_NEW_FILENAME;
      setForkRepoDialog(null);
      navigate(routePath.repoNew(prepared.repoRef.owner, prepared.repoRef.repo, draftPath), {
        state: {
          forkRepoDraft: {
            title: fileNameFromPath(forkRepoDialog.sourcePath) || UNSAVED_FILE_LABEL,
            content: forkRepoDialog.sourceContent,
          },
        },
      });
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
        return;
      }
      showRateLimitToastIfNeeded(err);
      await showAlert(err instanceof Error ? err.message : 'Failed to fork file into repo');
    } finally {
      setForkRepoSubmitting(false);
    }
  }, [
    ensureInstalledRepoSession,
    forkRepoDialog,
    handleSessionExpired,
    installationReposById,
    loadRepoAllFiles,
    navigate,
    primeInstalledRepoState,
    showAlert,
    showRateLimitToastIfNeeded,
  ]);

  const loadWorkspaceGists = useCallback(
    async (options?: { reset?: boolean }) => {
      const reset = options?.reset ?? false;
      const page = reset ? 1 : menuGistsPage;
      setMenuGistsLoading(true);
      if (reset) {
        setMenuGistsAllLoaded(false);
        setMenuGistsPage(1);
      }
      try {
        const gists = await listGists(page, 30);
        const reachedEnd = gists.length < 30;
        setMenuGists((prev) => (reset ? gists : [...prev, ...gists]));
        setMenuGistsLoaded(true);
        setMenuGistsAllLoaded(reachedEnd);
        setMenuGistsPage(reachedEnd ? page : page + 1);
        setGistsLoadError(null);
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        if (reset) {
          setMenuGists([]);
          setMenuGistsAllLoaded(false);
          setMenuGistsPage(1);
        }
        setGistsLoadError(err instanceof Error ? err.message : 'Failed to load gists');
      } finally {
        setMenuGistsLoading(false);
      }
    },
    [menuGistsPage, showRateLimitToastIfNeeded],
  );

  const loadInstallationRepos = useCallback(async () => {
    if (!installationId) return;
    try {
      await loadInstallationReposForId(installationId, { force: true });
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        handleSessionExpired();
      }
    }
  }, [handleSessionExpired, installationId, loadInstallationReposForId]);

  const onOpenRepoMenu = useCallback(
    async (_mode: 'auto' | 'manual' = 'manual') => {
      if (!user) return;
      const isAutoMode = _mode === 'auto';

      const shouldLoadRepos =
        Boolean(installationId) &&
        !installationReposLoading &&
        (loadedReposInstallationId !== installationId || Boolean(reposLoadError)) &&
        (!isAutoMode || autoLoadAttemptedReposInstallationId !== installationId);
      const shouldLoadGists = !menuGistsLoading && !menuGistsLoaded && (!isAutoMode || !autoLoadAttemptedGists);
      if (!shouldLoadRepos && !shouldLoadGists) return;

      if (shouldLoadRepos && isAutoMode && installationId) {
        setAutoLoadAttemptedReposInstallationId(installationId);
      }
      if (shouldLoadGists && isAutoMode) {
        setAutoLoadAttemptedGists(true);
      }
      const tasks: Promise<void>[] = [];
      if (shouldLoadRepos) tasks.push(loadInstallationRepos());
      if (shouldLoadGists) tasks.push(loadWorkspaceGists({ reset: true }));
      await Promise.all(tasks);
    },
    [
      autoLoadAttemptedGists,
      autoLoadAttemptedReposInstallationId,
      loadInstallationRepos,
      loadedReposInstallationId,
      loadWorkspaceGists,
      menuGistsLoaded,
      menuGistsLoading,
      user,
      installationReposLoading,
      installationId,
      reposLoadError,
    ],
  );

  useEffect(() => {
    if (!user || route.name === 'home') return;
    onOpenRepoMenu('auto');
  }, [user, route.name, onOpenRepoMenu]);

  const onRetryWorkspaceGists = useCallback(async () => {
    await loadWorkspaceGists({ reset: true });
  }, [loadWorkspaceGists]);

  const onLoadMoreWorkspaceGists = useCallback(() => {
    if (menuGistsLoading || menuGistsAllLoaded) return;
    void loadWorkspaceGists();
  }, [loadWorkspaceGists, menuGistsAllLoaded, menuGistsLoading]);

  const onDeleteWorkspaceGist = useCallback(
    async (gist: GistSummary) => {
      const title = gist.description || 'Untitled';
      const confirmed = await showConfirm(`Delete "${title}"?`, {
        intent: 'danger',
        confirmLabel: 'Delete',
      });
      if (!confirmed) return;
      try {
        await deleteGist(gist.id);
        markGistRecentlyDeleted(user?.login ?? null, gist.id);
        setMenuGists((prev) => prev.filter((candidate) => candidate.id !== gist.id));
      } catch (err) {
        if (isRateLimitError(err)) {
          showFailureToast(rateLimitToastMessage(err));
        }
        void showAlert(err instanceof Error ? err.message : 'Failed to delete');
      }
    },
    [showAlert, showConfirm, showFailureToast, user?.login],
  );

  const onRenameWorkspaceGist = useCallback(
    async (gist: GistSummary) => {
      const currentTitle = gist.description ?? '';
      const input = await showPrompt('New name:', currentTitle);
      if (input === null) return;
      const nextTitle = input.trim();
      if (nextTitle === currentTitle) return;
      try {
        const updated = await updateGistDescription(gist.id, nextTitle);
        setMenuGists((prev) =>
          prev.map((candidate) =>
            candidate.id === gist.id
              ? { ...candidate, description: updated.description, updated_at: updated.updated_at }
              : candidate,
          ),
        );
      } catch (err) {
        if (isRateLimitError(err)) {
          showFailureToast(rateLimitToastMessage(err));
        }
        void showAlert(err instanceof Error ? err.message : 'Failed to rename');
      }
    },
    [showAlert, showFailureToast, showPrompt],
  );

  const onSelectActiveInstallation = useCallback(
    async (nextInstallationId: string) => {
      if (!nextInstallationId || nextInstallationId === installationId) return;
      try {
        const nextSessionState = await selectGitHubInstallation(nextInstallationId);
        applyInstallationSessionState(nextSessionState);
        clearInstalledRepoSelection();
      } catch (err) {
        showRateLimitToastIfNeeded(err);
        void showAlert(err instanceof Error ? err.message : 'Failed to switch installation');
      }
    },
    [applyInstallationSessionState, clearInstalledRepoSelection, installationId, showAlert, showRateLimitToastIfNeeded],
  );

  const resolveInstalledRepoMatch = useCallback(
    async (
      fullName: string,
      options?: { preferredInstallationId?: string | null },
    ): Promise<{ installationId: string; repo: InstallationRepo } | null> => {
      const normalizedFullName = fullName.toLowerCase();
      const knownInstallationIds = new Set<string>();
      if (installationId) knownInstallationIds.add(installationId);
      for (const linkedInstallation of linkedInstallations) {
        if (linkedInstallation.installationId) knownInstallationIds.add(linkedInstallation.installationId);
      }

      const installationSearchOrder: string[] = [];
      const seenInstallationIds = new Set<string>();
      const pushInstallationId = (
        candidateInstallationId: string | null | undefined,
        options?: { allowUnknown?: boolean },
      ) => {
        if (!candidateInstallationId || seenInstallationIds.has(candidateInstallationId)) return;
        if (!options?.allowUnknown && !knownInstallationIds.has(candidateInstallationId)) return;
        seenInstallationIds.add(candidateInstallationId);
        installationSearchOrder.push(candidateInstallationId);
      };

      pushInstallationId(options?.preferredInstallationId);
      pushInstallationId(installationId);
      for (const linkedInstallation of linkedInstallations) pushInstallationId(linkedInstallation.installationId);

      for (const candidateInstallationId of installationSearchOrder) {
        let candidateRepos: InstallationRepo[] | undefined;
        try {
          candidateRepos =
            candidateInstallationId === installationId
              ? installationRepos
              : installationReposById[candidateInstallationId];
          if (!candidateRepos || reposLoadErrorsById[candidateInstallationId]) {
            candidateRepos = await fetchInstallationReposForId(candidateInstallationId);
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          continue;
        }

        const repoMatch = candidateRepos.find((candidate) => candidate.full_name.toLowerCase() === normalizedFullName);
        if (repoMatch) {
          return { installationId: candidateInstallationId, repo: repoMatch };
        }
      }

      return null;
    },
    [
      fetchInstallationReposForId,
      installationId,
      installationRepos,
      installationReposById,
      linkedInstallations,
      reposLoadErrorsById,
    ],
  );

  const switchInstallationAndOpenRepo = useCallback(
    async (repo: InstallationRepo, targetInstallationId: string) => {
      await ensureInstalledRepoSession(targetInstallationId);
      await openInstalledRepo(repo.full_name, {
        id: repo.id,
        isPrivate: repo.private,
        installationId: targetInstallationId,
      });
    },
    [ensureInstalledRepoSession, openInstalledRepo],
  );

  const openRepoByFullName = useCallback(
    async (
      fullName: string,
      options?: {
        preferredInstallationId?: string | null;
        preferPublic?: boolean;
      },
    ) => {
      const repoRef = parseRepoFullName(fullName);
      if (!repoRef) {
        await showAlert('Enter a valid GitHub repo in username/reponame format, for example "openai/codex".');
        return;
      }

      try {
        if (!options?.preferPublic) {
          const installedMatch = await resolveInstalledRepoMatch(fullName, {
            preferredInstallationId: options?.preferredInstallationId,
          });
          if (installedMatch) {
            await switchInstallationAndOpenRepo(installedMatch.repo, installedMatch.installationId);
            return;
          }
        }

        navigate(routePath.repoDocuments(repoRef.owner, repoRef.repo));
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          handleSessionExpired();
          return;
        }
        showRateLimitToastIfNeeded(err);
        await showAlert(err instanceof Error ? err.message : 'Failed to open repository');
      }
    },
    [
      handleSessionExpired,
      navigate,
      resolveInstalledRepoMatch,
      showAlert,
      showRateLimitToastIfNeeded,
      switchInstallationAndOpenRepo,
    ],
  );

  const onPromptOpenRepo = useCallback(async () => {
    while (true) {
      const requestedRepo = await showPrompt(
        'Enter a GitHub repo in username/reponame format.',
        currentMenuRepoFullName ?? '',
      );
      if (requestedRepo === null) return;

      const repoRef = parseGitHubRepoFullNameInput(requestedRepo);
      if (!repoRef) {
        await showAlert('Enter a valid GitHub repo in username/reponame format, for example "openai/codex".');
        continue;
      }

      await openRepoByFullName(buildRepoFullName(repoRef.owner, repoRef.repo));
      return;
    }
  }, [currentMenuRepoFullName, openRepoByFullName, showAlert, showPrompt]);

  const onOpenRecentRepo = useCallback(
    async (repo: RecentRepoVisit) => {
      await openRepoByFullName(repo.fullName, {
        preferredInstallationId: repo.source === 'installed' ? repo.installationId : null,
        preferPublic: repo.source === 'public',
      });
    },
    [openRepoByFullName],
  );

  const onDisconnect = useCallback(async () => {
    const confirmed = await showConfirm('Disconnect all repos?');
    if (!confirmed) return;

    try {
      const nextSessionState = await disconnectInstallation();
      applyInstallationSessionState(nextSessionState);
    } catch {
      /* still clear local state below */
    } finally {
      clearInstallationId();
      clearSelectedRepo();
      setInstId(null);
      setLinkedInstallations([]);
      setSelectedRepo(null);
      setSelectedRepoPrivate(null);
      setSelectedRepoInstallationId(null);
      setInstallationReposById({});
      setLoadingInstallationRepoIds(new Set());
      setReposLoadErrorsById({});
      setRepoFiles([]);
      setRepoSidebarFiles([]);
      navigate(routePath.workspaces());
    }
  }, [applyInstallationSessionState, navigate, showConfirm]);

  const onDisconnectCurrentInstallation = useCallback(async () => {
    if (!installationId) return;
    const currentInstallation = linkedInstallations.find((candidate) => candidate.installationId === installationId);
    const installationLabel = currentInstallation?.accountLogin ?? installationId;
    const confirmed = await showConfirm(`Disconnect installation "${installationLabel}"?`, {
      intent: 'danger',
      confirmLabel: 'Disconnect',
      defaultFocus: 'cancel',
    });
    if (!confirmed) return;

    try {
      const nextSessionState = await disconnectInstallation(installationId);
      applyInstallationSessionState(nextSessionState);
      clearInstalledRepoSelection();
    } catch (err) {
      showRateLimitToastIfNeeded(err);
      void showAlert(err instanceof Error ? err.message : 'Failed to disconnect installation');
    }
  }, [
    applyInstallationSessionState,
    clearInstalledRepoSelection,
    installationId,
    linkedInstallations,
    showAlert,
    showConfirm,
    showRateLimitToastIfNeeded,
  ]);

  // --- Render active view ---
  const renderView = () => {
    switch (activeView) {
      case 'workspaces': {
        const reposInitialLoaded = !installationId || loadedReposInstallationId === installationId;
        return user ? (
          <WorkspacesView
            installationId={installationId}
            availableRepos={installationRepos}
            repoListLoading={installationReposLoading}
            reposLoadError={reposLoadError}
            gists={menuGists}
            gistsLoading={menuGistsLoading || !menuGistsLoaded}
            gistsAllLoaded={menuGistsAllLoaded}
            gistsLoadError={gistsLoadError}
            onLoadRepos={(mode) => onOpenRepoMenu(mode)}
            onRetryRepos={() => onOpenRepoMenu('manual')}
            onRetryGists={onRetryWorkspaceGists}
            onRetryGistsSignIn={() => handleSignInWithGitHub()}
            onLoadMoreGists={onLoadMoreWorkspaceGists}
            onRenameGist={onRenameWorkspaceGist}
            onDeleteGist={onDeleteWorkspaceGist}
            onConnect={onConnectInstallation}
            onDisconnectCurrentInstallation={onDisconnectCurrentInstallation}
            onDisconnect={onDisconnect}
            onOpenRepo={onOpenRepoFromWorkspaces}
            reposInitialLoaded={reposInitialLoaded}
            navigate={navigate}
            userLogin={user.login}
            workspaceNotice={workspaceNotice}
            onDismissWorkspaceNotice={() => setWorkspaceNotice(null)}
          />
        ) : null;
      }
      case 'content': {
        if (contentSourceViewVisible && currentDocumentSavedContent !== null) {
          return (
            <EditView
              fileName={currentFileName}
              markdown={isMarkdownFileName(currentFileName)}
              content={currentDocumentSavedContent}
              contentOrigin="external"
              contentRevision={0}
              contentSelection={null}
              previewHtml=""
              previewVisible={false}
              canRenderPreview={false}
              scrollStorageKey={currentDocumentScrollKey}
              loading={contentLoadPending}
              onTogglePreview={() => {}}
              onContentChange={() => {}}
              saving={false}
              canSave={false}
              hasUserTypedUnsavedChanges={false}
              onSave={() => {}}
              readOnly
              locked={false}
              showLockIndicator={false}
            />
          );
        }

        const handleStackLinkNavigate = (rawRoute: string) => {
          const routePathname = rawRoute.replace(/^\/+/, '');
          if (!isMarkdownFileName(routePathname)) {
            documentStack.clearStack();
            navigate(routePathname);
            return;
          }
          const mainEl = document.querySelector<HTMLElement>('.app-body main');
          const availableWidth = mainEl?.clientWidth ?? window.innerWidth;
          if (!documentStack.canPush(availableWidth)) return;
          void fetchDocumentForStack(routePathname).then((entry) => {
            if (entry) documentStack.pushEntry(entry);
          });
        };

        return (
          <>
            <ContentView
              html={renderedHtml}
              markdown={renderMode === 'markdown' || renderMode === 'image'}
              fileSelected={currentFileName !== null}
              markdownCustomCss={renderedCustomCss}
              markdownCustomCssScope={renderedCustomCssScope}
              scrollStorageKey={currentDocumentScrollKey}
              plainText={renderMode === 'ansi' && !contentImagePreview ? renderedText : null}
              plainTextFileName={renderMode === 'ansi' ? currentFileName : null}
              loading={contentLoadPending}
              imagePreview={contentImagePreview}
              alertMessage={contentAlertMessage}
              alertDownloadHref={contentAlertDownloadHref}
              alertDownloadName={contentAlertDownloadName}
              onImageClick={onOpenLightbox}
              onRequestMarkdownLinkPreview={onRequestMarkdownLinkPreview}
              onInternalLinkNavigate={handleStackLinkNavigate}
            />
            {documentStack.hasStack ? (
              <DocumentStackView
                entries={documentStack.entries}
                baseTitle={currentFileName ?? ''}
                onPopToIndex={documentStack.popToIndex}
                onInternalLinkNavigate={handleStackLinkNavigate}
                onRequestMarkdownLinkPreview={onRequestMarkdownLinkPreview}
                onImageClick={onOpenLightbox}
              />
            ) : null}
          </>
        );
      }
      case 'edit':
        return (
          <EditSessionView
            fileName={editingFileName}
            markdown={editPreviewEnabled}
            content={editContent}
            contentOrigin={editContentOrigin}
            contentRevision={editContentRevision}
            contentSelection={editContentSelection}
            diffPreview={currentEditorDiffPreview}
            previewVisible={previewVisible}
            canRenderPreview={canRenderPreview}
            scrollStorageKey={currentDocumentScrollKey}
            loading={repoEditLoading}
            onTogglePreview={onTogglePreview}
            onContentChange={onEditContentChange}
            onInlinePromptSubmit={onInlinePromptSubmit}
            onBracePromptStream={onBracePromptStream}
            onPromptListSubmit={onPromptListSubmit}
            onCancelInlinePrompt={cancelInlinePrompt}
            inlinePromptActive={inlinePromptStreaming}
            onInternalLinkNavigate={(rawRoute) => {
              const routePathname = rawRoute.replace(/^\/+/, '');
              navigate(routePathname);
            }}
            onRequestMarkdownLinkPreview={onRequestMarkdownLinkPreview}
            onPreviewImageClick={onOpenLightbox}
            onEditorPaste={editPreviewEnabled ? handleEditorPaste : undefined}
            onEditorReady={(controller) => {
              editViewControllerRef.current = controller;
            }}
            onEligibleSelectionChange={setReaderAiHasEligibleSelection}
            resolvePreviewImageSrc={(src) =>
              resolveMarkdownImageSrc(src, editingBackend === 'repo' ? currentRepoDocPath : null)
            }
            previewWikiLinkResolver={editPreviewWikiLinkResolver}
            showLoggedOutNewDocPreviewDescription={route.name === 'new' && activeView === 'edit' && !user}
            saving={saving}
            canSave={hasUnsavedChanges && !readerAiEditLocked && !repoEditLoading && pendingImageUploads.size === 0}
            hasUserTypedUnsavedChanges={hasUserTypedUnsavedChanges}
            onSave={onSave}
            locked={readerAiEditLocked}
            showLockIndicator={inlinePromptStreaming || !showReaderAiPanel}
            lockLabel={editorLockLabel}
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

  const scratchSidebarPath = activeScratchFile?.filePath ?? null;
  const sidebarSourceFiles = useMemo(() => {
    if (gistFiles) {
      const files = Object.keys(gistFiles).map((path) => ({
        path,
        active: path === currentFileName,
        editable: isEditableTextFilePath(path),
        deemphasized: !isSidebarTextFileName(path),
        size: gistFiles[path]?.size,
      }));
      return withScratchSidebarFile(files, scratchSidebarPath);
    }
    const files = repoSidebarFiles.map((f) => ({
      path: f.path,
      active: f.path === currentRepoDocPath,
      editable: isEditableTextFilePath(f.path),
      deemphasized: !isSidebarTextFileName(f.path),
      size: f.size,
    }));
    return withScratchSidebarFile(files, scratchSidebarPath);
  }, [gistFiles, currentFileName, repoSidebarFiles, currentRepoDocPath, scratchSidebarPath]);
  const sidebarFiles = useMemo(() => {
    if (sidebarFileFilter === 'markdown') return sidebarSourceFiles.filter((file) => isMarkdownFileName(file.path));
    if (sidebarFileFilter === 'text') return sidebarSourceFiles.filter((file) => isSidebarTextListPath(file.path));
    return sidebarSourceFiles;
  }, [sidebarFileFilter, sidebarSourceFiles]);
  const sidebarFileCounts = useMemo(() => {
    const sourceFiles = sidebarSourceFiles.filter((file) => isVisibleSidebarFilePath(file.path));
    if (sourceFiles.length > 0) {
      return {
        markdown: sourceFiles.filter((file) => isMarkdownFileName(file.path)).length,
        text: sourceFiles.filter((file) => isSidebarTextFileName(file.path)).length,
        total: sourceFiles.length,
      };
    }
    return { markdown: 0, text: 0, total: 0 };
  }, [sidebarSourceFiles]);
  const sidebarWorkspaceKey = useMemo(() => {
    if (currentGistId) return `gist:${currentGistId}`;
    if (repoAccessMode === 'installed' && selectedRepo) return `repo:${selectedRepo}`;
    if (repoAccessMode === 'shared' && currentRouteRepoRef)
      return `shared:${currentRouteRepoRef.owner}/${currentRouteRepoRef.repo}`;
    if (repoAccessMode === 'public' && publicRepoRef) return `public:${publicRepoRef.owner}/${publicRepoRef.repo}`;
    if (route.name === 'sharefile') return `share:${route.params.owner}/${route.params.repo}/${route.params.path}`;
    if (route.name === 'sharetoken') return `share:${route.params.token}`;
    return 'none';
  }, [currentGistId, currentRouteRepoRef, publicRepoRef, repoAccessMode, route, selectedRepo]);
  const scrollWorkspaceKey = useMemo(() => {
    if (currentGistId) return `gist:${currentGistId}`;
    if (repoAccessMode === 'installed' && selectedRepo) return `repo:${selectedRepo.toLowerCase()}`;
    if (repoAccessMode === 'shared' && currentRouteRepoRef)
      return `shared:${currentRouteRepoRef.owner.toLowerCase()}/${currentRouteRepoRef.repo.toLowerCase()}`;
    if (repoAccessMode === 'public' && publicRepoRef)
      return `public:${publicRepoRef.owner.toLowerCase()}/${publicRepoRef.repo.toLowerCase()}`;
    if (route.name === 'sharefile')
      return `share:${route.params.owner.toLowerCase()}/${route.params.repo.toLowerCase()}`;
    return null;
  }, [currentGistId, currentRouteRepoRef, publicRepoRef, repoAccessMode, route, selectedRepo]);
  const previousScrollWorkspaceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const previousWorkspaceKey = previousScrollWorkspaceKeyRef.current;
    previousScrollWorkspaceKeyRef.current = scrollWorkspaceKey;
    if (!previousWorkspaceKey || !scrollWorkspaceKey || previousWorkspaceKey === scrollWorkspaceKey) return;
    clearStoredScrollPositions();
  }, [scrollWorkspaceKey]);

  // Keep the sidebar visible during intra-view loading. `activeView` can become "loading"
  // while fetching file contents, which would otherwise unmount the sidebar briefly.
  const sidebarEligible = routeView === 'content' || routeView === 'edit';
  const sidebarDisabled = routeView === 'edit' && draftMode;
  const isAnonymousGistWorkspace = currentGistId !== null && !user;
  const defaultShowSidebar =
    isDesktopWidth &&
    !sidebarDisabled &&
    (!!user || repoAccessMode === 'public' || currentGistId !== null || route.name === 'sharefile');
  const showSidebar = sidebarEligible && (sidebarVisibilityOverride ?? defaultShowSidebar);
  const notifyReaderAiEditLock = useCallback(() => {
    if (!readerAiEditLocked) return false;
    showFailureToast('Reader AI is working. Wait for it to finish before editing or switching files.');
    return true;
  }, [readerAiEditLocked, showFailureToast]);
  const pendingImageUploadCount = pendingImageUploads.size;
  const handleSidebarDocumentStep = useCallback(
    async (direction: -1 | 1) => {
      if (activeView === 'edit' && notifyReaderAiEditLock()) return;
      if (activeView === 'edit' && pendingImageUploadCount > 0) {
        showFailureToast('Wait for image uploads to finish before switching files.');
        return;
      }
      if (!showSidebar || sidebarFiles.length < 2) return;
      const activeIndex = sidebarFiles.findIndex((file) => file.active);
      if (activeIndex < 0) return;
      const nextIndex = activeIndex + direction;
      if (nextIndex < 0 || nextIndex >= sidebarFiles.length) return;
      const nextFile = sidebarFiles[nextIndex];
      if (!nextFile) return;

      if (activeView === 'edit' && hasEffectiveUnsavedChanges) {
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
    [
      activeView,
      hasEffectiveUnsavedChanges,
      navigateToSidebarFile,
      onSave,
      showConfirm,
      showSidebar,
      sidebarFiles,
      notifyReaderAiEditLock,
      pendingImageUploadCount,
      showFailureToast,
    ],
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
  const editingFileName = currentFileName ?? (isScratchDocument ? UNSAVED_FILE_LABEL : editTitle);
  const editPreviewEnabled = isScratchDocument || isMarkdownFileName(currentFileName ?? editTitle);
  const canRenderPreview = editPreviewEnabled && isDesktopWidth;
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
    const src = reusableImageSrc(image);
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
  const onEditContentChange = useCallback(
    (update: { content: string; origin: 'userEdits'; revision: number }) => {
      if (readerAiEditLocked) return;
      hasTypedInExternalEditSessionRef.current = true;
      editContentRef.current = update.content;
      pendingGistDraftDirtyRef.current = draftMode && editingBackend === 'gist' && currentGistId === null;
      scheduleEditContentSnapshot(update);
      setHasUserTypedUnsavedChanges(true);
      setHasUnsavedChanges(true);
      setReaderAiUndoState(null);
    },
    [
      currentGistId,
      draftMode,
      editingBackend,
      readerAiEditLocked,
      scheduleEditContentSnapshot,
      setReaderAiUndoState,
      setHasUnsavedChanges,
      setHasUserTypedUnsavedChanges,
    ],
  );
  const handleSignInWithGitHub = useCallback(
    (options?: { includeGists?: boolean }) => {
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
      startGitHubSignIn(`/${routePath.workspaces()}`, { force: true, includeGists: options?.includeGists });
    },
    [startGitHubSignIn],
  );
  const showHeaderEdit =
    activeView === 'content' &&
    isEditableTextFilePath(currentFileName) &&
    (currentGistId !== null || (currentRepoDocPath !== null && repoAccessMode === 'installed'));
  const showHeaderSourceToggle =
    activeView === 'content' &&
    repoAccessMode === 'public' &&
    currentDocumentSavedContent !== null &&
    Boolean(currentFileName) &&
    !contentLoadPending;
  const showHeaderForkRepo =
    activeView === 'content' &&
    Boolean(user && currentRepoDocPath && currentDocumentContent !== null && isMarkdownFileName(currentRepoDocPath));
  const showHomeHeaderSourceAction = route.name === 'new' && !user;
  const showHeaderSourceAction = showHeaderSourceToggle || showHomeHeaderSourceAction;
  const headerSourceActionLabel = contentSourceViewVisible ? 'View Rendered' : 'View Source';
  const showHeaderLeftLoading = activeView === 'loading' && Boolean(user);
  const showReaderAiToggle = readerAiEnabled;
  const showReaderAiPanel = showReaderAiToggle && readerAiVisible && !documentStack.hasStack;
  const readerAiToggleDisabled = viewPhase === 'loading' || documentStack.hasStack;
  const headerSidebarToggleAvailable =
    (activeView === 'content' || activeView === 'edit') &&
    !(showHeaderLeftLoading && preserveHeaderLeftControlsWhileLoading);
  const headerPreviewToggleAvailable = activeView === 'edit' && editPreviewEnabled;
  const headerReaderAiToggleAvailable = showReaderAiToggle && !readerAiToggleDisabled;
  const showGistHeaderShare = currentGistId !== null && (route.name === 'gist' || route.name === 'edit');
  const showInstalledRepoHeaderShare =
    repoAccessMode === 'installed' &&
    currentRepoDocPath !== null &&
    (route.name === 'repoedit' || (route.name === 'repofile' && Boolean(user)));
  const showHeaderShare = showInstalledRepoHeaderShare || showGistHeaderShare;
  const showHeaderViewInGitHub = showHomeHeaderSourceAction || currentGistId !== null || currentRepoDocPath !== null;
  const showHeaderActionsMenu = showHeaderShare || showHeaderSourceAction || showHeaderViewInGitHub;
  const showDraftMenuActions = currentDocumentDraft !== null && (currentGistId !== null || currentRepoDocPath !== null);
  useEffect(() => {
    const bindings = [
      { key: 't', available: headerSidebarToggleAvailable, action: onToggleSidebar },
      { key: 'i', available: headerReaderAiToggleAvailable, action: onToggleReaderAi },
      { key: 'p', available: headerPreviewToggleAvailable, action: onTogglePreview },
      { key: 'e', available: showHeaderEdit, action: onEdit },
    ] as const;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const binding = bindings.find((candidate) => candidate.available && matchesControlShortcut(event, candidate.key));
      if (!binding || isEditableShortcutTarget(event.target)) return;

      event.preventDefault();
      binding.action();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    headerPreviewToggleAvailable,
    headerReaderAiToggleAvailable,
    headerSidebarToggleAvailable,
    onTogglePreview,
    onToggleReaderAi,
    onToggleSidebar,
    onEdit,
    showHeaderEdit,
  ]);
  const shareMenuMetadata = useMemo(() => {
    if (!showHeaderShare) return null;
    const timestamp = currentGistCreatedAt ?? currentGistUpdatedAt;
    if (!timestamp) return null;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    const prefix = currentGistCreatedAt ? 'Created' : 'Updated';
    const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    return `${prefix} ${formatted}`;
  }, [currentGistCreatedAt, currentGistUpdatedAt, showHeaderShare]);
  const inRepoContext =
    (activeView === 'content' || activeView === 'edit') && repoAccessMode === 'installed' && selectedRepo !== null;
  const headerDocumentCollaborators = useMemo(() => {
    if (repoAccessMode !== 'installed') return [];
    if (!currentRepoDocPath || !currentDocumentContent || !user?.login) return [];
    if (!isMarkdownFileName(currentRepoDocPath)) return [];

    const parsed = parseDocumentEditorsFromMarkdown(currentDocumentContent);
    if (parsed.error || parsed.editors.length === 0) return [];

    const seen = new Set<string>();
    const collaborators: Array<{ login: string; avatarUrl: string; isAuthor: boolean }> = [];
    const normalizedAuthor = user.login.trim().toLowerCase();

    collaborators.push({ login: user.login, avatarUrl: user.avatar_url, isAuthor: true });
    seen.add(normalizedAuthor);

    for (const editor of parsed.editors) {
      const normalizedEditor = editor.toLowerCase();
      if (seen.has(normalizedEditor)) continue;
      seen.add(normalizedEditor);
      collaborators.push({
        login: editor,
        avatarUrl: `https://github.com/${editor}.png?size=64`,
        isAuthor: false,
      });
    }

    return collaborators;
  }, [currentDocumentContent, currentRepoDocPath, repoAccessMode, user]);
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
  const recentReposForMenu = useMemo(
    () =>
      recentRepos.filter((repo) => {
        if (currentMenuRepoFullName && repo.fullName.toLowerCase() === currentMenuRepoFullName.toLowerCase()) {
          return false;
        }
        return true;
      }),
    [currentMenuRepoFullName, recentRepos],
  );
  const hasSelectedStagedChanges = effectiveReaderAiStagedChanges.length > 0;
  const hasAllNonDeleteSelectedStagedContent = effectiveReaderAiStagedChanges.every(
    (change) => change.type === 'delete' || typeof effectiveReaderAiStagedFileContents[change.path] === 'string',
  );
  const hasCurrentEditingSelectedStagedContent = Boolean(
    currentEditingDocPath && typeof effectiveReaderAiStagedFileContents[currentEditingDocPath] === 'string',
  );
  const canApplyFromInlineDocumentEdit = !readerAiProjectId && readerAiDocumentEditedContent !== null;
  const canApplyAndCommit =
    !readerAiStagedChangesInvalid &&
    hasSelectedStagedChanges &&
    hasAllNonDeleteSelectedStagedContent &&
    ((repoAccessMode === 'installed' && Boolean(activeInstalledRepoInstallationId && selectedRepo)) ||
      (isGistContext && Boolean(currentGistId && user)));
  const canApplyWithoutSaving =
    !readerAiStagedChangesInvalid &&
    activeView === 'edit' &&
    (canApplyFromInlineDocumentEdit || hasCurrentEditingSelectedStagedContent);
  const isEditorProposalWorkflow = canApplyWithoutSaving;
  const readerAiStagedChangesDisabledHint = readerAiStagedChangesInvalid
    ? 'Staged changes are invalid. Regenerate the diff to apply changes.'
    : !canApplyAndCommit &&
        !canApplyWithoutSaving &&
        activeView === 'edit' &&
        Boolean(currentEditingDocPath) &&
        !canApplyFromInlineDocumentEdit &&
        !hasCurrentEditingSelectedStagedContent
      ? 'No staged changes for the current file. Switch files or regenerate the diff.'
      : undefined;

  return (
    <>
      <Toolbar
        view={activeView}
        user={user}
        selectedRepo={selectedRepo}
        selectedRepoPrivate={selectedRepoPrivate}
        inRepoContext={inRepoContext}
        isGistContext={isGistContext}
        documentCollaborators={headerDocumentCollaborators}
        availableRepos={installationRepos}
        installationId={installationId}
        linkedInstallations={linkedInstallations}
        repoListLoading={installationReposLoading}
        reposLoadError={reposLoadError}
        menuGists={menuGists.slice(0, 6)}
        menuGistsLoading={menuGistsLoading}
        gistsLoadError={gistsLoadError}
        draftMode={draftMode}
        sidebarVisible={showSidebar}
        showActionsMenu={showHeaderActionsMenu}
        showShare={showHeaderShare}
        showViewSource={showHeaderSourceAction}
        viewSourceLabel={headerSourceActionLabel}
        shareMetadata={shareMenuMetadata}
        showDraftBadge={hasDivergedDocumentDraft}
        showDraftActions={showDraftMenuActions}
        showRestoreDraft={hasRestorableDocumentDraft}
        showForkRepo={showHeaderForkRepo}
        onShare={() => {
          void onShareLink();
        }}
        onForkRepo={() => {
          void onOpenForkRepoDialog();
        }}
        onResetDraftChanges={() => {
          void onResetDraftChanges();
        }}
        onRestoreDraft={() => {
          void onRestoreDraft();
        }}
        onViewSource={onHeaderViewSource}
        onViewInGitHub={onHeaderViewInGitHub}
        showCompactCommits={repoAccessMode === 'installed' && currentRepoDocPath !== null && Boolean(selectedRepo)}
        onCompactCommits={openCompactCommitsDialog}
        showEdit={showHeaderEdit}
        editLabel="Edit"
        mobileEditIcon={null}
        editUrl={null}
        navigate={navigate}
        onOpenRepoMenu={onOpenRepoMenu}
        onPromptOpenRepo={() => {
          void onPromptOpenRepo();
        }}
        recentRepos={recentReposForMenu}
        onOpenRecentRepo={(repo) => {
          void onOpenRecentRepo(repo);
        }}
        onRetryRepos={() => onOpenRepoMenu('manual')}
        onRetryGists={() => onOpenRepoMenu('manual')}
        onSelectInstallation={async (nextInstallationId) => {
          await onSelectActiveInstallation(nextInstallationId);
          navigate(routePath.workspaces());
        }}
        onSelectRepo={(fullName, id, isPrivate) => {
          void openInstalledRepo(fullName, { id, isPrivate });
        }}
        onSignOut={signOut}
        onClearCache={onClearCaches}
        onToggleTheme={toggleTheme}
        onToggleSidebar={onToggleSidebar}
        onEdit={onEdit}
        showLeftLoading={showHeaderLeftLoading}
        preserveLeftControlsWhileLoading={preserveHeaderLeftControlsWhileLoading}
        localRateLimit={localRateLimit}
        serverRateLimit={serverRateLimit}
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
        aiDisabled={readerAiToggleDisabled}
        onToggleAi={onToggleReaderAi}
        aiModels={readerAiModels}
        aiModelsLoading={readerAiModelsLoading}
        aiModelsError={readerAiModelsError}
        selectedAiModel={readerAiSelectedModel}
        onSelectAiModel={setReaderAiSelectedModel}
        localCodexEnabled={localCodexEnabled}
        onEnableLocalCodex={enableLocalCodexModels}
        showAiLoginPrompt={!user}
        showCancel={showEditorCancel}
        onCancel={onCancel}
        showSave={showEditorSave}
        saving={saving}
        canSave={hasUnsavedChanges && !readerAiEditLocked && !repoEditLoading && pendingImageUploads.size === 0}
        onSave={onSave}
        onSaveAndExit={onSaveAndExit}
        saveStatusText={saveStatusText}
        saveStatusPlain={isScratchDocument}
        saveStatusTone={saveStatusTone}
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
              markdownFileCount={sidebarFileCounts.markdown}
              textFileCount={sidebarFileCounts.text}
              totalFileCount={sidebarFileCounts.total}
              fileFilter={sidebarFileFilter}
              onFileFilterChange={setSidebarFileFilter}
              onSelectFile={handleSelectFile}
              onClearSelection={() => {
                void handleClearSelectedFile();
              }}
              onEditFile={handleEditFile}
              onViewOnGitHub={handleViewOnGitHub}
              onViewFolderOnGitHub={handleViewFolderOnGitHub}
              canViewOnGitHub={
                currentGistId !== null ||
                selectedRepo !== null ||
                publicRepoRef !== null ||
                currentRouteRepoRef !== null
              }
              disabled={sidebarDisabled}
              readOnly={
                repoAccessMode === 'public' ||
                repoAccessMode === 'shared' ||
                isAnonymousGistWorkspace ||
                route.name === 'sharefile'
              }
              onCreateFile={handleCreateFile}
              onConfirmImplicitMarkdownExtension={handleConfirmImplicitMarkdownExtension}
              onCreateScratchFile={handleCreateScratchFile}
              onCreateDirectory={handleCreateDirectory}
              onDeleteFile={handleDeleteFile}
              onDeleteFolder={handleDeleteFolder}
              onBeforeRenameFile={handleBeforeRenameFile}
              onRenameFile={handleRenameFile}
              onRenameFolder={handleRenameFolder}
              onMoveFile={handleMoveFile}
              onMoveFolder={handleMoveFolder}
              onUploadFile={handleUploadFileToSidebar}
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
              models={readerAiModels}
              modelsLoading={readerAiModelsLoading}
              modelsError={readerAiModelsError}
              selectedModel={readerAiSelectedModel}
              onSelectModel={setReaderAiSelectedModel}
              localCodexEnabled={localCodexEnabled}
              onEnableLocalCodex={enableLocalCodexModels}
              showLoginForMoreModels={!user}
              messages={readerAiMessages}
              sending={readerAiSending}
              toolStatus={readerAiToolStatus}
              toolLog={readerAiToolLog}
              stagedChanges={effectiveReaderAiStagedChanges}
              stagedChangesStreaming={readerAiStagedChangesStreaming}
              suggestedCommitMessage={readerAiSuggestedCommitMessage}
              applyingChanges={readerAiApplyingChanges}
              stagedChangesDisabledHint={readerAiStagedChangesDisabledHint}
              canApplyWithoutSaving={canApplyWithoutSaving}
              canApplyAndCommit={canApplyAndCommit}
              editorProposalMode={isEditorProposalWorkflow}
              canUndoEditorApply={canUndoReaderAiApply}
              onApplyWithoutSaving={() => void onReaderAiApplyChanges('without-saving')}
              onApplyAndCommit={(msg) => void onReaderAiApplyChanges('commit', msg)}
              onIgnoreAll={onReaderAiIgnoreChanges}
              onUndoEditorApply={onReaderAiUndoApply}
              onToggleChangeSelection={(changeId, selected) =>
                setReaderAiSelectedChangeIds((prev) => {
                  const next = new Set(prev);
                  if (selected) next.add(changeId);
                  else next.delete(changeId);
                  return next;
                })
              }
              onToggleHunkSelection={(changeId, hunkId, selected) =>
                setReaderAiSelectedHunkIdsByChangeId((prev) => {
                  const next = { ...prev };
                  const current = new Set(next[changeId] ?? []);
                  if (selected) current.add(hunkId);
                  else current.delete(hunkId);
                  next[changeId] = current;
                  return next;
                })
              }
              selectedChangeIds={readerAiSelectedChangeIds}
              selectedHunkIds={readerAiSelectedHunkIdsByChangeId}
              onRejectChange={(changeId) => {
                setReaderAiSelectedChangeIds((prev) => {
                  const next = new Set(prev);
                  next.delete(changeId);
                  return next;
                });
                setReaderAiStagedChanges((prev) => prev.filter((change) => change.id !== changeId));
                setReaderAiSelectedHunkIdsByChangeId((prev) => {
                  const next = { ...prev };
                  delete next[changeId];
                  return next;
                });
              }}
              onRejectHunk={(changeId, hunkId) => {
                setReaderAiSelectedHunkIdsByChangeId((prev) => {
                  const next = { ...prev };
                  const current = new Set(next[changeId] ?? []);
                  current.delete(hunkId);
                  next[changeId] = current;
                  return next;
                });
              }}
              error={readerAiError}
              onSend={onReaderAiSend}
              onEditMessage={onReaderAiEditMessage}
              onRetryLastUserMessage={onReaderAiRetryLastMessage}
              onStop={onReaderAiStop}
              onClear={onReaderAiClear}
              repoModeAvailable={repoModeAvailable}
              repoModeEnabled={readerAiRepoMode}
              selectionModeEnabled={
                !readerAiRepoMode &&
                (readerAiConversationScope?.kind === 'selection' ||
                  (readerAiConversationScope === null && readerAiHasEligibleSelection))
              }
              repoModeLoading={readerAiRepoModeLoading}
              repoModeFileCount={repoModeFileCount}
              repoModeDisabledReason={repoModeToggleDisabledReason}
              suggestProjectMode={readerAiSuggestProjectMode && repoModeAvailable && !readerAiRepoMode}
              onToggleRepoMode={(enabled) => void onToggleRepoMode(enabled)}
            />
          </>
        ) : null}
      </div>
      {lightboxImage && <ImageLightbox src={lightboxImage.src} alt={lightboxImage.alt} onClose={onCloseLightbox} />}
      {forkRepoDialog ? (
        <ForkRepoDialog
          open
          installations={forkRepoDialog.installations}
          selectedInstallationId={forkRepoDialog.selectedInstallationId}
          repos={forkRepoDialogRepos}
          reposLoading={forkRepoDialogReposLoading}
          reposLoadError={forkRepoDialogReposLoadError}
          selectedRepoFullName={forkRepoDialog.selectedRepoFullName}
          currentTargetFullName={
            selectedRepoInstallationId === forkRepoDialog.selectedInstallationId && selectedRepo ? selectedRepo : null
          }
          submitting={forkRepoSubmitting}
          onSelectInstallation={(selectedInstallationId) => {
            void onSelectForkRepoInstallation(selectedInstallationId);
          }}
          onSelectRepo={(selectedRepoFullName) => {
            setForkRepoDialog((current) => (current ? { ...current, selectedRepoFullName } : current));
          }}
          onRetryRepos={() => {
            if (!forkRepoDialog) return;
            void syncForkRepoDialogInstallation(forkRepoDialog.selectedInstallationId, { force: true });
          }}
          onConfirm={() => {
            void onConfirmForkRepo();
          }}
          onClose={() => {
            if (forkRepoSubmitting) return;
            setForkRepoDialog(null);
          }}
        />
      ) : null}
      <CompactCommitsDialog
        open={compactCommitsOpen}
        branch={compactCommitsData?.branch ?? null}
        commits={compactCommitsData?.commits ?? []}
        hasMore={compactCommitsData?.hasMore ?? false}
        loading={compactCommitsLoading}
        submitting={compactCommitsSubmitting}
        error={compactCommitsError}
        selectedShas={compactCommitSelection}
        commitMessage={compactCommitMessage}
        onCommitMessageChange={setCompactCommitMessage}
        onToggleCommit={toggleCompactCommitSelection}
        onToggleAllCommits={toggleAllCompactCommits}
        onReload={() => {
          void loadCompactCommits();
        }}
        onClose={closeCompactCommitsDialog}
        onSubmit={() => {
          void submitCompactCommits();
        }}
      />
    </>
  );
}
