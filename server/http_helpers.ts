import { ClientError } from './errors';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

export function requireString(body: Record<string, unknown> | null, key: string): string {
  const value = body?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new ClientError(`${key} is required`);
  return value;
}

export function base64url(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
