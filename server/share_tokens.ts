import crypto from 'node:crypto';

interface RepoFileShareTokenPayload {
  v: 1;
  typ: 'repo_file';
  iat: number;
  exp: number;
  installationId: string;
  owner: string;
  repo: string;
  path: string;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function signSegment(secret: string, signingInput: string): string {
  return crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export interface CreateRepoFileShareTokenInput {
  installationId: string;
  owner: string;
  repo: string;
  path: string;
  nowMs: number;
  ttlSeconds: number;
}

export function createRepoFileShareToken(secret: string, input: CreateRepoFileShareTokenInput): string {
  const iat = Math.floor(input.nowMs / 1000);
  const payload: RepoFileShareTokenPayload = {
    v: 1,
    typ: 'repo_file',
    iat,
    exp: iat + input.ttlSeconds,
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    path: input.path,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(HEADER));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signSegment(secret, signingInput);
  return `${signingInput}.${signature}`;
}

export function verifyRepoFileShareToken(
  secret: string,
  token: string,
  nowMs: number,
): RepoFileShareTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return null;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = signSegment(secret, signingInput);
  if (!timingSafeEqualString(signature, expectedSignature)) return null;

  try {
    const decodedHeader = JSON.parse(base64UrlDecode(encodedHeader)) as { alg?: string; typ?: string } | null;
    if (!decodedHeader || decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT') return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<RepoFileShareTokenPayload> | null;
    if (!payload || payload.v !== 1 || payload.typ !== 'repo_file') return null;
    if (
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      typeof payload.installationId !== 'string' ||
      typeof payload.owner !== 'string' ||
      typeof payload.repo !== 'string' ||
      typeof payload.path !== 'string'
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(nowMs / 1000)) return null;
    return payload as RepoFileShareTokenPayload;
  } catch {
    return null;
  }
}
