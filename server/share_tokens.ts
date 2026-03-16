import crypto from 'node:crypto';

interface RepoFileShareTokenPayloadV1 {
  v: 1;
  typ: 'repo_file';
  iat: number;
  exp: number;
  installationId: string;
  owner: string;
  repo: string;
  path: string;
}

interface RepoFileShareTokenPayloadV2 {
  v: 2;
  typ: 'repo_file_ref';
  iat: number;
  exp: number;
  installationId: string;
}

export interface VerifyRepoFileShareTokenContext {
  owner: string;
  repo: string;
  path: string;
}

export interface VerifiedRepoFileShareToken {
  installationId: string;
  owner: string;
  repo: string;
  path: string;
  exp: number;
}

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
  const payload: RepoFileShareTokenPayloadV2 = {
    v: 2,
    typ: 'repo_file_ref',
    iat,
    exp: iat + input.ttlSeconds,
    installationId: input.installationId,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedPayload}.${base64UrlEncode(input.owner)}.${base64UrlEncode(input.repo)}.${base64UrlEncode(input.path)}`;
  const signature = signSegment(secret, signingInput);
  return `${encodedPayload}.${signature}`;
}

export function verifyRepoFileShareToken(
  secret: string,
  token: string,
  nowMs: number,
  context?: VerifyRepoFileShareTokenContext,
): VerifiedRepoFileShareToken | null {
  const parts = token.split('.');
  if (parts.length === 2) {
    const [encodedPayload, signature] = parts;
    if (!encodedPayload || !signature || !context) return null;

    const signingInput = `${encodedPayload}.${base64UrlEncode(context.owner)}.${base64UrlEncode(context.repo)}.${base64UrlEncode(context.path)}`;
    const expectedSignature = signSegment(secret, signingInput);
    if (!timingSafeEqualString(signature, expectedSignature)) return null;

    try {
      const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<RepoFileShareTokenPayloadV2> | null;
      if (!payload || payload.v !== 2 || payload.typ !== 'repo_file_ref') return null;
      if (
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        typeof payload.installationId !== 'string'
      ) {
        return null;
      }
      if (payload.exp <= Math.floor(nowMs / 1000)) return null;
      return {
        installationId: payload.installationId,
        owner: context.owner,
        repo: context.repo,
        path: context.path,
        exp: payload.exp,
      };
    } catch {
      return null;
    }
  }

  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return null;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = signSegment(secret, signingInput);
  if (!timingSafeEqualString(signature, expectedSignature)) return null;

  try {
    const decodedHeader = JSON.parse(base64UrlDecode(encodedHeader)) as { alg?: string; typ?: string } | null;
    if (!decodedHeader || decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT') return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<RepoFileShareTokenPayloadV1> | null;
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
    return payload as VerifiedRepoFileShareToken;
  } catch {
    return null;
  }
}
