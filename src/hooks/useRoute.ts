import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getPathSegment, matchRoute, type Route } from '../routing';

interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

interface RouteTransition {
  nextRoute: Route;
  nextPath: string;
  replace: boolean;
}

type RouteTransitionGuard = (transition: RouteTransition) => boolean | Promise<boolean>;

function currentHistoryPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => matchRoute(getPathSegment()));
  const [routeState, setRouteState] = useState<unknown>(() => window.history.state);
  const navigationPromptRef = useRef<string | null>(null);
  const routeTransitionGuardRef = useRef<RouteTransitionGuard | null>(null);
  const acceptedHistoryPathRef = useRef(currentHistoryPath());
  const acceptedHistoryStateRef = useRef<unknown>(window.history.state);

  const setNavigationPrompt = useCallback((message: string | null) => {
    navigationPromptRef.current = message;
  }, []);

  const setRouteTransitionGuard = useCallback((guard: RouteTransitionGuard | null) => {
    routeTransitionGuardRef.current = guard;
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const nextPath = getPathSegment();
      const nextRoute = matchRoute(nextPath);
      void Promise.resolve(routeTransitionGuardRef.current?.({ nextRoute, nextPath, replace: true }) ?? true).then(
        (allowed) => {
          if (!allowed) {
            window.history.pushState(acceptedHistoryStateRef.current, '', acceptedHistoryPathRef.current);
            return;
          }
          acceptedHistoryPathRef.current = currentHistoryPath();
          acceptedHistoryStateRef.current = event.state;
          setRoute(nextRoute);
          setRouteState(event.state);
        },
      );
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

  const navigate = useCallback(async (r: string, options?: NavigateOptions): Promise<boolean> => {
    const path = `/${r}`;
    const nextRoute = matchRoute(r);
    const allowed = await Promise.resolve(
      routeTransitionGuardRef.current?.({ nextRoute, nextPath: r, replace: options?.replace === true }) ?? true,
    );
    if (!allowed) return false;
    const nextState = options && 'state' in options ? options.state : window.history.state;
    if (options?.replace) {
      window.history.replaceState(nextState, '', path);
    } else {
      window.history.pushState(nextState, '', path);
    }
    acceptedHistoryPathRef.current = currentHistoryPath();
    acceptedHistoryStateRef.current = nextState;
    setRoute(nextRoute);
    setRouteState(nextState);
    return true;
  }, []);

  return { route, routeState, navigate, setNavigationPrompt, setRouteTransitionGuard };
}
