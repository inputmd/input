import { getSubdomainOwner } from './subdomain';

export type Route =
  | { name: 'home'; params: Record<string, never> }
  | { name: 'workspaces'; params: Record<string, never> }
  | { name: 'repodocuments'; params: { owner: string; repo: string } }
  | { name: 'repofile'; params: { owner: string; repo: string; path: string } }
  | { name: 'reponew'; params: { owner: string; repo: string; path: string } }
  | { name: 'repoedit'; params: { owner: string; repo: string; path: string } }
  | { name: 'sharefile'; params: { token: string } }
  | { name: 'new'; params: Record<string, never> }
  | { name: 'edit'; params: { id: string; filename?: string } }
  | { name: 'gist'; params: { id: string; filename?: string } };

export type RouteName = Route['name'];

interface RouteDef {
  pattern: RegExp;
  build: (match: RegExpMatchArray) => Route;
  guard?: (match: RegExpMatchArray) => boolean;
}

const GIST_ID_PATTERN = '[a-f0-9]{8,}';
const RESERVED_ROOT_SEGMENTS = new Set(['api', 'edit', 'gist', 'input.md', 'repo', 's', 'sandboxes', 'workspaces']);

function isReservedRootSegment(value: string): boolean {
  return RESERVED_ROOT_SEGMENTS.has(value.toLowerCase());
}

const ROUTE_TABLE: RouteDef[] = [
  { pattern: /^workspaces$/, build: () => ({ name: 'workspaces', params: {} }) },
  {
    pattern: /^repo\/new\/([^/]+)\/([^/]+)\/(.+)$/,
    build: (m) => ({ name: 'reponew', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
  {
    pattern: /^repo\/edit\/([^/]+)\/([^/]+)\/(.+)$/,
    build: (m) => ({ name: 'repoedit', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+)$/,
    build: (m) => ({ name: 'repofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
    guard: (m) => !isReservedRootSegment(m[1]),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/raw\/[^/]+\/(.+)$/,
    build: (m) => ({ name: 'repofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
    guard: (m) => !isReservedRootSegment(m[1]),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/tree\/[^/]+$/,
    build: (m) => ({ name: 'repodocuments', params: { owner: m[1], repo: m[2] } }),
    guard: (m) => !isReservedRootSegment(m[1]),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+)$/,
    build: (m) => ({ name: 'repofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
    guard: (m) => !isReservedRootSegment(m[1]),
  },
  { pattern: /^s\/([^/]+)$/, build: (m) => ({ name: 'sharefile', params: { token: m[1] } }) },
  { pattern: /^gist\/new$/, build: () => ({ name: 'new', params: {} }) },
  {
    pattern: new RegExp(`^edit\\/(${GIST_ID_PATTERN})\\/(.+)$`, 'i'),
    build: (m) => ({ name: 'edit', params: { id: m[1], filename: m[2] } }),
  },
  {
    pattern: new RegExp(`^gist\\/(${GIST_ID_PATTERN})\\/(.+)$`, 'i'),
    build: (m) => ({ name: 'gist', params: { id: m[1], filename: m[2] } }),
  },
  { pattern: new RegExp(`^edit\\/(${GIST_ID_PATTERN})$`, 'i'), build: (m) => ({ name: 'edit', params: { id: m[1] } }) },
  { pattern: new RegExp(`^gist\\/(${GIST_ID_PATTERN})$`, 'i'), build: (m) => ({ name: 'gist', params: { id: m[1] } }) },
  { pattern: new RegExp(`^(${GIST_ID_PATTERN})$`, 'i'), build: (m) => ({ name: 'gist', params: { id: m[1] } }) },
  {
    pattern: /^([^/]+)\/([^/]+)$/,
    build: (m) => ({ name: 'repodocuments', params: { owner: m[1], repo: m[2] } }),
    guard: (m) => !isReservedRootSegment(m[1]),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/(.+)$/,
    build: (m) => ({ name: 'repofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
    guard: (m) => !isReservedRootSegment(m[1]),
  },
];

export const routePath = {
  home: () => '',
  workspaces: () => 'workspaces',
  publicRepoFile: (owner: string, repo: string, path: string) =>
    getSubdomainOwner()
      ? encodeURIComponent(path)
      : `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(path)}`,
  repoDocuments: (owner: string, repo: string) => `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  repoFile: (owner: string, repo: string, path: string) =>
    `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(path)}`,
  repoNew: (owner: string, repo: string, path = 'untitled.md') =>
    `repo/new/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(path)}`,
  repoEdit: (owner: string, repo: string, path: string) =>
    `repo/edit/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(path)}`,
  shareFile: (token: string) => `s/${encodeURIComponent(token)}`,
  freshDraft: () => 'gist/new',
  gistEdit: (id: string, filename?: string) => (filename ? `edit/${id}/${encodeURIComponent(filename)}` : `edit/${id}`),
  gistView: (id: string, filename?: string) => (filename ? `gist/${id}/${encodeURIComponent(filename)}` : `gist/${id}`),
} as const;

export function getPathSegment(): string {
  return window.location.pathname.replace(/^\//, '');
}

export function matchRoute(path: string): Route {
  const owner = getSubdomainOwner();
  if (owner) {
    if (!path || path === '/') {
      return { name: 'repodocuments', params: { owner, repo: 'homepage' } };
    }
    return { name: 'repofile', params: { owner, repo: 'homepage', path } };
  }

  for (const { pattern, build, guard } of ROUTE_TABLE) {
    const m = path.match(pattern);
    if (m && (!guard || guard(m))) return build(m);
  }
  return { name: 'home', params: {} };
}
