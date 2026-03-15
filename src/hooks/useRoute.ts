import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getPathSegment, matchRoute, type Route } from '../routing';

interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => matchRoute(getPathSegment()));
  const [routeState, setRouteState] = useState<unknown>(() => window.history.state);
  const navigationPromptRef = useRef<string | null>(null);

  const setNavigationPrompt = useCallback((message: string | null) => {
    navigationPromptRef.current = message;
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const nextPath = getPathSegment();
      setRoute(matchRoute(nextPath));
      setRouteState(event.state);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!navigationPromptRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
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
    return true;
  }, []);

  return { route, routeState, navigate, setNavigationPrompt };
}
