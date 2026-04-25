import type { WebContainer } from '@webcontainer/api';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  derivePersistedHomeCredentialPresence,
  loadPersistedHomeEntries,
  logPersistedHomePaths,
  type PersistedHomeCredentialPresence,
  type PersistedHomeEntry,
  partitionPersistedHomeEntriesByScope,
  persistedHomeWorkspaceEntriesToFiles,
  persistPersistedHomeEntries,
} from '../persisted_home_state.ts';
import {
  type PersistedHomeMode,
  type PersistedHomeTransitionReason,
  type PersistedHomeTrustPrompt,
  readPersistedHomeTrustDecision,
  writePersistedHomeTrustDecision,
} from '../repo_workspace/persisted_home_trust.ts';

const PERSISTED_HOME_STATE_PERSIST_DEBOUNCE_MS = 250;
const EMPTY_CREDENTIAL_PRESENCE: PersistedHomeCredentialPresence = { claude: false, pi: false };

type SpawnedShell = Awaited<ReturnType<WebContainer['spawn']>>;

interface RefValue<T> {
  current: T;
}

export interface TerminalPersistedHomePromptState {
  message: string;
  note: string | null;
  storageKey: string;
  target: 'gist' | 'repo' | 'workspace';
  title: string;
}

interface UseTerminalPersistedHomeArgs {
  canApplyPersistedHomeCapture?: () => boolean;
  focusPane: () => void;
  persistedHomeTrustPrompt: PersistedHomeTrustPrompt | null;
  readPersistedHomeWorkspaceFiles: () => Record<string, string>;
  readPersistedHomeEntriesForWorkspace: (wc: WebContainer, scriptPath: string) => Promise<PersistedHomeEntry[]>;
  restartWebContainerRef: RefValue<((options?: { reason?: PersistedHomeTransitionReason }) => Promise<void>) | null>;
  stagePersistedHomeWorkspaceFiles: (files: Record<string, string>, workspaceKey?: string) => void | Promise<void>;
  unmountedRef: RefValue<boolean>;
  wcRef: RefValue<WebContainer | null>;
  workspaceKeyRef: RefValue<string>;
}

interface CapturePersistedHomeStateOptions {
  allowPersist?: boolean;
  immediate?: boolean;
  /** Pin the workspace key for the persist target. When omitted, uses
   *  workspaceKeyRef.current — which can drift if an async operation
   *  (e.g. trust prompt) allows a render to update the ref. */
  targetWorkspaceKey?: string;
}

function isSameCredentialPresence(
  left: PersistedHomeCredentialPresence,
  right: PersistedHomeCredentialPresence,
): boolean {
  return left.claude === right.claude && left.pi === right.pi;
}

