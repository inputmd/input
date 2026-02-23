import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_PATH, SESSION_MAX_LIFETIME_SECONDS, SESSION_TTL_SECONDS } from './config';
import type { Session } from './types';

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
    github_user_id INTEGER PRIMARY KEY,
    installation_id TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
`);

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

const upsertInstallationStmt = db.prepare(`
  INSERT INTO user_installations (github_user_id, installation_id, updated_at_ms)
  VALUES (?, ?, ?)
  ON CONFLICT(github_user_id) DO UPDATE SET
    installation_id = excluded.installation_id,
    updated_at_ms = excluded.updated_at_ms
`);

const selectInstallationStmt = db.prepare(`
  SELECT installation_id
  FROM user_installations
  WHERE github_user_id = ?
`);

const deleteInstallationStmt = db.prepare('DELETE FROM user_installations WHERE github_user_id = ?');

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
  return upsertSession(res, session.id, {
    githubUserId: session.githubUserId,
    githubAccessToken: session.githubAccessToken,
    githubLogin: session.githubLogin,
    githubAvatarUrl: session.githubAvatarUrl,
    githubName: session.githubName,
    installationId: session.installationId,
  }, session.createdAtMs);
}

export function rememberInstallationForUser(githubUserId: number, installationId: string): void {
  upsertInstallationStmt.run(githubUserId, installationId, Date.now());
}

export function getRememberedInstallationForUser(githubUserId: number): string | null {
  const row = selectInstallationStmt.get(githubUserId) as { installation_id?: string } | undefined;
  if (!row?.installation_id) return null;
  return row.installation_id;
}

export function clearRememberedInstallationForUser(githubUserId: number): void {
  deleteInstallationStmt.run(githubUserId);
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
    for (const [state, rec] of oauthStates) {
      if (rec.expiresAtMs <= now) oauthStates.delete(state);
    }
  }, 60_000).unref();
}
