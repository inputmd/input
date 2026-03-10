import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { SANDBOXES_KEY_ENCRYPTION_SECRET } from '../config';
import { ClientError } from '../errors';
import { db } from './db';

db.exec(`
  CREATE TABLE IF NOT EXISTS sandboxes_user_keys (
    user_id INTEGER PRIMARY KEY,
    iv_b64 TEXT NOT NULL,
    ciphertext_b64 TEXT NOT NULL,
    tag_b64 TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO sandboxes_user_keys (user_id, iv_b64, ciphertext_b64, tag_b64, updated_at_ms)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    iv_b64 = excluded.iv_b64,
    ciphertext_b64 = excluded.ciphertext_b64,
    tag_b64 = excluded.tag_b64,
    updated_at_ms = excluded.updated_at_ms
`);

const getStmt = db.prepare(`
  SELECT iv_b64, ciphertext_b64, tag_b64
  FROM sandboxes_user_keys
  WHERE user_id = ?
  LIMIT 1
`);

const deleteStmt = db.prepare('DELETE FROM sandboxes_user_keys WHERE user_id = ?');

function encryptionKey(): Buffer {
  const secret = SANDBOXES_KEY_ENCRYPTION_SECRET.trim();
  if (!secret) {
    throw new ClientError('Codex key storage is not configured on the server', 503);
  }
  // Derive a proper 256-bit key using HKDF (salt is static but acceptable here since
  // the input keying material should already have high entropy, and each encryption
  // uses a random IV).
  return Buffer.from(hkdfSync('sha256', secret, 'sandboxes-key-encryption-salt', 'aes-256-gcm', 32));
}

function validateApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new ClientError('apiKey is required', 400);
  if (trimmed.length < 20) throw new ClientError('apiKey is too short', 400);
  if (trimmed.length > 1024) throw new ClientError('apiKey is too long', 400);
  return trimmed;
}

export function setSandboxesUserApiKey(userId: number, apiKeyInput: string): void {
  const apiKey = validateApiKey(apiKeyInput);
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  upsertStmt.run(userId, iv.toString('base64'), encrypted.toString('base64'), tag.toString('base64'), Date.now());
}

export function clearSandboxesUserApiKey(userId: number): boolean {
  const result = deleteStmt.run(userId);
  return Number(result.changes) > 0;
}

export function getSandboxesUserApiKey(userId: number): string | null {
  const row = getStmt.get(userId) as
    | {
        iv_b64: string;
        ciphertext_b64: string;
        tag_b64: string;
      }
    | undefined;
  if (!row) return null;

  const key = encryptionKey();
  const iv = Buffer.from(row.iv_b64, 'base64');
  const ciphertext = Buffer.from(row.ciphertext_b64, 'base64');
  const tag = Buffer.from(row.tag_b64, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return decrypted;
}

export function sandboxesUserApiKeyStatus(userId: number): { configured: boolean; masked: string | null } {
  const key = getSandboxesUserApiKey(userId);
  if (!key) return { configured: false, masked: null };
  const suffix = key.length >= 4 ? key.slice(-4) : key;
  return { configured: true, masked: `••••${suffix}` };
}
