export type RouteName =
  | 'home'
  | 'auth'
  | 'githubapp'
  | 'repodocuments'
  | 'repofile'
  | 'reponew'
  | 'repoedit'
  | 'documents'
  | 'new'
  | 'edit'
  | 'gist';

export interface Route {
  name: RouteName;
  params: Record<string, string>;
}

interface RouteDef {
  pattern: RegExp;
  name: Exclude<RouteName, 'home'>;
  paramNames?: string[];
}

const ROUTE_TABLE: RouteDef[] = [
  { pattern: /^auth$/, name: 'auth' },
  { pattern: /^githubapp$/, name: 'githubapp' },
  { pattern: /^repodocuments$/, name: 'repodocuments' },
  { pattern: /^repofile\/(.+)$/, name: 'repofile', paramNames: ['path'] },
  { pattern: /^reponew$/, name: 'reponew' },
  { pattern: /^repoedit\/(.+)$/, name: 'repoedit', paramNames: ['path'] },
  { pattern: /^documents$/, name: 'documents' },
  { pattern: /^new$/, name: 'new' },
  { pattern: /^edit\/([^/]+)\/(.+)$/, name: 'edit', paramNames: ['id', 'filename'] },
  { pattern: /^gist\/([^/]+)\/(.+)$/, name: 'gist', paramNames: ['id', 'filename'] },
  { pattern: /^edit\/([^/]+)$/, name: 'edit', paramNames: ['id'] },
  { pattern: /^gist\/([^/]+)$/, name: 'gist', paramNames: ['id'] },
  { pattern: /^([a-f0-9]+)$/i, name: 'gist', paramNames: ['id'] },
];

export const routePath = {
  home: () => '',
  auth: () => 'auth',
  githubApp: () => 'githubapp',
  repoDocuments: () => 'repodocuments',
  repoFile: (path: string) => `repofile/${encodeURIComponent(path)}`,
  repoNew: () => 'reponew',
  repoEdit: (path: string) => `repoedit/${encodeURIComponent(path)}`,
  documents: () => 'documents',
  freshDraft: () => 'new',
  gistEdit: (id: string, filename?: string) => filename ? `edit/${id}/${encodeURIComponent(filename)}` : `edit/${id}`,
  gistView: (id: string, filename?: string) => filename ? `gist/${id}/${encodeURIComponent(filename)}` : `gist/${id}`,
} as const;

export function getPathSegment(): string {
  return window.location.pathname.replace(/^\//, '');
}

export function matchRoute(path: string): Route {
  for (const { pattern, name, paramNames } of ROUTE_TABLE) {
    const m = path.match(pattern);
    if (m) {
      const params: Record<string, string> = {};
      paramNames?.forEach((key, i) => {
        params[key] = m[i + 1];
      });
      return { name, params };
    }
  }
  return { name: 'home', params: {} };
}
