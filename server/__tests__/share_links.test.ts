import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'input-share-links-'));
const dbPath = path.join(tmpDir, 'input.db');

process.env.DATABASE_PATH = dbPath;
process.env.SHARE_TOKEN_SECRET = 'test-share-secret';

const session = await import('../session.ts');
const shareLinks = await import('../repo_file_share_links.ts');

test.after.always(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.serial('listActiveRepoFileShareLinks returns only unexpired links for the requested file', (t) => {
  const nowMs = 1_700_000_000_000;
  const githubUserId = 41;
  const installationId = 'inst-1';

  session.createRepoFileShareLinkRecord(githubUserId, {
    installationId,
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
    token: 'expired-token',
    url: 'https://input.test/s/inputmd/input/docs%2Freadme.md?t=expired-token',
    createdAtMs: nowMs - 10_000,
    expiresAtMs: nowMs - 1,
  });
  session.createRepoFileShareLinkRecord(githubUserId, {
    installationId,
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
    token: 'older-active-token',
    url: 'https://input.test/s/inputmd/input/docs%2Freadme.md?t=older-active-token',
    createdAtMs: nowMs - 5_000,
    expiresAtMs: nowMs + 30_000,
  });
  session.createRepoFileShareLinkRecord(githubUserId, {
    installationId,
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/other.md',
    token: 'other-path-token',
    url: 'https://input.test/s/inputmd/input/docs%2Fother.md?t=other-path-token',
    createdAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 30_000,
  });
  const newest = session.createRepoFileShareLinkRecord(githubUserId, {
    installationId,
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
    token: 'newest-active-token',
    url: 'https://input.test/s/inputmd/input/docs%2Freadme.md?t=newest-active-token',
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 30_000,
  });

  const links = session.listActiveRepoFileShareLinks(
    githubUserId,
    installationId,
    'inputmd',
    'input',
    'docs/readme.md',
    nowMs,
  );
  const latest = session.getLatestActiveRepoFileShareLink(
    githubUserId,
    installationId,
    'inputmd',
    'input',
    'docs/readme.md',
    nowMs,
  );

  t.deepEqual(
    links.map((link) => link.token),
    ['newest-active-token', 'older-active-token'],
  );
  t.is(latest?.token, newest.token);
});

test.serial('createOrReuseRepoFileShareLink reuses the active link and list helper returns it', (t) => {
  const githubUserId = 42;
  const input = {
    githubUserId,
    installationId: 'inst-1',
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
    baseUrl: 'https://input.test',
    nowMs: 1_700_100_000_000,
    ttlSeconds: 3600,
    secret: 'test-share-secret',
  };

  const first = shareLinks.createOrReuseRepoFileShareLink(input);
  const second = shareLinks.createOrReuseRepoFileShareLink({ ...input, nowMs: input.nowMs + 1_000 });
  const listed = shareLinks.listRepoFileShareLinkResponses({
    githubUserId,
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    nowMs: input.nowMs + 2_000,
  });

  t.is(first.token, second.token);
  t.is(first.url, second.url);
  t.regex(first.url, /^https:\/\/input\.test\/s\/inputmd\/input\/docs%2Freadme\.md\?t=/);
  t.is(listed.length, 1);
  t.is(listed[0]?.token, first.token);
});