export function useTerminalPersistedHome({
  canApplyPersistedHomeCapture,
  focusPane,
  persistedHomeTrustPrompt,
  readPersistedHomeWorkspaceFiles,
  readPersistedHomeEntriesForWorkspace,
  restartWebContainerRef,
  stagePersistedHomeWorkspaceFiles,
  unmountedRef,
  wcRef,
  workspaceKeyRef,
}: UseTerminalPersistedHomeArgs) {
  const persistedHomeSyncRef = useRef<SpawnedShell | null>(null);
  const persistedHomeSyncProcessIdRef = useRef(0);
  const persistedHomeSyncOutputBufferRef = useRef('');
  const persistedHomePersistTimerRef = useRef<number | null>(null);
  const pendingPersistedHomeEntriesRef = useRef<{ entries: PersistedHomeEntry[]; workspaceKey: string } | null>(null);
  const persistedHomeScriptPathRef = useRef<string | null>(null);
  const persistedHomeActiveSessionModeRef = useRef<PersistedHomeMode | null>(null);
  const persistedHomeTrustPromptRef = useRef<PersistedHomeTrustPrompt | null>(persistedHomeTrustPrompt);
  const pendingTrustResolutionPromiseRef = useRef<Promise<void> | null>(null);
  const pendingTrustResolutionResolveRef = useRef<(() => void) | null>(null);
  const [credentialSyncEnabled, setCredentialSyncEnabled] = useState<boolean | null>(null);
  const [persistedHomeCredentialPresence, setPersistedHomeCredentialPresence] =
    useState<PersistedHomeCredentialPresence>(EMPTY_CREDENTIAL_PRESENCE);
  const [persistedHomePromptState, setPersistedHomePromptState] = useState<TerminalPersistedHomePromptState | null>(
    null,
  );
  const [persistenceDialogOpen, setPersistenceDialogOpen] = useState(false);
  const [persistenceDialogLoading, setPersistenceDialogLoading] = useState(false);
  const [persistenceDialogError, setPersistenceDialogError] = useState<string | null>(null);
  const [persistenceDialogSnapshot, setPersistenceDialogSnapshot] = useState<PersistedHomeEntry[] | null>(null);

  const setPersistedHomeConfiguredMode = useCallback((mode: PersistedHomeMode) => {
    setCredentialSyncEnabled(mode === 'include');
    if (mode !== 'include') {
      setPersistedHomeCredentialPresence(EMPTY_CREDENTIAL_PRESENCE);
    }
  }, []);

  const setPersistedHomeCredentialPresenceFromEntries = useCallback((entries: readonly PersistedHomeEntry[]) => {
    const nextPresence = derivePersistedHomeCredentialPresence(entries);
    setPersistedHomeCredentialPresence((currentPresence) =>
      isSameCredentialPresence(currentPresence, nextPresence) ? currentPresence : nextPresence,
    );
  }, []);

  const stagePersistedHomeWorkspaceEntries = useCallback(
    async (entries: readonly PersistedHomeEntry[], workspaceKey?: string) => {
      const { workspaceEntries } = partitionPersistedHomeEntriesByScope(entries);
      const workspaceFiles = persistedHomeWorkspaceEntriesToFiles(workspaceEntries);
      await Promise.resolve(stagePersistedHomeWorkspaceFiles(workspaceFiles, workspaceKey)).catch((err) => {
        console.error('[terminal] failed to stage managed workspace home state', err);
      });
    },
    [stagePersistedHomeWorkspaceFiles],
  );

  useEffect(() => {
    if (credentialSyncEnabled !== true) {
      setPersistedHomeCredentialPresence(EMPTY_CREDENTIAL_PRESENCE);
      return;
    }
    let cancelled = false;
    void loadPersistedHomeEntries(workspaceKeyRef.current, readPersistedHomeWorkspaceFiles()).then(
      (entries) => {
        if (cancelled) return;
        setPersistedHomeCredentialPresenceFromEntries(entries);
      },
      (err) => {
        if (cancelled) return;
        console.error('[terminal] failed to load persisted credential presence', err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    credentialSyncEnabled,
    readPersistedHomeWorkspaceFiles,
    setPersistedHomeCredentialPresenceFromEntries,
    workspaceKeyRef,
  ]);

  useEffect(() => {
    persistedHomeTrustPromptRef.current = persistedHomeTrustPrompt;
    pendingTrustResolutionResolveRef.current?.();
    pendingTrustResolutionResolveRef.current = null;
    pendingTrustResolutionPromiseRef.current = null;
  }, [persistedHomeTrustPrompt]);

  const setPersistedHomeScriptPath = useCallback((path: string | null) => {
    persistedHomeScriptPathRef.current = path;
  }, []);

  const getPersistedHomeActiveSessionMode = useCallback((): PersistedHomeMode | null => {
    return persistedHomeActiveSessionModeRef.current;
  }, []);

  const setPersistedHomeActiveSessionMode = useCallback((mode: PersistedHomeMode | null) => {
    persistedHomeActiveSessionModeRef.current = mode;
  }, []);

  const flushPersistedHomeState = useCallback(
    async (options?: { force?: boolean }) => {
      if (persistedHomePersistTimerRef.current !== null) {
        window.clearTimeout(persistedHomePersistTimerRef.current);
        persistedHomePersistTimerRef.current = null;
      }
      const pending = pendingPersistedHomeEntriesRef.current;
      if (pending === null) return;
      pendingPersistedHomeEntriesRef.current = null;
      if (!options?.force && persistedHomeActiveSessionModeRef.current !== 'include') return;
      await stagePersistedHomeWorkspaceEntries(pending.entries, pending.workspaceKey);
      await persistPersistedHomeEntries(pending.workspaceKey, pending.entries);
      setPersistedHomeCredentialPresenceFromEntries(pending.entries);
      logPersistedHomePaths('info', '[terminal] updated managed home entries', pending.entries);
    },
    [setPersistedHomeCredentialPresenceFromEntries, stagePersistedHomeWorkspaceEntries],
  );

  const persistPersistedHomeStateImmediately = useCallback(
    async (entries: PersistedHomeEntry[], options?: { allowPersist?: boolean; targetWorkspaceKey?: string }) => {
      const allowPersist = options?.allowPersist ?? persistedHomeActiveSessionModeRef.current === 'include';
      if (persistedHomePersistTimerRef.current !== null) {
        window.clearTimeout(persistedHomePersistTimerRef.current);
        persistedHomePersistTimerRef.current = null;
      }
      pendingPersistedHomeEntriesRef.current = null;
      if (!allowPersist) return;
      const key = options?.targetWorkspaceKey ?? workspaceKeyRef.current;
      await stagePersistedHomeWorkspaceEntries(entries, key);
      await persistPersistedHomeEntries(key, entries);
      setPersistedHomeCredentialPresenceFromEntries(entries);
      logPersistedHomePaths('info', '[terminal] updated managed home entries', entries);
    },
    [setPersistedHomeCredentialPresenceFromEntries, stagePersistedHomeWorkspaceEntries, workspaceKeyRef],
  );

  const schedulePersistedHomeState = useCallback(
    (entries: PersistedHomeEntry[]) => {
      if (persistedHomeActiveSessionModeRef.current !== 'include') {
        if (persistedHomePersistTimerRef.current !== null) {
          window.clearTimeout(persistedHomePersistTimerRef.current);
          persistedHomePersistTimerRef.current = null;
        }
        pendingPersistedHomeEntriesRef.current = null;
        return;
      }
      setPersistedHomeCredentialPresenceFromEntries(entries);
      // Capture the workspace key now — by the time the debounce timer fires
      // the ref may point to a different workspace.
      const targetKey = workspaceKeyRef.current;
      void stagePersistedHomeWorkspaceEntries(entries, targetKey);
      pendingPersistedHomeEntriesRef.current = { entries, workspaceKey: targetKey };
      if (persistedHomePersistTimerRef.current !== null) {
        window.clearTimeout(persistedHomePersistTimerRef.current);
      }
      persistedHomePersistTimerRef.current = window.setTimeout(() => {
        persistedHomePersistTimerRef.current = null;
        const pending = pendingPersistedHomeEntriesRef.current;
        if (pending === null) return;
        pendingPersistedHomeEntriesRef.current = null;
        if (persistedHomeActiveSessionModeRef.current !== 'include') return;
        void persistPersistedHomeEntries(pending.workspaceKey, pending.entries).then(
          () => {
            logPersistedHomePaths('info', '[terminal] updated managed home entries', pending.entries);
          },
          (err) => {
            console.error('[terminal] failed to persist managed home state', err);
          },
        );
      }, PERSISTED_HOME_STATE_PERSIST_DEBOUNCE_MS);
    },
    [setPersistedHomeCredentialPresenceFromEntries, stagePersistedHomeWorkspaceEntries, workspaceKeyRef],
  );

  const releasePersistedHomeSyncSession = useCallback(() => {
    persistedHomeSyncProcessIdRef.current += 1;
    persistedHomeSyncOutputBufferRef.current = '';
    const process = persistedHomeSyncRef.current;
    persistedHomeSyncRef.current = null;
    if (!process) return;
    try {
      process.kill();
    } catch {
      // ignore
    }
  }, []);

  const openPersistenceDialog = useCallback(async () => {
    setPersistenceDialogOpen(true);
    setPersistenceDialogLoading(true);
    setPersistenceDialogError(null);
    setPersistenceDialogSnapshot(null);
    try {
      if (credentialSyncEnabled === false) {
        setPersistenceDialogSnapshot([]);
        return;
      }
      await flushPersistedHomeState();
      const entries = await loadPersistedHomeEntries(workspaceKeyRef.current, readPersistedHomeWorkspaceFiles());
      setPersistenceDialogSnapshot(entries);
    } catch (err) {
      setPersistenceDialogError(err instanceof Error ? err.message : 'Failed to load terminal persistence');
    } finally {
      setPersistenceDialogLoading(false);
    }
  }, [credentialSyncEnabled, flushPersistedHomeState, readPersistedHomeWorkspaceFiles, workspaceKeyRef]);

  const closePersistenceDialog = useCallback(() => {
    setPersistenceDialogOpen(false);
  }, []);

  const closePersistedHomePrompt = useCallback(() => {
    setPersistedHomePromptState(null);
  }, []);

  const disposePersistedHomePrompt = useCallback(() => {
    setPersistedHomePromptState(null);
  }, []);

  const settlePersistedHomePrompt = useCallback(
    (restorePersistedHome: boolean) => {
      // Use the storageKey captured at prompt creation time, not the current
      // prop, so that a workspace change between showing and settling the
      // prompt cannot redirect the trust decision to the wrong key.
      const promptStorageKey = persistedHomePromptState?.storageKey ?? null;
      const nextMode: PersistedHomeMode = restorePersistedHome ? 'include' : 'exclude';
      setPersistedHomePromptState(null);
      focusPane();
      if (!promptStorageKey) return;
      setPersistedHomeConfiguredMode(nextMode);
      if (!restorePersistedHome) {
        if (persistedHomePersistTimerRef.current !== null) {
          window.clearTimeout(persistedHomePersistTimerRef.current);
          persistedHomePersistTimerRef.current = null;
        }
        pendingPersistedHomeEntriesRef.current = null;
      }
      writePersistedHomeTrustDecision(promptStorageKey, nextMode);
      void restartWebContainerRef.current?.({ reason: 'reconfigure' });
    },
    [focusPane, persistedHomePromptState, restartWebContainerRef, setPersistedHomeConfiguredMode],
  );

  const waitForPersistedHomeTrustResolution = useCallback(async (): Promise<void> => {
    if (persistedHomeTrustPromptRef.current?.trustResolved ?? true) return;
    if (!pendingTrustResolutionPromiseRef.current) {
      pendingTrustResolutionPromiseRef.current = new Promise<void>((resolve) => {
        pendingTrustResolutionResolveRef.current = resolve;
      });
    }
    await pendingTrustResolutionPromiseRef.current;
  }, []);

  const resolvePersistedHomeMode = useCallback(async (): Promise<PersistedHomeMode> => {
    while (true) {
      const trustPrompt = persistedHomeTrustPromptRef.current;
      if (!trustPrompt) {
        setPersistedHomeConfiguredMode('exclude');
        return 'exclude';
      }
      const storedDecision = readPersistedHomeTrustDecision(trustPrompt.storageKey);
      if (storedDecision) {
        setPersistedHomeConfiguredMode(storedDecision);
        return storedDecision;
      }
      if (!trustPrompt.trustResolved) {
        setCredentialSyncEnabled(null);
        await waitForPersistedHomeTrustResolution();
        continue;
      }
      setPersistedHomeConfiguredMode(trustPrompt.defaultMode);
      return trustPrompt.defaultMode;
    }
  }, [setPersistedHomeConfiguredMode, waitForPersistedHomeTrustResolution]);

  const openPersistedHomeReconfigurePrompt = useCallback(() => {
    if (!persistedHomeTrustPrompt) return;
    setPersistedHomePromptState({
      title: persistedHomeTrustPrompt.title,
      message: persistedHomeTrustPrompt.message,
      note: persistedHomeTrustPrompt.note,
      storageKey: persistedHomeTrustPrompt.storageKey,
      target: persistedHomeTrustPrompt.target,
    });
  }, [persistedHomeTrustPrompt]);

  const capturePersistedHomeState = useCallback(
    async (wc: WebContainer | null, options?: CapturePersistedHomeStateOptions): Promise<void> => {
      if (!wc) return;
      const allowPersist = options?.allowPersist ?? persistedHomeActiveSessionModeRef.current === 'include';
      if (!allowPersist) return;
      const scriptPath = persistedHomeScriptPathRef.current;
      if (!scriptPath) return;
      try {
        const entries = await readPersistedHomeEntriesForWorkspace(wc, scriptPath);
        if (canApplyPersistedHomeCapture && !canApplyPersistedHomeCapture()) return;
        if (options?.immediate) {
          await persistPersistedHomeStateImmediately(entries, {
            allowPersist,
            targetWorkspaceKey: options.targetWorkspaceKey,
          });
          return;
        }
        schedulePersistedHomeState(entries);
      } catch (err) {
        console.error('[terminal] failed to capture managed home state', err);
      }
    },
    [
      canApplyPersistedHomeCapture,
      persistPersistedHomeStateImmediately,
      readPersistedHomeEntriesForWorkspace,
      schedulePersistedHomeState,
    ],
  );

  const startPersistedHomeSync = useCallback(
    async (wc: WebContainer): Promise<void> => {
      releasePersistedHomeSyncSession();
      if (persistedHomeActiveSessionModeRef.current !== 'include') return;
      const scriptPath = persistedHomeScriptPathRef.current;
      if (!scriptPath) return;
      const processId = persistedHomeSyncProcessIdRef.current + 1;
      persistedHomeSyncProcessIdRef.current = processId;
      persistedHomeSyncOutputBufferRef.current = '';

      const watcher = await wc.spawn('node', [scriptPath, 'watch']);
      if (unmountedRef.current || wcRef.current !== wc || persistedHomeSyncProcessIdRef.current !== processId) {
        try {
          watcher.kill();
        } catch {
          // ignore
        }
        return;
      }

      persistedHomeSyncRef.current = watcher;
      void watcher.output
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              if (persistedHomeSyncProcessIdRef.current !== processId) return;
              persistedHomeSyncOutputBufferRef.current += chunk;
              while (true) {
                const newlineIndex = persistedHomeSyncOutputBufferRef.current.indexOf('\n');
                if (newlineIndex === -1) break;
                const line = persistedHomeSyncOutputBufferRef.current.slice(0, newlineIndex).trim();
                persistedHomeSyncOutputBufferRef.current = persistedHomeSyncOutputBufferRef.current.slice(
                  newlineIndex + 1,
                );
                if (!line) continue;
                try {
                  const parsed = JSON.parse(line) as { type?: string; entries?: unknown };
                  if (parsed.type !== 'snapshot' || !Array.isArray(parsed.entries)) continue;
                  const entries = parsed.entries.flatMap((entry) => {
                    if (!entry || typeof entry !== 'object') return [];
                    const path = (entry as { path?: unknown }).path;
                    const content = (entry as { content?: unknown }).content;
                    const mtime = (entry as { mtime?: unknown }).mtime;
                    if (typeof path !== 'string' || typeof content !== 'string') return [];
                    return [
                      {
                        path,
                        content,
                        mtime: typeof mtime === 'number' && Number.isFinite(mtime) ? Math.trunc(mtime) : null,
                      },
                    ];
                  });
                  if (canApplyPersistedHomeCapture && !canApplyPersistedHomeCapture()) continue;
                  schedulePersistedHomeState(entries);
                } catch (err) {
                  console.error('[terminal] failed to parse managed home state event', err);
                }
              }
            },
          }),
        )
        .catch((err) => {
          if (persistedHomeSyncProcessIdRef.current !== processId) return;
          console.error('[terminal] managed home state watcher closed', err);
        });
    },
    [canApplyPersistedHomeCapture, releasePersistedHomeSyncSession, schedulePersistedHomeState, unmountedRef, wcRef],
  );

  return {
    capturePersistedHomeState,
    closePersistenceDialog,
    closePersistedHomePrompt,
    credentialSyncEnabled,
    disposePersistedHomePrompt,
    flushPersistedHomeState,
    getPersistedHomeActiveSessionMode,
    openPersistenceDialog,
    openPersistedHomeReconfigurePrompt,
    persistenceDialogError,
    persistenceDialogLoading,
    persistenceDialogOpen,
    persistenceDialogSnapshot,
    persistedHomeCredentialPresence,
    persistedHomePromptState,
    releasePersistedHomeSyncSession,
    resolvePersistedHomeMode,
    setPersistedHomeActiveSessionMode,
    setPersistedHomeCredentialPresenceFromEntries,
    setPersistedHomeScriptPath,
    settlePersistedHomePrompt,
    startPersistedHomeSync,
  };
}
