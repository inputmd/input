import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_PATH, SESSION_MAX_LIFETIME_SECONDS, SESSION_TTL_SECONDS } from './config.ts';
import type { RepoFileShareLinkRecord, Session, UserInstallation } from './types.ts';

const SESSION_COOKIE_NAME = 'input_session_id';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type OAuthStateRecord = {
  returnTo: string;
  expiresAtMs: number;
};

type SessionInput = {
  githubUserId: number;
  githubAccessToken: string;
  githubLogin: string;
  githubAvatarUrl: string;
  githubName: string | null;
  installationId: string | null;
};

// TODO: In-memory store — does not survive server restarts. Restart during an
// active OAuth flow (within the 10-minute TTL) will cause that flow to fail
// with "Invalid or expired OAuth state", requiring the user to retry login.
// Unlike sessions (persisted in SQLite), this is intentionally ephemeral since
// OAuth states are short-lived and single-use. Multi-instance deployments would
// need a shared store (e.g. Redis) or sticky sessions.
const oauthStates = new Map<string, OAuthStateRecord>();

function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
}

ensureDbDir(DATABASE_PATH);
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    github_user_id INTEGER NOT NULL,
    github_access_token TEXT NOT NULL,
    github_login TEXT NOT NULL,
    github_avatar_url TEXT NOT NULL,
    github_name TEXT,
    installation_id TEXT,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at_ms ON sessions (expires_at_ms);
`);

// Migration: add created_at_ms column if missing (existing sessions get current timestamp).
try {
  db.exec('ALTER TABLE sessions ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE sessions SET created_at_ms = ${Date.now()} WHERE created_at_ms = 0`);
} catch {
  // Column already exists.
}

db.exec(`
  CREATE TABLE IF NOT EXISTS user_installations (
    github_user_id INTEGER NOT NULL,
    installation_id TEXT NOT NULL,
    account_login TEXT,
    account_type TEXT,
    account_avatar_url TEXT,
    account_html_url TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (github_user_id, installation_id)
  );

  CREATE INDEX IF NOT EXISTS idx_user_installations_github_user_id
  ON user_installations (github_user_id, updated_at_ms DESC);

  CREATE TABLE IF NOT EXISTS user_installation_preferences (
    github_user_id INTEGER PRIMARY KEY,
    selected_installation_id TEXT,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repo_file_share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_user_id INTEGER NOT NULL,
    installation_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    token TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_repo_file_share_links_lookup
  ON repo_file_share_links (
    github_user_id,
    installation_id,
    owner,
    repo,
    path,
    expires_at_ms DESC,
    created_at_ms DESC
  );
`);

type TableInfoRow = {
  name: string;
  pk: number;
};

function hasLegacyUserInstallationsSchema(): boolean {
  const rows = db.prepare('PRAGMA table_info(user_installations)').all() as TableInfoRow[];
  if (rows.length === 0) return false;
  const githubUserId = rows.find((row) => row.name === 'github_user_id');
  const installationId = rows.find((row) => row.name === 'installation_id');
  const hasMetadataColumns = rows.some((row) => row.name === 'account_login');
  return Boolean(githubUserId?.pk === 1 && installationId?.pk === 0 && !hasMetadataColumns);
}

if (hasLegacyUserInstallationsSchema()) {
  db.exec(`
    DROP INDEX IF EXISTS idx_user_installations_github_user_id;
    ALTER TABLE user_installations RENAME TO user_installations_legacy;

    CREATE TABLE user_installations (
      github_user_id INTEGER NOT NULL,
      installation_id TEXT NOT NULL,
      account_login TEXT,
      account_type TEXT,
      account_avatar_url TEXT,
      account_html_url TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (github_user_id, installation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_installations_github_user_id
    ON user_installations (github_user_id, updated_at_ms DESC);

    INSERT INTO user_installations (github_user_id, installation_id, updated_at_ms)
    SELECT github_user_id, installation_id, updated_at_ms
    FROM user_installations_legacy;

    INSERT INTO user_installation_preferences (github_user_id, selected_installation_id, updated_at_ms)
    SELECT github_user_id, installation_id, updated_at_ms
    FROM user_installations_legacy;

    DROP TABLE user_installations_legacy;
  `);
}

