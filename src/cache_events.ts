export type CacheEventType = 'gist:mutated' | 'repo:mutated' | 'all:cleared';

export interface CacheEvent {
  type: CacheEventType;
  gistId?: string;
  installationId?: string;
  repoFullName?: string;
}

type CacheEventListener = (event: CacheEvent) => void;

const listeners = new Set<CacheEventListener>();

export function onCacheEvent(listener: CacheEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitCacheEvent(event: CacheEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
