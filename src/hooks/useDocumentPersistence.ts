import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GitHubUser } from '../github';
import { getGist } from '../github';
import { getRepoContents, isRepoFile, SessionExpiredError } from '../github_app';
import type { ActiveView } from '../components/Toolbar';

// --- Types ---

export interface PersistedDocumentDraft {
  kind: 'gist' | 'repo';
  content: string;
  updatedAtMs: number;
  baseRevision: string | null;
  gistId?: string;
  filename?: string;
  installationId?: string;
  repoFullName?: string;
  path?: string;
}

type DocumentDraftStore = Record<string, PersistedDocumentDraft>;

export interface PostSaveVerificationState {
  routeKey: string;
  status: 'verifying' | 'delayed';
  kind: 'gist' | 'repo';
  gistId?: string;
  filename?: string;
  expectedUpdatedAt?: string;
  installationId?: string;
  repoFullName?: string;
  path?: string;
  expectedSha?: string;
}

// --- Constants ---

const DOCUMENT_DRAFTS_STORAGE_KEY = 'document_drafts_v1';
const MAX_DOCUMENT_DRAFTS = 10;
const MAX_DOCUMENT_DRAFT_CONTENT_BYTES = 512 * 1024;

// --- Draft store helpers ---

export function documentDraftKeyForGist(gistId: string, filename: string): string {
  return `gist:${gistId}:${filename}`;
}

export function documentDraftKeyForRepo(installationId: string, repoFullName: string, path: string): string {
  return `repo:${installationId}:${repoFullName.toLowerCase()}:${path}`;
}

function loadDocumentDraftStore(): DocumentDraftStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(DOCUMENT_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const store: DocumentDraftStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.content !== 'string') continue;
      const kind = entry.kind === 'repo' ? 'repo' : entry.kind === 'gist' ? 'gist' : null;
      if (!kind) continue;
      store[key] = {
        kind,
        content: entry.content,
        updatedAtMs: typeof entry.updatedAtMs === 'number' ? entry.updatedAtMs : 0,
        baseRevision: typeof entry.baseRevision === 'string' ? entry.baseRevision : null,
        gistId: typeof entry.gistId === 'string' ? entry.gistId : undefined,
        filename: typeof entry.filename === 'string' ? entry.filename : undefined,
        installationId: typeof entry.installationId === 'string' ? entry.installationId : undefined,
        repoFullName: typeof entry.repoFullName === 'string' ? entry.repoFullName : undefined,
        path: typeof entry.path === 'string' ? entry.path : undefined,
      };
    }
    return store;
  } catch {
    return {};
  }
}