const sessionUpsertStmt = db.prepare(`
  INSERT INTO sessions (
    id,
    github_user_id,
    github_access_token,
    github_login,
    github_avatar_url,
    github_name,
    installation_id,
    created_at_ms,
    expires_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    github_user_id = excluded.github_user_id,
    github_access_token = excluded.github_access_token,
    github_login = excluded.github_login,
    github_avatar_url = excluded.github_avatar_url,
    github_name = excluded.github_name,
    installation_id = excluded.installation_id,
    expires_at_ms = excluded.expires_at_ms
`);

const sessionByIdStmt = db.prepare(`
  SELECT
    id,
    github_user_id,
    github_access_token,
    github_login,
    github_avatar_url,
    github_name,
    installation_id,
    created_at_ms,
    expires_at_ms
  FROM sessions
  WHERE id = ?
`);

const deleteSessionByIdStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteExpiredSessionsStmt = db.prepare('DELETE FROM sessions WHERE expires_at_ms <= ?');
const sessionStoreHealthStmt = db.prepare('SELECT 1');
const insertRepoFileShareLinkStmt = db.prepare(`
  INSERT INTO repo_file_share_links (
    github_user_id,
    installation_id,
    owner,
    repo,
    path,
    token,
    url,
    created_at_ms,
    expires_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING
    id,
    github_user_id,
    installation_id,
    owner,
    repo,
    path,
    token,
    url,
    created_at_ms,
    expires_at_ms
`);
const selectLatestActiveRepoFileShareLinkStmt = db.prepare(`
  SELECT
    id,
    github_user_id,
    installation_id,
    owner,
    repo,
    path,
    token,
    url,
    created_at_ms,
    expires_at_ms
  FROM repo_file_share_links
  WHERE
    github_user_id = ?
    AND installation_id = ?
    AND owner = ?
    AND repo = ?
    AND path = ?
    AND expires_at_ms > ?
  ORDER BY created_at_ms DESC, id DESC
  LIMIT 1
`);
const selectActiveRepoFileShareLinksStmt = db.prepare(`
  SELECT
    id,
    github_user_id,
    installation_id,
    owner,
    repo,
    path,
    token,
    url,
    created_at_ms,
    expires_at_ms
  FROM repo_file_share_links
  WHERE
    github_user_id = ?
    AND installation_id = ?
    AND owner = ?
    AND repo = ?
    AND path = ?
    AND expires_at_ms > ?
  ORDER BY created_at_ms DESC, id DESC
`);
const deleteExpiredRepoFileShareLinksStmt = db.prepare('DELETE FROM repo_file_share_links WHERE expires_at_ms <= ?');

const upsertInstallationStmt = db.prepare(`
  INSERT INTO user_installations (
    github_user_id,
    installation_id,
    account_login,
    account_type,
    account_avatar_url,
    account_html_url,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(github_user_id, installation_id) DO UPDATE SET
    account_login = excluded.account_login,
    account_type = excluded.account_type,
    account_avatar_url = excluded.account_avatar_url,
    account_html_url = excluded.account_html_url,
    updated_at_ms = excluded.updated_at_ms
`);

const upsertInstallationPreferenceStmt = db.prepare(`
  INSERT INTO user_installation_preferences (github_user_id, selected_installation_id, updated_at_ms)
  VALUES (?, ?, ?)
  ON CONFLICT(github_user_id) DO UPDATE SET
    selected_installation_id = excluded.selected_installation_id,
    updated_at_ms = excluded.updated_at_ms
`);

