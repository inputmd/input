import crypto from 'node:crypto';
import test from 'ava';
import { createRepoFileShareToken, verifyRepoFileShareToken } from '../../server/share_tokens.ts';

function createLegacyRepoFileShareToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      typ: 'repo_file',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      installationId: '123',
      owner: 'inputmd',
      repo: 'input',
      path: 'docs/readme.md',
    }),
    'utf8',
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', 'secret').update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

test('createRepoFileShareToken produces compact tokens bound to repo file refs', (t) => {
  const token = createRepoFileShareToken('secret', {
    installationId: '123',
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
    nowMs: 1_700_000_000_000,
    ttlSeconds: 3600,
  });

  t.is(token.split('.').length, 2);

  const verified = verifyRepoFileShareToken('secret', token, 1_700_000_100_000, {
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
  });

  t.deepEqual(verified, {
    installationId: '123',
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
    exp: 1_700_003_600,
  });
});

test('verifyRepoFileShareToken rejects compact tokens for a different file ref', (t) => {
  const token = createRepoFileShareToken('secret', {
    installationId: '123',
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/readme.md',
    nowMs: 1_700_000_000_000,
    ttlSeconds: 3600,
  });

  const verified = verifyRepoFileShareToken('secret', token, 1_700_000_100_000, {
    owner: 'inputmd',
    repo: 'input',
    path: 'docs/other.md',
  });

  t.is(verified, null);
});

test('verifyRepoFileShareToken still accepts legacy embedded share tokens', (t) => {
  const legacyToken = createLegacyRepoFileShareToken();

  const verified = verifyRepoFileShareToken('secret', legacyToken, 1_700_000_100_000);

  t.truthy(verified);
  t.is(verified?.installationId, '123');
  t.is(verified?.owner, 'inputmd');
  t.is(verified?.repo, 'input');
  t.is(verified?.path, 'docs/readme.md');
  t.is(verified?.exp, 1_700_003_600);
});
