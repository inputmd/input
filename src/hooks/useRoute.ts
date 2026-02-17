import { useState, useEffect, useCallback } from 'preact/hooks';

export function useRoute() {
  const [route, setRoute] = useState(window.location.hash.slice(1));

  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash.slice(1));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((r: string) => {
    window.location.hash = r;
  }, []);

  return { route, navigate };
}
