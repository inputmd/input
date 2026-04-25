import test from 'ava';
import {
  resolvePersistedHomeSessionTransition,
  resolvePersistedHomeTrustAccess,
} from '../../src/repo_workspace/persisted_home_trust.ts';

test('trusted repos default credential sync on but remain configurable', (t) => {
  const result = resolvePersistedHomeTrustAccess({
    currentGistId: null,
    currentGistOwnerLogin: null,
    currentRouteRepoRef: null,
    linkedInstallations: [],
    linkedInstallationsLoaded: true,
    publicRepoRef: null,
    repoAccessMode: 'installed',
    selectedRepo: 'raymond/input',
    userLogin: 'raymond',
    workspaceKey: 'repo:raymond/input',
  });

  t.true(result.canConfigure);
  t.truthy(result.prompt);
  t.is(result.prompt?.defaultMode, 'include');
  t.true(result.prompt?.trustResolved ?? false);
  t.false('promptOnBoot' in (result.prompt ?? {}));
  t.is(result.prompt?.storageKey, 'user:raymond:repo:raymond/input');
});

test('untrusted gists default credential sync off without blocking terminal boot', (t) => {
  const result = resolvePersistedHomeTrustAccess({
    currentGistId: '123',
    currentGistOwnerLogin: 'someone-else',
    currentRouteRepoRef: null,
    linkedInstallations: [],
    linkedInstallationsLoaded: true,
    publicRepoRef: null,
    repoAccessMode: null,
    selectedRepo: null,
    userLogin: 'raymond',
    workspaceKey: 'gist:123',
  });

  t.true(result.canConfigure);
  t.truthy(result.prompt);
  t.is(result.prompt?.defaultMode, 'exclude');
  t.true(result.prompt?.trustResolved ?? false);
  t.false('promptOnBoot' in (result.prompt ?? {}));
  t.regex(result.prompt?.message ?? '', /trust this gist/i);
  t.is(result.prompt?.storageKey, 'user:raymond:gist:123');
});

test('re-enabling credential sync does not capture state from an excluded session', (t) => {
  const result = resolvePersistedHomeSessionTransition({
    activeSessionMode: 'exclude',
    configuredMode: 'include',
  });

  t.false(result.captureActiveSessionState);
  t.true(result.includePersistedHomeSync);
  t.true(result.enableNetworkingBridge);
  t.is(result.nextSessionMode, 'include');
});

test('untrusted public repos default credential sync off without blocking terminal boot', (t) => {
  const result = resolvePersistedHomeTrustAccess({
    currentGistId: null,
    currentGistOwnerLogin: null,
    currentRouteRepoRef: null,
    linkedInstallations: [],
    linkedInstallationsLoaded: true,
    publicRepoRef: { owner: 'other-org', repo: 'their-project' },
    repoAccessMode: 'public',
    selectedRepo: null,
    userLogin: 'raymond',
    workspaceKey: 'public:other-org/their-project',
  });

  t.true(result.canConfigure);
  t.truthy(result.prompt);
  t.is(result.prompt?.defaultMode, 'exclude');
  t.true(result.prompt?.trustResolved ?? false);
  t.false('promptOnBoot' in (result.prompt ?? {}));
  t.regex(result.prompt?.message ?? '', /trusted repos/i);
  t.is(result.prompt?.storageKey, 'user:raymond:repo:other-org/their-project');
});

test('org repos stay pending until linked installations finish loading', (t) => {
  const result = resolvePersistedHomeTrustAccess({
    currentGistId: null,
    currentGistOwnerLogin: null,
    currentRouteRepoRef: null,
    linkedInstallations: [],
    linkedInstallationsLoaded: false,
    publicRepoRef: { owner: 'other-org', repo: 'their-project' },
    repoAccessMode: 'public',
    selectedRepo: null,
    userLogin: 'raymond',
    workspaceKey: 'public:other-org/their-project',
  });

  t.truthy(result.prompt);
  t.is(result.prompt?.defaultMode, 'exclude');
  t.false(result.prompt?.trustResolved ?? true);
  t.truthy(result.prompt?.note);
});

test('personal repos do not wait for linked installations to load', (t) => {
  const result = resolvePersistedHomeTrustAccess({
    currentGistId: null,
    currentGistOwnerLogin: null,
    currentRouteRepoRef: null,
    linkedInstallations: [],
    linkedInstallationsLoaded: false,
    publicRepoRef: null,
    repoAccessMode: 'installed',
    selectedRepo: 'raymond/input',
    userLogin: 'raymond',
    workspaceKey: 'repo:raymond/input',
  });

  t.truthy(result.prompt);
  t.is(result.prompt?.defaultMode, 'include');
  t.true(result.prompt?.trustResolved ?? false);
});

test('anonymous sessions use a separate trust-decision storage scope', (t) => {
  const result = resolvePersistedHomeTrustAccess({
    currentGistId: null,
    currentGistOwnerLogin: null,
    currentRouteRepoRef: null,
    linkedInstallations: [],
    linkedInstallationsLoaded: true,
    publicRepoRef: { owner: 'other-org', repo: 'their-project' },
    repoAccessMode: 'public',
    selectedRepo: null,
    userLogin: null,
    workspaceKey: 'public:other-org/their-project',
  });

  t.is(result.prompt?.storageKey, 'anon:session:repo:other-org/their-project');
});

test('standard include-to-exclude transitions still capture the active session state', (t) => {
  const result = resolvePersistedHomeSessionTransition({
    activeSessionMode: 'include',
    configuredMode: 'exclude',
  });

  t.true(result.captureActiveSessionState);
  t.false(result.includePersistedHomeSync);
  t.true(result.enableNetworkingBridge);
  t.is(result.nextSessionMode, 'exclude');
});

test('disabling credential sync during reconfigure skips the final active-session capture', (t) => {
  const result = resolvePersistedHomeSessionTransition({
    activeSessionMode: 'include',
    configuredMode: 'exclude',
    reason: 'reconfigure',
  });

  t.false(result.captureActiveSessionState);
  t.false(result.includePersistedHomeSync);
  t.true(result.enableNetworkingBridge);
  t.is(result.nextSessionMode, 'exclude');
});

test('initial boot into trusted workspace does not attempt to capture non-existent session state', (t) => {
  const result = resolvePersistedHomeSessionTransition({
    activeSessionMode: null,
    configuredMode: 'include',
  });

  t.false(result.captureActiveSessionState);
  t.true(result.includePersistedHomeSync);
  t.true(result.enableNetworkingBridge);
  t.is(result.nextSessionMode, 'include');
});

test('initial boot into untrusted workspace does not attempt to capture non-existent session state', (t) => {
  const result = resolvePersistedHomeSessionTransition({
    activeSessionMode: null,
    configuredMode: 'exclude',
  });

  t.false(result.captureActiveSessionState);
  t.false(result.includePersistedHomeSync);
  t.true(result.enableNetworkingBridge);
  t.is(result.nextSessionMode, 'exclude');
});
