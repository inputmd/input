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

export function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
