export type Route =
  | { name: 'home'; params: Record<string, never> }
  | { name: 'login'; params: Record<string, never> }
  | { name: 'workspaces'; params: Record<string, never> }
  | { name: 'publicrepodocuments'; params: { owner: string; repo: string } }
  | { name: 'publicrepofile'; params: { owner: string; repo: string; path: string } }
  | { name: 'publicrepofilelegacy'; params: { owner: string; repo: string; path: string } }
  | { name: 'repodocuments'; params: Record<string, never> }
  | { name: 'repofile'; params: { path: string } }
  | { name: 'reponew'; params: Record<string, never> }
  | { name: 'repoedit'; params: { path: string } }
  | { name: 'new'; params: Record<string, never> }
  | { name: 'edit'; params: { id: string; filename?: string } }
  | { name: 'gist'; params: { id: string; filename?: string } };

export type RouteName = Route['name'];

interface RouteDef {
  pattern: RegExp;
  build: (match: RegExpMatchArray) => Route;
}

const ROUTE_TABLE: RouteDef[] = [
  { pattern: /^login$/, build: () => ({ name: 'login', params: {} }) },
  { pattern: /^workspaces$/, build: () => ({ name: 'workspaces', params: {} }) },
  {
    pattern: /^publicrepo\/([^/]+)\/([^/]+)$/,
    build: (m) => ({ name: 'publicrepodocuments', params: { owner: m[1], repo: m[2] } }),
  },
  {
    pattern: /^public\/([^/]+)\/([^/]+)\/(.+)$/,
    build: (m) => ({ name: 'publicrepofile', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
  {
    pattern: /^publicfile\/([^/]+)\/([^/]+)\/(.+)$/,
    build: (m) => ({ name: 'publicrepofilelegacy', params: { owner: m[1], repo: m[2], path: m[3] } }),
  },
  { pattern: /^repodocuments$/, build: () => ({ name: 'repodocuments', params: {} }) },
  { pattern: /^repofile\/(.+)$/, build: (m) => ({ name: 'repofile', params: { path: m[1] } }) },
  { pattern: /^reponew$/, build: () => ({ name: 'reponew', params: {} }) },
  { pattern: /^repoedit\/(.+)$/, build: (m) => ({ name: 'repoedit', params: { path: m[1] } }) },
  { pattern: /^new$/, build: () => ({ name: 'new', params: {} }) },
  { pattern: /^edit\/([^/]+)\/(.+)$/, build: (m) => ({ name: 'edit', params: { id: m[1], filename: m[2] } }) },
  { pattern: /^gist\/([^/]+)\/(.+)$/, build: (m) => ({ name: 'gist', params: { id: m[1], filename: m[2] } }) },
  { pattern: /^edit\/([^/]+)$/, build: (m) => ({ name: 'edit', params: { id: m[1] } }) },
  { pattern: /^gist\/([^/]+)$/, build: (m) => ({ name: 'gist', params: { id: m[1] } }) },
  { pattern: /^([a-f0-9]+)$/i, build: (m) => ({ name: 'gist', params: { id: m[1] } }) },
];

export const routePath = {
  home: () => '',
  login: () => 'login',
  workspaces: () => 'workspaces',
  publicRepoDocuments: (owner: string, repo: string) => `publicrepo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  publicRepoFile: (owner: string, repo: string, path: string) =>
    `public/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(path)}`,
  repoDocuments: () => 'repodocuments',
  repoFile: (path: string) => `repofile/${encodeURIComponent(path)}`,
  repoNew: () => 'reponew',
  repoEdit: (path: string) => `repoedit/${encodeURIComponent(path)}`,
  freshDraft: () => 'new',
  gistEdit: (id: string, filename?: string) => (filename ? `edit/${id}/${encodeURIComponent(filename)}` : `edit/${id}`),
  gistView: (id: string, filename?: string) => (filename ? `gist/${id}/${encodeURIComponent(filename)}` : `gist/${id}`),
} as const;

export function getPathSegment(): string {
  return window.location.pathname.replace(/^\//, '');
}

export function matchRoute(path: string): Route {
  for (const { pattern, build } of ROUTE_TABLE) {
    const m = path.match(pattern);
    if (m) return build(m);
  }
  return { name: 'home', params: {} };
}
