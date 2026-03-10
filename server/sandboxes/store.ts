import crypto from 'node:crypto';
import { ClientError } from '../errors';
import { db } from './db';
import { MAX_ACTIVE_GLOBAL, MAX_ACTIVE_PER_USER } from './limits';
import type { SandboxRecord, SandboxState } from './types';

db.exec(`
  CREATE TABLE IF NOT EXISTS sandbox_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    repo_full_name TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit_sha TEXT,
    last_persisted_sha TEXT,
    fly_machine_id TEXT,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    last_activity_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_user_repo
    ON sandbox_sessions (user_id, repo_full_name);
  CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_state
    ON sandbox_sessions (state);
`);

const upsertStmt = db.prepare(`
  INSERT INTO sandbox_sessions (
    id, user_id, repo_full_name, branch, base_commit_sha,
    last_persisted_sha, fly_machine_id, state,
    created_at_ms, updated_at_ms, last_activity_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    branch = excluded.branch,
    base_commit_sha = excluded.base_commit_sha,
    last_persisted_sha = excluded.last_persisted_sha,
    fly_machine_id = excluded.fly_machine_id,
    state = excluded.state,
    updated_at_ms = excluded.updated_at_ms,
    last_activity_at_ms = excluded.last_activity_at_ms
`);

const getByUserRepoStmt = db.prepare(`
  SELECT * FROM sandbox_sessions
  WHERE user_id = ? AND repo_full_name = ? AND state NOT IN ('stopped', 'failed')
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const updateStateStmt = db.prepare(`
  UPDATE sandbox_sessions
  SET state = ?, updated_at_ms = ?
  WHERE id = ?
`);

const updateActivityStmt = db.prepare(`
  UPDATE sandbox_sessions
  SET last_activity_at_ms = ?, updated_at_ms = ?
  WHERE id = ?
`);

const updateMachineIdStmt = db.prepare(`
  UPDATE sandbox_sessions
  SET fly_machine_id = ?, updated_at_ms = ?
  WHERE id = ?
`);

const updatePersistedShaStmt = db.prepare(`
  UPDATE sandbox_sessions
  SET last_persisted_sha = ?, updated_at_ms = ?
  WHERE id = ?
`);

const listIdleStmt = db.prepare(`
  SELECT * FROM sandbox_sessions
  WHERE state = 'ready' AND last_activity_at_ms < ?
`);

const countActiveByUserStmt = db.prepare(`
  SELECT COUNT(*) as count FROM sandbox_sessions
  WHERE user_id = ? AND state NOT IN ('stopped', 'failed')
`);

const countActiveGlobalStmt = db.prepare(`
  SELECT COUNT(*) as count FROM sandbox_sessions
  WHERE state NOT IN ('stopped', 'failed')
`);

function mapRow(row: Record<string, unknown>): SandboxRecord {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    repoFullName: String(row.repo_full_name),
    branch: String(row.branch),
    baseCommitSha: row.base_commit_sha == null ? null : String(row.base_commit_sha),
    lastPersistedSha: row.last_persisted_sha == null ? null : String(row.last_persisted_sha),
    flyMachineId: row.fly_machine_id == null ? null : String(row.fly_machine_id),
    state: String(row.state) as SandboxState,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    lastActivityAtMs: Number(row.last_activity_at_ms),
  };
}

export function getSandboxByUserRepo(userId: number, repoFullName: string): SandboxRecord | null {
  const row = getByUserRepoStmt.get(userId, repoFullName) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function createSandboxSession(userId: number, repoFullName: string, branch: string): SandboxRecord | null {
  // All checks and the insert are synchronous (no await), so they execute as a
  // single atomic block in Node's event loop — no concurrent request can slip in.
  const existing = getSandboxByUserRepo(userId, repoFullName);
  if (existing) return null;

  const userCount = countActiveSandboxesByUser(userId);
  if (userCount >= MAX_ACTIVE_PER_USER) {
    throw new ClientError(
      `You already have ${userCount} active sandbox(es). Stop one before starting another (max ${MAX_ACTIVE_PER_USER}).`,
      429,
    );
  }

  const globalCount = countActiveSandboxesGlobal();
  if (globalCount >= MAX_ACTIVE_GLOBAL) {
    throw new ClientError('Sandbox capacity is full. Please try again later.', 503);
  }

  const now = Date.now();
  const id = crypto.randomBytes(12).toString('hex');
  const state: SandboxState = 'provisioning';
  upsertStmt.run(id, userId, repoFullName, branch, null, null, null, state, now, now, now);
  return {
    id,
    userId,
    repoFullName,
    branch,
    baseCommitSha: null,
    lastPersistedSha: null,
    flyMachineId: null,
    state,
    createdAtMs: now,
    updatedAtMs: now,
    lastActivityAtMs: now,
  };
}

export function updateSandboxState(id: string, state: SandboxState): void {
  updateStateStmt.run(state, Date.now(), id);
}

export function touchSandboxActivity(id: string): void {
  const now = Date.now();
  updateActivityStmt.run(now, now, id);
}

export function setSandboxMachineId(id: string, machineId: string): void {
  updateMachineIdStmt.run(machineId, Date.now(), id);
}

export function setSandboxPersistedSha(id: string, sha: string): void {
  updatePersistedShaStmt.run(sha, Date.now(), id);
}

export function listIdleSandboxes(olderThanMs: number): SandboxRecord[] {
  const rows = listIdleStmt.all(olderThanMs) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function countActiveSandboxesByUser(userId: number): number {
  const row = countActiveByUserStmt.get(userId) as { count: number };
  return row.count;
}

export function countActiveSandboxesGlobal(): number {
  const row = countActiveGlobalStmt.get() as { count: number };
  return row.count;
}
