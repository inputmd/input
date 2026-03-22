import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'ava';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'input-session-installations-'));
const dbPath = path.join(tmpDir, 'input.db');

{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE user_installations (
      github_user_id INTEGER PRIMARY KEY,
      installation_id TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    INSERT INTO user_installations (github_user_id, installation_id, updated_at_ms)
    VALUES (1, 'legacy-installation', 1000);
  `);
  db.close();
}

process.env.DATABASE_PATH = dbPath;

const session = await import('../session.ts');

test.after.always(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('migrates legacy installations and preserves selected installation', (t) => {
  const linked = session.listInstallationsForUser(1);

  t.deepEqual(
    linked.map((installation) => installation.installationId),
    ['legacy-installation'],
  );
  t.is(session.getRememberedInstallationForUser(1), 'legacy-installation');
});

test('supports multiple linked installations with explicit selection and fallback', (t) => {
  session.rememberInstallationForUser(2, {
    installationId: 'org-a',
    accountLogin: 'org-a',
    accountType: 'Organization',
  });
  session.linkInstallationForUser(2, {
    installationId: 'org-b',
    accountLogin: 'org-b',
    accountType: 'Organization',
  });

  t.deepEqual(
    session.listInstallationsForUser(2).map((installation) => installation.installationId),
    ['org-b', 'org-a'],
  );
  t.is(session.getRememberedInstallationForUser(2), 'org-a');

  t.true(session.selectInstallationForUser(2, 'org-b'));
  t.is(session.getRememberedInstallationForUser(2), 'org-b');
  t.true(session.isInstallationLinkedForUser(2, 'org-a'));
  t.true(session.isInstallationLinkedForUser(2, 'org-b'));

  const fallback = session.removeInstallationForUser(2, 'org-b');
  t.is(fallback, 'org-a');
  t.is(session.getRememberedInstallationForUser(2), 'org-a');
  t.deepEqual(
    session.listInstallationsForUser(2).map((installation) => installation.installationId),
    ['org-a'],
  );
});
