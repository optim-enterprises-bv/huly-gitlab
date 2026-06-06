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

  invalidate (key?: K): void {
    if (key === undefined) {
      this.cache.clear()
      this.primed = false
    } else {
      this.cache.delete(key)
    }
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
