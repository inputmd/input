import { getSubdomainOwner } from './subdomain';

export type Route =
  | { name: 'home'; params: Record<string, never> }
  | { name: 'workspaces'; params: Record<string, never> }
  | { name: 'publicrepodocuments'; params: { owner: string; repo: string } }
  | { name: 'publicrepofile'; params: { owner: string; repo: string; path: string } }
  | { name: 'repodocuments'; params: Record<string, never> }
  | { name: 'repofile'; params: { path: string } }
  | { name: 'reponew'; params: Record<string, never> }
  | { name: 'repoedit'; params: { path: string } }
  | { name: 'sharefile'; params: { token: string } }
  | { name: 'new'; params: Record<string, never> }
  | { name: 'edit'; params: { id: string; filename?: string } }
  | { name: 'gist'; params: { id: string; filename?: string } };

export type RouteName = Route['name'];

interface RouteDef {
  pattern: RegExp;
  build: (match: RegExpMatchArray) => Route;
}

const GIST_ID_PATTERN = '[a-f0-9]{8,}';

const ROUTE_TABLE: RouteDef[] = [
  { pattern: /^workspaces$/, build: () => ({ name: 'workspaces', params: {} }) },
  {
    pattern: /^repo\/load\/([^/]+)\/([^/]+)$/,
    build: (m) => ({ name: 'publicrepodocuments', params: { owner: m[1], repo: m[2] } }),
  },
  { pattern: /^repo\/load$/, build: () => ({ name: 'repodocuments', params: {} }) },
  { pattern: /^repo\/file\/(.+)$/, build: (m) => ({ name: 'repofile', params: { path: m[1] } }) },
  { pattern: /^repo\/new$/, build: () => ({ name: 'reponew', params: {} }) },
  { pattern: /^repo\/edit\/(.+)$/, build: (m) => ({ name: 'repoedit', params: { path: m[1] } }) },
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
    pattern: /^([^/]+)\/([^/]+)\/blob\/[^/]+\/(.+)$/,
    build: (m) => ({ name: 'publicrepofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/raw\/[^/]+\/(.+)$/,
    build: (m) => ({ name: 'publicrepofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/tree\/[^/]+$/,
    build: (m) => ({ name: 'publicrepodocuments', params: { owner: m[1], repo: m[2] } }),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+)$/,
    build: (m) => ({ name: 'publicrepofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
  {
    pattern: /^([^/]+)\/([^/]+)$/,
    build: (m) => ({ name: 'publicrepodocuments', params: { owner: m[1], repo: m[2] } }),
  },
  {
    pattern: /^([^/]+)\/([^/]+)\/(.+)$/,
    build: (m) => ({ name: 'publicrepofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
];

export const routePath = {
  home: () => '',
  workspaces: () => 'workspaces',
  publicRepoDocuments: (owner: string, repo: string) =>
    `repo/load/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  publicRepoFile: (owner: string, repo: string, path: string) =>
    getSubdomainOwner()
      ? encodeURIComponent(path)
      : `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(path)}`,
  repoDocuments: () => 'repo/load',
  repoFile: (path: string) => `repo/file/${encodeURIComponent(path)}`,
  repoNew: () => 'repo/new',
  repoEdit: (path: string) => `repo/edit/${encodeURIComponent(path)}`,
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
      return { name: 'publicrepodocuments', params: { owner, repo: 'homepage' } };
    }
    return { name: 'publicrepofile', params: { owner, repo: 'homepage', path } };
  }

  for (const { pattern, build } of ROUTE_TABLE) {
    const m = path.match(pattern);
    if (m) return build(m);
  }
  return { name: 'home', params: {} };
}
