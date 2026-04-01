import {
  createRepoFileShareLinkRecord,
  getLatestActiveRepoFileShareLink,
  listActiveRepoFileShareLinks,
} from './session.ts';
import { createRepoFileShareToken } from './share_tokens.ts';

export interface RepoFileShareLinkResponse {
  token: string;
  url: string;
  createdAt: string;
  expiresAt: string;
}

function shareLinkResponse(record: {
  token: string;
  url: string;
  createdAtMs: number;
  expiresAtMs: number;
}): RepoFileShareLinkResponse {
  return {
    token: record.token,
    url: record.url,
    createdAt: new Date(record.createdAtMs).toISOString(),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
}

export interface CreateOrReuseRepoFileShareLinkInput {
  githubUserId: number;
  installationId: string;
  owner: string;
  repo: string;
  path: string;
  baseUrl: string;
  nowMs: number;
  ttlSeconds: number;
  secret: string;
}

export function createOrReuseRepoFileShareLink(input: CreateOrReuseRepoFileShareLinkInput): RepoFileShareLinkResponse {
  const existing = getLatestActiveRepoFileShareLink(
    input.githubUserId,
    input.installationId,
    input.owner,
    input.repo,
    input.path,
    input.nowMs,
  );
  if (existing) return shareLinkResponse(existing);

  const token = createRepoFileShareToken(input.secret, {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    nowMs: input.nowMs,
    ttlSeconds: input.ttlSeconds,
  });
  const expiresAtMs = input.nowMs + input.ttlSeconds * 1000;
  const sharePath = `s/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/${encodeURIComponent(input.path)}`;
  const record = createRepoFileShareLinkRecord(input.githubUserId, {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    token,
    url: `${input.baseUrl.replace(/\/+$/, '')}/${sharePath}?t=${encodeURIComponent(token)}`,
    createdAtMs: input.nowMs,
    expiresAtMs,
  });
  return shareLinkResponse(record);
}

export interface ListRepoFileShareLinksInput {
  githubUserId: number;
  installationId: string;
  owner: string;
  repo: string;
  path: string;
  nowMs?: number;
}

export function listRepoFileShareLinkResponses(input: ListRepoFileShareLinksInput): RepoFileShareLinkResponse[] {
  return listActiveRepoFileShareLinks(
    input.githubUserId,
    input.installationId,
    input.owner,
    input.repo,
    input.path,
    input.nowMs,
  ).map(shareLinkResponse);
}
