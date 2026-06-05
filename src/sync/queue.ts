import type { Logger } from '../logging'

export type Processor<T> = (item: T) => Promise<void>

/**
 * LRU tracker for bounded key eviction.
 */
class LruTracker {
  private readonly order = new Map<string, null>()

  constructor (private readonly capacity: number) {}

  touch (key: string): void {
    this.order.delete(key)
    this.order.set(key, null)
  }

  /** Returns the evicted key if capacity exceeded, otherwise null. */
  evictOldest (activeKeys: Set<string>): string | null {
    if (this.order.size <= this.capacity) return null
    const oldest = this.order.keys().next().value
    if (oldest === undefined) return null
    this.order.delete(oldest)
    activeKeys.delete(oldest)
    return oldest
  }
}

/**
 * EventQueue — keyed FIFO with per-key serialization and bounded LRU eviction.
 *
 * Key convention: `${workspaceUuid}/${bindingId}/${resourceKey}`
 * where resourceKey = `${kind}:${id}` for resource events, or `*` for binding-level.
 *
 * - Same key → sequential processing.
 * - Different keys → concurrent processing.
 * - maxKeys keys tracked per instance (default 1000); oldest evicted on overflow.
 */
export class EventQueue<T> {
  private readonly queues = new Map<string, { items: T[], processing: boolean }>()
  private readonly activeKeys = new Set<string>()
  private readonly lru: LruTracker
  private readonly idleWaiters = new Map<string, Set<() => void>>()

  constructor (
    private readonly processor: Processor<T>,
    private readonly logger: Logger,
    maxKeys: number = 1000
  ) {
    this.lru = new LruTracker(maxKeys)
  }

  /** Enqueue item under key; kicks off processing if the key is idle. */
  enqueue (key: string, item: T): void {
    this.lru.touch(key)
    const evicted = this.lru.evictOldest(this.activeKeys)
    if (evicted !== null) {
      this.logger.warn('EventQueue: LRU evicted key', { evictedKey: evicted })
      this.queues.delete(evicted)
    }

    if (!this.queues.has(key)) {
      this.queues.set(key, { items: [], processing: false })
      this.activeKeys.add(key)
    }

    const entry = this.queues.get(key)
    if (entry === undefined) return
    entry.items.push(item)

    if (!entry.processing) {
      void this.runKey(key)
    }
  }

  /** Number of items waiting (not counting the in-flight item). */
  pendingCount (key: string): number {
    return this.queues.get(key)?.items.length ?? 0
  }

  /** True if no items pending or in-flight for key. */
  isIdle (key: string): boolean {
    const e = this.queues.get(key)
    return e === undefined || (!e.processing && e.items.length === 0)
  }

  /** Resolves when all currently-enqueued items across all keys have finished. */
  async drainAll (timeoutMs: number = 30000): Promise<void> {
    const keys = Array.from(this.queues.keys())
    const drain = Promise.all(keys.map(async (k) => { await this.waitForIdle(k) }))
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => { reject(new Error(`drainAll timed out after ${timeoutMs}ms`)) }, timeoutMs)
    )
    await Promise.race([drain, timeout])
  }

  /** Resolves when the given key is idle. */
  async waitForIdle (key: string): Promise<void> {
    if (this.isIdle(key)) return
    await new Promise<void>((resolve) => {
      let waiters = this.idleWaiters.get(key)
      if (waiters === undefined) {
        waiters = new Set()
        this.idleWaiters.set(key, waiters)
      }
      waiters.add(resolve)
    })
  }

  private async runKey (key: string): Promise<void> {
    const entry = this.queues.get(key)
    if (entry === undefined || entry.items.length === 0) {
      if (entry !== undefined) entry.processing = false
      return
    }

    entry.processing = true
    const item = entry.items.shift()
    if (item === undefined) {
      entry.processing = false
      return
    }

    try {
      await this.processor(item)
    } catch (err) {
      this.logger.error('EventQueue: processor threw', {
        key,
        err: err instanceof Error ? err.message : String(err)
      })
    }

    const next = this.queues.get(key)
    if (next !== undefined && next.items.length > 0) {
      void this.runKey(key)
    } else if (next !== undefined) {
      next.processing = false
      this.notifyIdleWaiters(key)
    }
  }

  private notifyIdleWaiters (key: string): void {
    const waiters = this.idleWaiters.get(key)
    if (waiters === undefined) return
    this.idleWaiters.delete(key)
    for (const resolve of waiters) {
      resolve()
    }
  }
}
