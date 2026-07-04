import type { CacheEntry } from './util';

interface SyncedCacheOptions<T> {
  storageKeyPrefix: string;
  channelName: string;
  messagePrefix: string;
  clone: (value: T) => T;
  validate?: (parsed: CacheEntry<T>) => boolean;
  ttlMs: number;
}

/**
 * Opaque token capturing a cache key's state at a point in time. Pass it to
 * `setIfCurrent` after an async fetch to avoid clobbering a fresher value that
 * a concurrent mutation (or another tab) wrote while the fetch was in flight.
 */
export interface CacheGeneration {
  key: number;
  epoch: number;
}

export class SyncedCache<T> {
  private memory = new Map<string, CacheEntry<T>>();
  private channel: BroadcastChannel | null = null;
  private readonly storageKeyPrefix: string;
  private readonly messagePrefix: string;
  private readonly cloneFn: (value: T) => T;
  private readonly validateFn: (parsed: CacheEntry<T>) => boolean;
  private ttlMs: number;
  // Per-key + global counters used to detect a mutation that landed while a
  // read-through fetch was in flight (see getGeneration / setIfCurrent).
  private keyGenerations = new Map<string, number>();
  private epoch = 0;

  constructor(options: SyncedCacheOptions<T>) {
    this.storageKeyPrefix = options.storageKeyPrefix;
    this.messagePrefix = options.messagePrefix;
    this.cloneFn = options.clone;
    this.validateFn = options.validate ?? (() => true);
    this.ttlMs = options.ttlMs;
    this.setupSync(options.channelName);
  }

  get(key: string): T | null {
    const cached = this.memory.get(key);
    if (cached) {
      if (Date.now() > cached.expiresAt) {
        this.memory.delete(key);
      } else {
        return this.cloneFn(cached.value);
      }
    }
    const stored = this.readStored(key);
    if (!stored) return null;
    this.memory.set(key, stored);
    return this.cloneFn(stored.value);
  }

  set(key: string, value: T): void {
    const entry: CacheEntry<T> = {
      value: this.cloneFn(value),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.memory.set(key, entry);
    this.bumpKeyGeneration(key);
    this.writeStored(key, entry);
    this.channel?.postMessage({ type: `${this.messagePrefix}-key-updated`, cacheKey: key });
  }

  /** Snapshot a key's generation before an async read-through fetch. */
  getGeneration(key: string): CacheGeneration {
    return { key: this.keyGenerations.get(key) ?? 0, epoch: this.epoch };
  }

  /**
   * Store a fetched value only if nothing mutated this key (or the whole cache)
   * since `token` was captured. Prevents an out-of-order fetch resolution from
   * clobbering a fresher value written by a concurrent mutation or another tab.
   */
  setIfCurrent(key: string, value: T, token: CacheGeneration): boolean {
    const current = this.getGeneration(key);
    if (current.key !== token.key || current.epoch !== token.epoch) return false;
    this.set(key, value);
    return true;
  }

  private bumpKeyGeneration(key: string): void {
    this.keyGenerations.set(key, (this.keyGenerations.get(key) ?? 0) + 1);
  }

  delete(key: string): void {
    this.memory.delete(key);
    this.bumpKeyGeneration(key);
    localStorage.removeItem(this.storageKey(key));
    this.channel?.postMessage({ type: `${this.messagePrefix}-key-cleared`, cacheKey: key });
  }

  clearAll(): void {
    this.memory.clear();
    this.epoch += 1;
    this.removeStoredByPrefix('');
    this.channel?.postMessage({ type: `${this.messagePrefix}-all-cleared` });
  }

  clearByPrefix(prefix: string): void {
    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix)) this.memory.delete(key);
    }
    // Bump the global epoch so an in-flight fetch for a not-yet-cached key under
    // this prefix is also invalidated (its per-key generation may be untracked).
    this.epoch += 1;
    this.removeStoredByPrefix(prefix);
    this.channel?.postMessage({ type: `${this.messagePrefix}-prefix-cleared`, cacheKeyPrefix: prefix });
  }

  setTtlMs(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('Cache TTL must be a non-negative number');
    }
    this.ttlMs = Math.floor(ttlMs);
  }

  private storageKey(cacheKey: string): string {
    return `${this.storageKeyPrefix}${cacheKey}`;
  }

  private readStored(cacheKey: string): CacheEntry<T> | null {
    const raw = localStorage.getItem(this.storageKey(cacheKey));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CacheEntry<T>;
      if (!Number.isFinite(parsed.expiresAt)) return null;
      if (!this.validateFn(parsed)) return null;
      if (Date.now() > parsed.expiresAt) {
        localStorage.removeItem(this.storageKey(cacheKey));
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private writeStored(cacheKey: string, entry: CacheEntry<T>): void {
    try {
      localStorage.setItem(this.storageKey(cacheKey), JSON.stringify(entry));
    } catch {
      // Ignore storage quota and serialization failures.
    }
  }

  private removeStoredByPrefix(cacheKeyPrefix: string): void {
    const fullPrefix = `${this.storageKeyPrefix}${cacheKeyPrefix}`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(fullPrefix)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) localStorage.removeItem(key);
  }

  private syncFromStorage(cacheKey: string): void {
    // Another tab changed this key; bump its generation so any in-flight local
    // fetch does not clobber the value we just synced in.
    this.bumpKeyGeneration(cacheKey);
    const stored = this.readStored(cacheKey);
    if (!stored) {
      this.memory.delete(cacheKey);
      return;
    }
    this.memory.set(cacheKey, stored);
  }

  private setupSync(channelName: string): void {
    window.addEventListener('storage', (event) => {
      if (!event.key || !event.key.startsWith(this.storageKeyPrefix)) return;
      const cacheKey = event.key.slice(this.storageKeyPrefix.length);
      if (!cacheKey) return;
      this.syncFromStorage(cacheKey);
    });

    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(channelName);
      this.channel.addEventListener('message', (event: MessageEvent<unknown>) => {
        const msg = event.data as { type?: string; cacheKey?: string; cacheKeyPrefix?: string } | null;
        if (!msg || !msg.type?.startsWith(this.messagePrefix)) return;
        if (msg.type === `${this.messagePrefix}-all-cleared`) {
          this.memory.clear();
          this.epoch += 1;
          return;
        }
        if (msg.type === `${this.messagePrefix}-key-updated` && msg.cacheKey) {
          this.syncFromStorage(msg.cacheKey);
          return;
        }
        if (msg.type === `${this.messagePrefix}-key-cleared` && msg.cacheKey) {
          this.memory.delete(msg.cacheKey);
          this.bumpKeyGeneration(msg.cacheKey);
          return;
        }
        if (msg.type === `${this.messagePrefix}-prefix-cleared` && msg.cacheKeyPrefix) {
          this.epoch += 1;
          for (const key of this.memory.keys()) {
            if (key.startsWith(msg.cacheKeyPrefix)) this.memory.delete(key);
          }
        }
      });
    }
  }
}
