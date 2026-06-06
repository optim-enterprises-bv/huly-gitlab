export interface BiDirectionalCachePrimer<K, V> {
  loadAll: () => Promise<Iterable<{ key: K, value: V }>>
}

export class BiDirectionalCache<K, V> {
  private readonly cache = new Map<K, V>()
  private primed = false
  private readonly maxEntries: number

  constructor (
    private readonly primer: BiDirectionalCachePrimer<K, V>,
    maxEntries: number = 1000
  ) {
    this.maxEntries = maxEntries
  }

  async get (key: K): Promise<V | undefined> {
    if (!this.primed) await this.prime()
    return this.cache.get(key)
  }

  put (key: K, value: V): void {
    this.cache.set(key, value)
    this.evictIfOverflowing()
  }

  /**
   * Invalidates cache entries.
   * When called with undefined key: clears all entries and resets primed=false,
   * so next get() will re-prime by calling primer.loadAll().
   * When called with a specific key: removes only that entry but leaves primed=true,
   * so cache stays partially populated; subsequent get(key) returns undefined unless
   * reload(key, fetcher) is called.
   */
  invalidate (key?: K): void {
    if (key === undefined) {
      this.cache.clear()
      this.primed = false
    } else {
      this.cache.delete(key)
    }
  }

  /**
   * Re-fetches a single key by calling the provided fetcher and re-inserting
   * the matching entry back into the cache.
   * Useful after invalidate(key) to refresh just that one key without full re-prime.
   */
  async reload (key: K, fetcher: () => Promise<V | undefined>): Promise<V | undefined> {
    const value = await fetcher()
    if (value !== undefined) {
      this.put(key, value)
    }
    return value
  }

  primeSync (entries: Iterable<{ key: K, value: V }>): void {
    for (const { key, value } of entries) this.cache.set(key, value)
    this.primed = true
  }

  size (): number { return this.cache.size }

  private async prime (): Promise<void> {
    const entries = await this.primer.loadAll()
    for (const { key, value } of entries) this.cache.set(key, value)
    this.primed = true
  }

  private evictIfOverflowing (): void {
    while (this.cache.size > this.maxEntries) {
      const firstKey = this.cache.keys().next().value
      if (firstKey === undefined) break
      this.cache.delete(firstKey)
    }
  }
}
