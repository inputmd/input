import { useState, useEffect, useCallback } from 'preact/hooks';

export interface Route {
  name: string;
  params: Record<string, string>;
}

interface RouteDef {
  pattern: RegExp;
  name: string;
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
  { pattern: /^edit\/(.+)$/, name: 'edit', paramNames: ['id'] },
  { pattern: /^gist\/(.+)$/, name: 'gist', paramNames: ['id'] },
  { pattern: /^([a-f0-9]+)$/i, name: 'gist', paramNames: ['id'] },
];

function matchRoute(hash: string): Route {
  for (const { pattern, name, paramNames } of ROUTE_TABLE) {
    const m = hash.match(pattern);
    if (m) {
      const params: Record<string, string> = {};
      paramNames?.forEach((key, i) => { params[key] = m[i + 1]; });
      return { name, params };
    }
  }
  return { name: 'home', params: {} };
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => matchRoute(window.location.hash.slice(1)));

  useEffect(() => {
    const onHashChange = () => setRoute(matchRoute(window.location.hash.slice(1)));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((r: string) => {
    window.location.hash = r;
  }, []);

  return { route, navigate };
}