const selectInstallationPreferenceStmt = db.prepare(`
  SELECT selected_installation_id
  FROM user_installation_preferences
  WHERE github_user_id = ?
`);

const selectInstallationsForUserStmt = db.prepare(`
  SELECT
    installation_id,
    account_login,
    account_type,
    account_avatar_url,
    account_html_url,
    updated_at_ms
  FROM user_installations
  WHERE github_user_id = ?
  ORDER BY updated_at_ms DESC, installation_id DESC
`);

const selectInstallationByUserAndIdStmt = db.prepare(`
  SELECT 1
  FROM user_installations
  WHERE github_user_id = ? AND installation_id = ?
  LIMIT 1
`);

const deleteInstallationStmt = db.prepare(
  'DELETE FROM user_installations WHERE github_user_id = ? AND installation_id = ?',
);
const deleteAllInstallationsStmt = db.prepare('DELETE FROM user_installations WHERE github_user_id = ?');
const deleteInstallationPreferenceStmt = db.prepare(
  'DELETE FROM user_installation_preferences WHERE github_user_id = ?',
);

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function appendSetCookie(res: http.ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
    return;
  }
  res.setHeader('Set-Cookie', [String(existing), cookie]);
}

function cookieOptions(maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
  return `${secure}HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function makeCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; ${cookieOptions(maxAgeSeconds)}`;
}

function createSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function buildSession(id: string, input: SessionInput, createdAtMs: number): Session {
  const maxLifetimeMs = createdAtMs + SESSION_MAX_LIFETIME_SECONDS * 1000;
  const slidingMs = Date.now() + SESSION_TTL_SECONDS * 1000;
  return {
    id,
    githubUserId: input.githubUserId,
    githubAccessToken: input.githubAccessToken,
    githubLogin: input.githubLogin,
    githubAvatarUrl: input.githubAvatarUrl,
    githubName: input.githubName,
    installationId: input.installationId,
    createdAtMs,
    expiresAtMs: Math.min(slidingMs, maxLifetimeMs),
  };
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: String(row.id),
    githubUserId: Number(row.github_user_id),
    githubAccessToken: String(row.github_access_token),
    githubLogin: String(row.github_login),
    githubAvatarUrl: String(row.github_avatar_url),
    githubName: row.github_name == null ? null : String(row.github_name),
    installationId: row.installation_id == null ? null : String(row.installation_id),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function upsertSession(res: http.ServerResponse, id: string, input: SessionInput, createdAtMs: number): Session {
  const session = buildSession(id, input, createdAtMs);
  sessionUpsertStmt.run(
    session.id,
    session.githubUserId,
    session.githubAccessToken,
    session.githubLogin,
    session.githubAvatarUrl,
    session.githubName,
    session.installationId,
    session.createdAtMs,
    session.expiresAtMs,
  );
  const cookieMaxAge = Math.max(0, Math.ceil((session.expiresAtMs - Date.now()) / 1000));
  appendSetCookie(res, makeCookie(id, cookieMaxAge));
  return session;
}

export function createSession(res: http.ServerResponse, input: SessionInput): Session {
  return upsertSession(res, createSessionId(), input, Date.now());
}

export function destroySession(req: http.IncomingMessage, res: http.ServerResponse): void {
  const cookies = parseCookies(req);
  const id = cookies[SESSION_COOKIE_NAME];
  if (id) deleteSessionByIdStmt.run(id);
  appendSetCookie(res, makeCookie('', 0));
}

export function getSession(req: http.IncomingMessage): Session | null {
  const cookies = parseCookies(req);
  const id = cookies[SESSION_COOKIE_NAME];
  if (!id) return null;

  const row = sessionByIdStmt.get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const session = rowToSession(row);
  if (session.expiresAtMs <= Date.now()) {
    deleteSessionByIdStmt.run(id);
    return null;
  }
  return session;
}

export function refreshSession(session: Session, res: http.ServerResponse): Session {
  return upsertSession(
    res,
    session.id,
    {
      githubUserId: session.githubUserId,
      githubAccessToken: session.githubAccessToken,
      githubLogin: session.githubLogin,
      githubAvatarUrl: session.githubAvatarUrl,
      githubName: session.githubName,
      installationId: session.installationId,
    },
    session.createdAtMs,
  );
}

export function assertSessionStoreHealthy(): void {
  sessionStoreHealthStmt.get();
}

type UpsertInstallationInput = {
  installationId: string;
  accountLogin?: string | null;
  accountType?: string | null;
  accountAvatarUrl?: string | null;
  accountHtmlUrl?: string | null;
};

type InstallationRow = {
  installation_id?: string;
  account_login?: string | null;
  account_type?: string | null;
  account_avatar_url?: string | null;
  account_html_url?: string | null;
  updated_at_ms?: number;
};

type RepoFileShareLinkRow = {
  id?: number;
  github_user_id?: number;
  installation_id?: string;
  owner?: string;
  repo?: string;
  path?: string;
  token?: string;
  url?: string;
  created_at_ms?: number;
  expires_at_ms?: number;
};

function rowToUserInstallation(row: InstallationRow): UserInstallation {
  return {
    installationId: String(row.installation_id),
    accountLogin: row.account_login == null ? null : String(row.account_login),
    accountType: row.account_type == null ? null : String(row.account_type),
    accountAvatarUrl: row.account_avatar_url == null ? null : String(row.account_avatar_url),
    accountHtmlUrl: row.account_html_url == null ? null : String(row.account_html_url),
    updatedAtMs: Number(row.updated_at_ms ?? 0),
  };
}

function rowToRepoFileShareLinkRecord(row: RepoFileShareLinkRow): RepoFileShareLinkRecord {
  return {
    id: Number(row.id ?? 0),
    githubUserId: Number(row.github_user_id ?? 0),
    installationId: String(row.installation_id),
    owner: String(row.owner),
    repo: String(row.repo),
    path: String(row.path),
    token: String(row.token),
    url: String(row.url),
    createdAtMs: Number(row.created_at_ms ?? 0),
    expiresAtMs: Number(row.expires_at_ms ?? 0),
  };
}

function setSelectedInstallationPreference(githubUserId: number, installationId: string | null): void {
  const nowMs = Date.now();
  if (installationId === null) {
    upsertInstallationPreferenceStmt.run(githubUserId, null, nowMs);
    return;
  }
  upsertInstallationPreferenceStmt.run(githubUserId, installationId, nowMs);
}

function getPreferredInstallationIdForUser(githubUserId: number): string | null {
  const row = selectInstallationPreferenceStmt.get(githubUserId) as
    | { selected_installation_id?: string | null }
    | undefined;
  if (!row?.selected_installation_id) return null;
  return String(row.selected_installation_id);
}

export function linkInstallationForUser(githubUserId: number, input: UpsertInstallationInput): void {
  const nowMs = Date.now();
  upsertInstallationStmt.run(
    githubUserId,
    input.installationId,
    input.accountLogin ?? null,
    input.accountType ?? null,
    input.accountAvatarUrl ?? null,
    input.accountHtmlUrl ?? null,
    nowMs,
  );
}

export function listInstallationsForUser(githubUserId: number): UserInstallation[] {
  const rows = selectInstallationsForUserStmt.all(githubUserId) as InstallationRow[];
  return rows.map(rowToUserInstallation);
}

export function isInstallationLinkedForUser(githubUserId: number, installationId: string): boolean {
  const row = selectInstallationByUserAndIdStmt.get(githubUserId, installationId) as { 1?: number } | undefined;
  return Boolean(row);
}

export function getRememberedInstallationForUser(githubUserId: number): string | null {
  const preferred = getPreferredInstallationIdForUser(githubUserId);
  if (preferred && isInstallationLinkedForUser(githubUserId, preferred)) return preferred;
  const firstInstallation = listInstallationsForUser(githubUserId)[0];
  return firstInstallation?.installationId ?? null;
}

export function rememberInstallationForUser(githubUserId: number, input: UpsertInstallationInput): void {
  linkInstallationForUser(githubUserId, input);
  setSelectedInstallationPreference(githubUserId, input.installationId);
}

export function selectInstallationForUser(githubUserId: number, installationId: string): boolean {
  if (!isInstallationLinkedForUser(githubUserId, installationId)) return false;
  setSelectedInstallationPreference(githubUserId, installationId);
  return true;
}

export function removeInstallationForUser(githubUserId: number, installationId: string): string | null {
  deleteInstallationStmt.run(githubUserId, installationId);
  const preferred = getPreferredInstallationIdForUser(githubUserId);
  if (preferred !== installationId) return getRememberedInstallationForUser(githubUserId);
  const nextSelectedInstallationId = listInstallationsForUser(githubUserId)[0]?.installationId ?? null;
  setSelectedInstallationPreference(githubUserId, nextSelectedInstallationId);
  return nextSelectedInstallationId;
}

export function clearRememberedInstallationForUser(githubUserId: number): void {
  deleteAllInstallationsStmt.run(githubUserId);
  deleteInstallationPreferenceStmt.run(githubUserId);
}

interface CreateRepoFileShareLinkRecordInput {
  installationId: string;
  owner: string;
  repo: string;
  path: string;
  token: string;
  url: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export function createRepoFileShareLinkRecord(
  githubUserId: number,
  input: CreateRepoFileShareLinkRecordInput,
): RepoFileShareLinkRecord {
  const row = insertRepoFileShareLinkStmt.get(
    githubUserId,
    input.installationId,
    input.owner,
    input.repo,
    input.path,
    input.token,
    input.url,
    input.createdAtMs,
    input.expiresAtMs,
  ) as RepoFileShareLinkRow | undefined;
  if (!row) throw new Error('Failed to persist repo file share link');
  return rowToRepoFileShareLinkRecord(row);
}

export function getLatestActiveRepoFileShareLink(
  githubUserId: number,
  installationId: string,
  owner: string,
  repo: string,
  path: string,
  nowMs = Date.now(),
): RepoFileShareLinkRecord | null {
  deleteExpiredRepoFileShareLinksStmt.run(nowMs);
  const row = selectLatestActiveRepoFileShareLinkStmt.get(githubUserId, installationId, owner, repo, path, nowMs) as
    | RepoFileShareLinkRow
    | undefined;
  return row ? rowToRepoFileShareLinkRecord(row) : null;
}

export function listActiveRepoFileShareLinks(
  githubUserId: number,
  installationId: string,
  owner: string,
  repo: string,
  path: string,
  nowMs = Date.now(),
): RepoFileShareLinkRecord[] {
  deleteExpiredRepoFileShareLinksStmt.run(nowMs);
  const rows = selectActiveRepoFileShareLinksStmt.all(
    githubUserId,
    installationId,
    owner,
    repo,
    path,
    nowMs,
  ) as RepoFileShareLinkRow[];
  return rows.map(rowToRepoFileShareLinkRecord);
}

export function createOAuthState(returnTo: string): string {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { returnTo, expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS });
  return state;
}

export function consumeOAuthState(state: string): string | null {
  const rec = oauthStates.get(state);
  oauthStates.delete(state);
  if (!rec) return null;
  if (rec.expiresAtMs <= Date.now()) return null;
  return rec.returnTo;
}

export function startSessionCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    deleteExpiredSessionsStmt.run(now);
    deleteExpiredRepoFileShareLinksStmt.run(now);
    for (const [state, rec] of oauthStates) {
      if (rec.expiresAtMs <= now) oauthStates.delete(state);
    }
  }, 60_000).unref();
}