function persistDocumentDraftStore(store: DocumentDraftStore): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(store).length === 0) {
      localStorage.removeItem(DOCUMENT_DRAFTS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(DOCUMENT_DRAFTS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    return;
  }
}

export function loadDocumentDraft(key: string): PersistedDocumentDraft | null {
  const store = loadDocumentDraftStore();
  return store[key] ?? null;
}

export function saveDocumentDraft(key: string, draft: PersistedDocumentDraft): void {
  if (new Blob([draft.content]).size > MAX_DOCUMENT_DRAFT_CONTENT_BYTES) return;
  const store = loadDocumentDraftStore();
  store[key] = draft;
  const entries = Object.entries(store);
  if (entries.length > MAX_DOCUMENT_DRAFTS) {
    entries.sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
    for (const [k] of entries.slice(0, entries.length - MAX_DOCUMENT_DRAFTS)) {
      delete store[k];
    }
  }
  persistDocumentDraftStore(store);
}

export function removeDocumentDraft(key: string): void {
  const store = loadDocumentDraftStore();
  if (!(key in store)) return;
  delete store[key];
  persistDocumentDraftStore(store);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// --- Hook input/output ---

export interface UseDocumentPersistenceInput {
  repoAccessMode: 'installed' | 'public' | null;
  installationId: string | null;
  selectedRepo: string | null;
  currentRepoDocPath: string | null;
  currentRepoDocSha: string | null;
  currentGistId: string | null;
  currentGistUpdatedAt: string | null;
  currentFileName: string | null;
  user: GitHubUser | null;

  editContent: string;
  editingBackend: 'gist' | 'repo' | null;
  activeView: ActiveView | null;
  draftMode: boolean;
  currentRouteKey: string | null;
  routeName: string;

  showFailureToast: (message: string) => void;
}

// --- Hook ---

export function useDocumentPersistence(input: UseDocumentPersistenceInput) {
  const {
    repoAccessMode,
    installationId,
    selectedRepo,
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
    routeName,
    showFailureToast,
  } = input;

  // --- State ---
  const [currentDocumentSavedContent, setCurrentDocumentSavedContent] = useState<string | null>(null);
  const [currentDocumentDraft, setCurrentDocumentDraft] = useState<PersistedDocumentDraft | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [hasUserTypedUnsavedChanges, setHasUserTypedUnsavedChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [postSaveVerification, setPostSaveVerification] = useState<PostSaveVerificationState | null>(null);

  // --- Refs ---
  const saveInFlightRef = useRef(false);
  const postSaveVerificationRef = useRef<PostSaveVerificationState | null>(postSaveVerification);

  // --- Callbacks ---
  const updatePostSaveVerification = useCallback(
    (
      next:
        | PostSaveVerificationState
        | null
        | ((previous: PostSaveVerificationState | null) => PostSaveVerificationState | null),
    ) => {
      if (typeof next === 'function') {
        setPostSaveVerification((previous) => {
          const resolved = next(previous);
          postSaveVerificationRef.current = resolved;
          return resolved;
        });
        return;
      }
      postSaveVerificationRef.current = next;
      setPostSaveVerification(next);
    },
    [],
  );

  // --- Derived values ---
  const currentDocumentDraftKey = useMemo(() => {
    if (repoAccessMode === 'installed' && installationId && selectedRepo && currentRepoDocPath) {
      return documentDraftKeyForRepo(installationId, selectedRepo, currentRepoDocPath);
    }
    if (user && currentGistId && currentFileName) {
      return documentDraftKeyForGist(currentGistId, currentFileName);
    }
    return null;
  }, [repoAccessMode, installationId, selectedRepo, currentRepoDocPath, user, currentGistId, currentFileName]);

  const currentDocumentBaseRevision = useMemo(() => {
    if (repoAccessMode === 'installed') return currentRepoDocSha;
    if (currentGistId) return currentGistUpdatedAt;
    return null;
  }, [repoAccessMode, currentRepoDocSha, currentGistId, currentGistUpdatedAt]);

  const shouldPreserveVerifiedContent =
    currentRouteKey !== null &&
    postSaveVerificationRef.current !== null &&
    postSaveVerificationRef.current.routeKey === currentRouteKey &&
    (postSaveVerificationRef.current.status === 'verifying' || postSaveVerificationRef.current.status === 'delayed');

  const hasDivergedDocumentDraft =
    currentDocumentDraft !== null &&
    currentDocumentSavedContent !== null &&
    currentDocumentDraft.content !== currentDocumentSavedContent;

  const currentDocumentContent = activeView === 'edit' ? editContent : currentDocumentSavedContent;

  const hasRestorableDocumentDraft =
    currentDocumentDraft !== null &&
    currentDocumentContent !== null &&
    currentDocumentDraft.content !== currentDocumentContent;

  const saveStatusTone: 'warning' | 'pending' = postSaveVerification?.status === 'delayed' ? 'warning' : 'pending';

  // --- Effects ---

  // Clear verification when route changes away
  useEffect(() => {
    if (!postSaveVerification) return;
    if (postSaveVerification.routeKey === currentRouteKey) return;
    if (currentRouteKey === null && (routeName === 'edit' || routeName === 'repoedit')) return;
    updatePostSaveVerification(null);
  }, [currentRouteKey, postSaveVerification, routeName, updatePostSaveVerification]);

  // Post-save verification polling
  useEffect(() => {
    if (!postSaveVerification || postSaveVerification.status !== 'verifying') return;

    let cancelled = false;
    const verify = async () => {
      const delaysMs = [0, 250, 750, 1500, 3000];

      for (const delayMs of delaysMs) {
        if (delayMs > 0) await wait(delayMs);
        if (cancelled) return;

        try {
          if (postSaveVerification.kind === 'repo') {
            const instId = postSaveVerification.installationId;
            const repoFullName = postSaveVerification.repoFullName;
            const path = postSaveVerification.path;
            const expectedSha = postSaveVerification.expectedSha;
            if (!instId || !repoFullName || !path || !expectedSha) break;
            const verified = await getRepoContents(instId, repoFullName, path, undefined, {
              forceRefresh: true,
            });
            if (cancelled) return;
            if (isRepoFile(verified) && verified.sha === expectedSha) {
              updatePostSaveVerification((prev) => (prev?.routeKey === postSaveVerification.routeKey ? null : prev));
              return;
            }
          } else {
            const gistId = postSaveVerification.gistId;
            const filename = postSaveVerification.filename;
            const expectedUpdatedAt = postSaveVerification.expectedUpdatedAt;
            if (!gistId || !filename || !expectedUpdatedAt) break;
            const verified = await getGist(gistId, { forceRefresh: true });
            if (cancelled) return;
            if (verified.updated_at === expectedUpdatedAt && verified.files[filename]) {
              updatePostSaveVerification((prev) => (prev?.routeKey === postSaveVerification.routeKey ? null : prev));
              return;
            }
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) return;
        }
      }

      if (cancelled) return;
      updatePostSaveVerification((prev) =>
        prev?.routeKey === postSaveVerification.routeKey ? { ...prev, status: 'delayed' } : prev,
      );
      showFailureToast('Saved, but GitHub has not returned the new version yet. Keeping your local content on screen.');
    };

    void verify();
    return () => {
      cancelled = true;
    };
  }, [postSaveVerification, showFailureToast, updatePostSaveVerification]);

  // Load draft when document identity changes
  useEffect(() => {
    if (!currentDocumentDraftKey) {
      setCurrentDocumentDraft(null);
      return;
    }
    const stored = loadDocumentDraft(currentDocumentDraftKey);
    if (stored && currentDocumentSavedContent !== null && stored.content === currentDocumentSavedContent) {
      removeDocumentDraft(currentDocumentDraftKey);
      setCurrentDocumentDraft(null);
      return;
    }
    setCurrentDocumentDraft(stored);
  }, [currentDocumentDraftKey, currentDocumentSavedContent]);

  // Persist draft while editing
  useEffect(() => {
    if (!currentDocumentDraftKey || draftMode || activeView !== 'edit' || !hasUnsavedChanges) return;
    const nextDraft: PersistedDocumentDraft | null =
      editingBackend === 'repo' && installationId && selectedRepo && currentRepoDocPath
        ? {
            kind: 'repo',
            content: editContent,
            updatedAtMs: Date.now(),
            baseRevision: currentDocumentBaseRevision,
            installationId,
            repoFullName: selectedRepo,
            path: currentRepoDocPath,
          }
        : currentGistId && currentFileName
          ? {
              kind: 'gist',
              content: editContent,
              updatedAtMs: Date.now(),
              baseRevision: currentDocumentBaseRevision,
              gistId: currentGistId,
              filename: currentFileName,
            }
          : null;
    if (!nextDraft) return;
    saveDocumentDraft(currentDocumentDraftKey, nextDraft);
    setCurrentDocumentDraft(nextDraft);
  }, [
    activeView,
    currentDocumentBaseRevision,
    currentDocumentDraftKey,
    currentFileName,
    currentGistId,
    currentRepoDocPath,
    draftMode,
    editContent,
    editingBackend,
    hasUnsavedChanges,
    installationId,
    selectedRepo,
  ]);

  // Clear typed changes flag when unsaved changes are cleared
  useEffect(() => {
    if (hasUnsavedChanges) return;
    setHasUserTypedUnsavedChanges(false);
  }, [hasUnsavedChanges]);

  return {
    // State
    currentDocumentSavedContent,
    currentDocumentDraft,
    hasUnsavedChanges,
    hasUserTypedUnsavedChanges,
    saving,
    postSaveVerification,

    // Setters
    setCurrentDocumentSavedContent,
    setCurrentDocumentDraft,
    setHasUnsavedChanges,
    setHasUserTypedUnsavedChanges,
    setSaving,
    updatePostSaveVerification,

    // Refs
    saveInFlightRef,
    postSaveVerificationRef,

    // Derived
    currentDocumentDraftKey,
    currentDocumentBaseRevision,
    shouldPreserveVerifiedContent,
    hasDivergedDocumentDraft,
    currentDocumentContent,
    hasRestorableDocumentDraft,
    saveStatusTone,
  };
}
