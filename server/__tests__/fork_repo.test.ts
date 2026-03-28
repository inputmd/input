import test from 'ava';
import { resolveForkTargetInstallationId, resolveForkTargetRepoFullName } from '../../src/fork_repo.ts';
import type { InstallationRepo, LinkedInstallation } from '../../src/github_app.ts';

const linkedInstallations: LinkedInstallation[] = [
  {
    installationId: 'org-a',
    accountLogin: 'org-a',
    accountType: 'Organization',
    accountAvatarUrl: null,
    accountHtmlUrl: null,
    updatedAtMs: 100,
  },
  {
    installationId: 'org-b',
    accountLogin: 'org-b',
    accountType: 'Organization',
    accountAvatarUrl: null,
    accountHtmlUrl: null,
    updatedAtMs: 90,
  },
];

const installationRepos: InstallationRepo[] = [
  {
    id: 1,
    full_name: 'org-a/alpha',
    private: true,
    html_url: 'https://github.com/org-a/alpha',
  },
  {
    id: 2,
    full_name: 'org-a/beta',
    private: false,
    html_url: 'https://github.com/org-a/beta',
  },
];

test('resolveForkTargetInstallationId prefers the active installation when it is linked', (t) => {
  t.is(resolveForkTargetInstallationId(linkedInstallations, 'org-b'), 'org-b');
});

test('resolveForkTargetInstallationId falls back to the first linked installation when needed', (t) => {
  t.is(resolveForkTargetInstallationId(linkedInstallations, 'missing-installation'), 'org-a');
  t.is(resolveForkTargetInstallationId(linkedInstallations, null), 'org-a');
});

test('resolveForkTargetInstallationId returns null when no installations are linked', (t) => {
  t.is(resolveForkTargetInstallationId([], 'org-a'), null);
});

test('resolveForkTargetRepoFullName prefers the requested repo when it exists', (t) => {
  t.is(
    resolveForkTargetRepoFullName(installationRepos, {
      preferredRepoFullName: 'org-a/beta',
    }),
    'org-a/beta',
  );
});

test('resolveForkTargetRepoFullName matches preferred repo names case-insensitively', (t) => {
  t.is(
    resolveForkTargetRepoFullName(installationRepos, {
      preferredRepoFullName: 'ORG-A/ALPHA',
    }),
    'org-a/alpha',
  );
});

test('resolveForkTargetRepoFullName falls back to the first repo when the preferred repo is unavailable', (t) => {
  t.is(
    resolveForkTargetRepoFullName(installationRepos, {
      preferredRepoFullName: 'org-a/missing',
    }),
    'org-a/alpha',
  );
  t.is(resolveForkTargetRepoFullName([]), '');
});
