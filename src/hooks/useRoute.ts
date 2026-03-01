import { useCallback, useEffect, useState } from 'preact/hooks';
import { getPathSegment, matchRoute, type Route } from '../routing';

interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => matchRoute(getPathSegment()));
  const [routeState, setRouteState] = useState<unknown>(() => window.history.state);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      setRoute(matchRoute(getPathSegment()));
      setRouteState(event.state);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((r: string, options?: NavigateOptions) => {
    const path = `/${r}`;
    const nextState = options && 'state' in options ? options.state : window.history.state;
    if (options?.replace) {
      window.history.replaceState(nextState, '', path);
    } else {
      window.history.pushState(nextState, '', path);
    }
    setRoute(matchRoute(r));
    setRouteState(nextState);
  }, []);

  return { route, routeState, navigate };
}
