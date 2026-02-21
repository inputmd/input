import { useState, useEffect, useCallback } from 'preact/hooks';
import { getPathSegment, matchRoute, type Route } from '../routing';

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => matchRoute(getPathSegment()));

  useEffect(() => {
    const onPopState = () => setRoute(matchRoute(getPathSegment()));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((r: string, options?: { replace?: boolean }) => {
    const path = '/' + r;
    if (options?.replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    setRoute(matchRoute(r));
  }, []);

  return { route, navigate };
}
