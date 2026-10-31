import { HandleCacheEntry, IdentityCacheEntry } from './types.js';
import { Effect } from 'effect';

// Simple in-memory cache for identity resolution
export class IdentityCache {
  private readonly didCache = new Map<string, IdentityCacheEntry>();
  private readonly handleCache = new Map<string, HandleCacheEntry>();

  // Get cached DID resolution
  getDID(did: string): IdentityCacheEntry | undefined {
    const entry = this.didCache.get(did);
    if (!entry) return undefined;

    // Check if entry is expired
    if (Date.now() > entry.timestamp + entry.ttl) {
      this.didCache.delete(did);
      return undefined;
    }

    return entry;
  }

  // Set cached DID resolution
  setDID(did: string, entry: IdentityCacheEntry): void {
    this.didCache.set(did, entry);
  }

  // Get cached handle resolution
  getHandle(handle: string): HandleCacheEntry | undefined {
    const entry = this.handleCache.get(handle);
    if (!entry) return undefined;

    // Check if entry is expired
    if (Date.now() > entry.timestamp + entry.ttl) {
      this.handleCache.delete(handle);
      return undefined;
    }

    return entry;
  }

  // Set cached handle resolution
  setHandle(handle: string, entry: HandleCacheEntry): void {
    this.handleCache.set(handle, entry);
  }

  // Clear all cache entries
  clear(): void {
    this.didCache.clear();
    this.handleCache.clear();
  }
}

// Global cache instance
export const globalCache = new IdentityCache();

// Cache-enabled resolver wrapper
export const withCache = <
  T extends (...args: any[]) => Effect.Effect<any, any>,
>(
  resolver: T,
  _ttlMs: number = 5 * 60 * 1000, // 5 minutes default
) => {
  return ((...args: Parameters<T>) => {
    // For now, just call the resolver - caching would be implemented here
    return resolver(...args);
  }) as T;
};
